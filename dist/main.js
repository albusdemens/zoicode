var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
function parseDotEnvLine(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) return void 0;
  const raw = m[2].trim();
  const quoted = raw.match(/^(['"])(.*?)\1\s*(?:#.*)?$/);
  return [m[1], quoted ? quoted[2] : raw.replace(/\s+#.*$/, "")];
}
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const entry = parseDotEnvLine(line);
    if (!entry || !entry[1] || nonEmpty(process.env[entry[0]])) continue;
    process.env[entry[0]] = entry[1];
    loadedFrom.set(entry[0], file);
  }
}
function envSource(name) {
  return loadedFrom.get(name) ?? (nonEmpty(process.env[name]) ? "environment" : void 0);
}
function parseContextWindow(raw) {
  const value = raw?.trim();
  if (!value) return DEFAULT_CONTEXT_WINDOW;
  const m = value.match(/^(\d+)(k?)$/i);
  const tokens = m ? Number(m[1]) * (m[2] ? 1024 : 1) : NaN;
  if (!Number.isSafeInteger(tokens) || tokens < 1024) {
    throw new Error(`RAON_CONTEXT_WINDOW must be a token count such as 131072 or 128k, got ${JSON.stringify(raw)}`);
  }
  return tokens;
}
function loadConfig(overrides = {}) {
  const apiKey = nonEmpty(overrides.apiKey) ?? nonEmpty(process.env.RAON_API_KEY);
  if (!apiKey) {
    throw new Error("RAON_API_KEY is not set. Run `zoicode --setup`, or export RAON_API_KEY.");
  }
  const baseURL = nonEmpty(overrides.baseURL) ?? nonEmpty(process.env.RAON_BASE_URL) ?? "https://raon-api.krafton.ai/v1";
  const protocol = URL.parse(baseURL)?.protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`RAON_BASE_URL must be an http(s) URL, got ${JSON.stringify(baseURL)}`);
  }
  return {
    apiKey,
    baseURL,
    model: nonEmpty(overrides.model) ?? nonEmpty(process.env.RAON_MODEL) ?? "raon-1-mini-preview",
    contextWindow: overrides.contextWindow ?? parseContextWindow(process.env.RAON_CONTEXT_WINDOW)
  };
}
var nonEmpty, loadedFrom, here, CONFIG_DIR, VERSION, DEFAULT_CONTEXT_WINDOW;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    nonEmpty = (v) => v?.trim() || void 0;
    loadedFrom = /* @__PURE__ */ new Map();
    here = path.dirname(fileURLToPath(import.meta.url));
    loadDotEnv(path.resolve(here, "..", ".env"));
    loadDotEnv(path.join(os.homedir(), ".zoicode", ".env"));
    CONFIG_DIR = path.join(os.homedir(), ".zoicode");
    VERSION = "0.1.0";
    DEFAULT_CONTEXT_WINDOW = 262144;
  }
});

// src/llm.ts
import OpenAI from "openai";
var MAX_TOOL_CALLS, MAX_ARGUMENT_CHARS, LLM;
var init_llm = __esm({
  "src/llm.ts"() {
    "use strict";
    MAX_TOOL_CALLS = 128;
    MAX_ARGUMENT_CHARS = 2e7;
    LLM = class {
      constructor(config) {
        this.config = config;
        const customHeaders = process.env.OPENAI_CUSTOM_HEADERS;
        delete process.env.OPENAI_CUSTOM_HEADERS;
        try {
          this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            maxRetries: 3,
            organization: null,
            project: null,
            adminAPIKey: null
          });
        } finally {
          if (customHeaders !== void 0) process.env.OPENAI_CUSTOM_HEADERS = customHeaders;
        }
      }
      config;
      client;
      async listModels() {
        const res = await this.client.models.list();
        return res.data.map((m) => m.id);
      }
      /** Streams one completion, yielding deltas and finally the assembled message. */
      async *stream(messages, tools, signal) {
        const stream = await this.client.chat.completions.create(
          {
            model: this.config.model,
            messages,
            tools: tools.length ? tools : void 0,
            stream: true,
            stream_options: { include_usage: true }
          },
          { signal }
        );
        let text = "";
        let reasoning = "";
        let finishReason = "";
        let usage;
        const calls = [];
        for await (const chunk of stream) {
          if (chunk.usage) {
            usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          const r = delta.reasoning ?? delta.reasoning_content;
          if (r) {
            reasoning += r;
            yield { type: "reasoning", delta: r };
          }
          if (delta.content) {
            text += delta.content;
            yield { type: "text", delta: delta.content };
          }
          for (const tc of delta.tool_calls ?? []) {
            const i = tc.index;
            if (!Number.isInteger(i) || i < 0 || i >= MAX_TOOL_CALLS) continue;
            let call = calls[i];
            if (!call) {
              call = calls[i] = { id: typeof tc.id === "string" ? tc.id : `call_${i}`, name: "", arguments: "" };
            }
            if (typeof tc.id === "string" && tc.id) call.id = tc.id.slice(0, 200);
            if (typeof tc.function?.name === "string") call.name = (call.name + tc.function.name).slice(0, 200);
            if (typeof tc.function?.arguments === "string" && call.arguments.length < MAX_ARGUMENT_CHARS) call.arguments += tc.function.arguments;
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        signal?.throwIfAborted();
        yield { type: "done", text, reasoning, toolCalls: calls.filter(Boolean), usage, finishReason };
      }
    };
  }
});

// src/tools/git.ts
import { execFileSync } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";
function findGitDir(dir) {
  for (let d = path2.resolve(dir); ; d = path2.dirname(d)) {
    const candidate = path2.join(d, ".git");
    if (fs2.existsSync(candidate)) return candidate;
    if (path2.dirname(d) === d) return void 0;
  }
}
function riskyGitConfig(cwd) {
  let out;
  try {
    out = execFileSync("git", ["config", "--list", "--show-scope", "-z"], {
      cwd,
      env: { ...process.env, ...QUIET_GIT_ENV },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).toString();
  } catch {
    return void 0;
  }
  const fields = out.split("\0");
  const risky = /* @__PURE__ */ new Set();
  if (hasSubmodules(cwd)) risky.add("submodules");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, key] = [fields[i], fields[i + 1].split("\n")[0].toLowerCase()];
    if ((scope === "local" || scope === "worktree") && !PLAIN_KEYS.some((p) => p.test(key))) risky.add(key);
  }
  return [...risky];
}
function realGitDir(gitDir) {
  if (!fs2.statSync(gitDir).isFile()) return gitDir;
  const target = /^gitdir: (.+)$/m.exec(fs2.readFileSync(gitDir, "utf8"))?.[1].trim();
  if (!target) throw new Error(`${gitDir} names no git folder`);
  return path2.resolve(path2.dirname(gitDir), target);
}
function hasSubmodules(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return false;
  if (fs2.existsSync(path2.join(path2.dirname(gitDir), ".gitmodules"))) return true;
  try {
    return fs2.existsSync(path2.join(realGitDir(gitDir), "modules"));
  } catch {
    return true;
  }
}
function gitHooks(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return [];
  try {
    let dir = realGitDir(gitDir);
    const common = path2.join(dir, "commondir");
    if (fs2.existsSync(common)) dir = path2.resolve(dir, fs2.readFileSync(common, "utf8").trim());
    const hooks = path2.join(dir, "hooks");
    return fs2.readdirSync(hooks).filter((f) => {
      if (f.endsWith(".sample")) return false;
      try {
        fs2.accessSync(path2.join(hooks, f), fs2.constants.X_OK);
        return fs2.statSync(path2.join(hooks, f)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
function currentBranch(gitDir) {
  try {
    const dir = realGitDir(gitDir);
    const head = fs2.readFileSync(path2.join(dir, "HEAD"), "utf8").trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : /^[0-9a-f]{7,}$/.test(head) ? `(detached at ${head.slice(0, 7)})` : void 0;
  } catch {
    return void 0;
  }
}
var PLAIN_KEYS, QUIET_GIT_ENV;
var init_git = __esm({
  "src/tools/git.ts"() {
    "use strict";
    PLAIN_KEYS = [
      /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|sparsecheckout|sparsecheckoutcone|untrackedcache|splitindex|commitgraph|multipackindex|checkstat|trustctime|quotepath|abbrev|compression|loosecompression|fscache|longpaths)$/,
      /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|promisor|partialclonefilter|skipdefaultupdate|skipfetchall)$/,
      /^branch\..+\.(remote|pushremote|merge|rebase|description)$/,
      /^submodule\..+\.(url|active|branch|shallow)$/,
      /^user\.(name|email|signingkey|useconfigonly)$/,
      /^(pull\.(rebase|ff)|push\.(default|autosetupremote|followtags)|fetch\.(prune|prunetags)|init\.defaultbranch|merge\.(ff|conflictstyle))$/,
      /^(rebase\.(autosquash|autostash|updaterefs)|rerere\.(enabled|autoupdate)|gc\.(auto|autodetach)|index\.(version|threads|skiphash))$/,
      /^(feature\.manyfiles|maintenance\.(auto|strategy)|commit\.gpgsign|tag\.gpgsign|color\..+|column\..+|alias\..+)$/,
      /^status\.(short|branch|showuntrackedfiles|relativepaths|aheadbehind)$/,
      /^extensions\.(objectformat|worktreeconfig|partialclone|refstorage|preciousobjects)$/
    ];
    QUIET_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0" };
  }
});

// src/prompt.ts
import fs3 from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { execFileSync as execFileSync2 } from "node:child_process";
function loadMemory(cwd) {
  const found = [];
  const add = (p) => {
    let fd;
    try {
      if (!fs3.statSync(p).isFile()) return;
      fd = fs3.openSync(p, "r");
      const buf = Buffer.alloc(MAX_MEMORY_BYTES + 1);
      const n = fs3.readSync(fd, buf, 0, buf.length, 0);
      const content = buf.subarray(0, Math.min(n, MAX_MEMORY_BYTES)).toString("utf8");
      found.push({ path: p, content: n > MAX_MEMORY_BYTES ? `${content}

(cut: only the first 256 KB of this file is loaded)` : content });
    } catch {
    } finally {
      if (fd !== void 0) fs3.closeSync(fd);
    }
  };
  add(path3.join(CONFIG_DIR, "ZOICODE.md"));
  const dirs = [];
  for (let d = path3.resolve(cwd); ; d = path3.dirname(d)) {
    dirs.unshift(d);
    if (path3.dirname(d) === d) break;
  }
  for (const d of dirs) for (const name of MEMORY_FILES) add(path3.join(d, name));
  return found;
}
function gitInfo(cwd) {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return "Not a git repository";
  const branch = currentBranch(gitDir) ?? "(unknown)";
  const risky = riskyGitConfig(cwd)?.filter((k) => k !== "submodules");
  if (!risky || risky.length) {
    const why = risky ? `its own git config sets ${risky.slice(0, 5).map((k) => k.slice(0, 60)).join(", ")}` : "git could not read its config";
    return `Git branch: ${branch}
Git status: not checked, because ${why}, which can make git run other programs. Git commands here need the user's approval.`;
  }
  try {
    const status = execFileSync2("git", ["status", "--short", "--ignore-submodules=all"], {
      cwd,
      env: { ...process.env, ...QUIET_GIT_ENV },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).toString().trimEnd();
    const lines = status.split("\n");
    const shown = lines.slice(0, 20).join("\n") + (lines.length > 20 ? `
\u2026 ${lines.length - 20} more` : "");
    return `Git branch: ${branch}
Git status:
${status ? shown : "(clean)"}`;
  } catch {
    return `Git branch: ${branch}`;
  }
}
function buildSystemPrompt(cwd, memory) {
  const memorySection = memory.length ? "\n# Project memory\nThese instruction files were provided by the user. Follow them.\n\n" + memory.map((m) => `<file path="${m.path}">
${m.content.trim()}
</file>`).join("\n\n") : "";
  return `You are Zoi Code, an interactive CLI coding agent. You help the user with software engineering tasks in their project: fixing bugs, adding features, refactoring, explaining code, running commands.

# How to work
- Be concise and direct. Your output is shown in a terminal and rendered as Markdown. Skip preambles and summaries the user did not ask for.
- Use tools to look before you act: explore with Glob, Grep, LS and Read; never guess file contents.
- Always Read a file before you Edit or overwrite it. Edit needs old_string to match the file exactly, without the line-number prefix that Read shows.
- Prefer Edit over Write for existing files. Do not create files unless needed.
- Match the existing code style, naming and libraries of the project.
- For tasks with 3 or more steps, keep a TodoWrite list and update it as you go.
- After making changes, verify them: run the build, tests or the program with Bash when possible.
- If a tool call is denied by the user, do not retry it; ask what to do instead.
- Never run destructive commands (rm -rf, git reset --hard, force push) unless the user explicitly asked.
- When referencing code, use the form path/to/file.ts:42.
- Make several independent tool calls in one turn when you can.

# Environment
Working directory: ${cwd}
Platform: ${os2.platform()} ${os2.release()}
Shell: bash
Date: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}
${gitInfo(cwd)}
${memorySection}`;
}
var MEMORY_FILES, MAX_MEMORY_BYTES;
var init_prompt = __esm({
  "src/prompt.ts"() {
    "use strict";
    init_config();
    init_git();
    MEMORY_FILES = ["ZOICODE.md", "CLAUDE.md"];
    MAX_MEMORY_BYTES = 256 * 1024;
  }
});

// src/tools/types.ts
import fs4 from "node:fs";
import os3 from "node:os";
import path4 from "node:path";
function resolvePath(ctx, p) {
  if (!p) return ctx.cwd;
  if (p === "~" || p.startsWith("~/")) p = path4.join(os3.homedir(), p.slice(1));
  return path4.resolve(ctx.cwd, p);
}
function displayPath(ctx, abs) {
  const rel = path4.relative(ctx.cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}
function realTarget(abs) {
  abs = path4.resolve(abs);
  const parts = abs.split(path4.sep).filter(Boolean);
  let real = path4.parse(abs).root;
  for (let links = 0; parts.length; ) {
    const next = path4.join(real, parts.shift());
    let link;
    try {
      link = fs4.readlinkSync(next);
    } catch {
      real = next;
      continue;
    }
    if (++links > 40) return next;
    parts.unshift(...link.split(path4.sep).filter(Boolean));
    if (path4.isAbsolute(link)) real = path4.parse(link).root;
  }
  return real;
}
function isInsideDir(dir, abs) {
  const rel = path4.relative(realTarget(dir), realTarget(abs));
  return rel === "" || rel !== ".." && !rel.startsWith(".." + path4.sep) && !path4.isAbsolute(rel);
}
function truncate(s, max = 3e4) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}

... [${s.length - max} characters truncated] ...

${s.slice(-half)}`;
}
var init_types = __esm({
  "src/tools/types.ts"() {
    "use strict";
  }
});

// src/tools/secrets.ts
import os4 from "node:os";
import path5 from "node:path";
function secretPaths() {
  const home = os4.homedir();
  return SECRET_PATHS.map((p) => realTarget(path5.join(home, p)));
}
function within(dir, p) {
  const rel = path5.relative(dir, p);
  return rel === "" || rel !== ".." && !rel.startsWith(".." + path5.sep) && !path5.isAbsolute(rel);
}
function inSecrets(abs) {
  const target = realTarget(abs);
  return secretPaths().some((secret) => within(secret, target));
}
function containsSecrets(abs) {
  const target = realTarget(abs);
  return secretPaths().some((secret) => within(target, secret) && secret !== target);
}
function secretMatcher() {
  const secrets = secretPaths();
  return (abs) => secrets.some((secret) => within(secret, abs));
}
function fixedPrefix(pattern) {
  const parts = pattern.split("/");
  const i = parts.findIndex((p) => /[*?[{]/.test(p));
  return i === -1 ? pattern : parts.slice(0, i).join("/") || (pattern.startsWith("/") ? "/" : ".");
}
var SECRET_PATHS;
var init_secrets = __esm({
  "src/tools/secrets.ts"() {
    "use strict";
    init_types();
    SECRET_PATHS = [
      ".zoicode",
      ".ssh",
      ".aws",
      ".azure",
      ".gnupg",
      ".password-store",
      ".kube",
      ".docker/config.json",
      ".config/gh",
      ".config/gcloud",
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".git-credentials",
      ".cargo/credentials",
      ".cargo/credentials.toml",
      ".gem/credentials"
    ];
  }
});

// src/tools/bash.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs5 from "node:fs";
import os5 from "node:os";
import path6 from "node:path";
function splitCommand(command) {
  const commands = [];
  let words = [];
  let word;
  let globbed = false;
  const endWord = () => {
    if (word !== void 0) words.push(word);
    word = void 0;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, globbed });
    words = [];
    globbed = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === " " || c === "	") endWord();
    else if (c === "&" && command[i + 1] !== "&") return null;
    else if ("\n;&|".includes(c)) {
      endCommand();
      if (c === "&") i++;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      const quoted = command.slice(i + 1, end);
      if (c === '"' && /[`\\]|\$./s.test(quoted)) return null;
      word = (word ?? "") + quoted;
      i = end;
    } else if ("$`\\<>(){}#!".includes(c)) return null;
    else {
      if ("*?[".includes(c)) globbed = true;
      word = (word ?? "") + c;
    }
  }
  endCommand();
  return commands;
}
function isSafeCommand(command) {
  const commands = typeof command === "string" ? splitCommand(command) : null;
  if (!commands?.length) return false;
  return commands.every(({ words, globbed }) => {
    const [cmd, sub, ...rest] = words;
    const unsafeArg = UNSAFE_ARGS.get(cmd);
    if (unsafeArg && (globbed || words.some((w, i) => i > 0 && unsafeArg(w, words[i - 1])))) return false;
    if (cmd === "git") {
      if (sub === "branch") return rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--remotes|--show-current)$/.test(a));
      if (sub === "remote") return rest.every((a) => /^(-v|--verbose)$/.test(a));
      return SAFE_GIT.has(sub);
    }
    return SAFE_COMMANDS.has(cmd);
  });
}
function bashRule(command, cwd) {
  if (typeof command !== "string") return void 0;
  const commands = splitCommand(command.replace(HARMLESS_REDIRECTS, "$1"));
  if (commands?.length !== 1 || commands[0].globbed) return void 0;
  const words = commands[0].words;
  const [program2, sub] = words;
  if (!/^[\w@+-][\w@.+-]*$/.test(program2) || NEVER_RULED.has(program2)) return void 0;
  const unsafeArg = UNSAFE_ARGS.get(program2);
  if (unsafeArg && words.some((w, i) => i > 0 && unsafeArg(w, words[i - 1]))) return void 0;
  if (program2 === "git") {
    if (!GIT_RULED.has(sub) || words.some((w, i) => i > 1 && gitUnsafeForRule(w, sub))) return void 0;
    if (riskyGitConfig(cwd)?.length !== 0 || gitHooks(cwd).length) return void 0;
    return `git ${sub}`;
  }
  if (!SUBCOMMAND_TOOLS.has(program2) || !sub || !/^[a-z][\w:-]*$/i.test(sub)) return program2;
  return NEVER_RULED_SUB[program2]?.includes(sub) ? void 0 : `${program2} ${sub}`;
}
function argsTouchSecrets(command, cwd) {
  return !!splitCommand(command)?.some(
    ({ words }) => words.slice(1).some((word) => {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
      return [word, value].some((w) => {
        if (/^~[^/]/.test(w)) return true;
        const abs = path6.resolve(cwd, fixedPrefix(w.replace(/^~(?=\/|$)/, os5.homedir())));
        return inSecrets(abs) || !["ls", "stat"].includes(words[0]) && containsSecrets(abs);
      });
    })
  );
}
function runsGit(command) {
  return !!splitCommand(command)?.some(({ words }) => words[0] === "git");
}
function shellCwd(ctx) {
  return ctx.state.bashCwd ?? ctx.cwd;
}
function childEnv() {
  const { RAON_API_KEY: _key, ...env } = process.env;
  return { ...env, ...QUIET_GIT_ENV, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };
}
function countNewlines(s) {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}
function killTree(pid, outputs) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
  let pids = [];
  try {
    pids = fs5.readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  } catch {
  }
  for (const p of pids) {
    try {
      const stat = fs5.readFileSync(`/proc/${p}/stat`, "utf8");
      const session = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
      const holdsOutput = () => fs5.readdirSync(`/proc/${p}/fd`).some((fd) => outputs.includes(readLink(`/proc/${p}/fd/${fd}`)));
      if (session === pid || outputs.length && holdsOutput()) process.kill(Number(p), "SIGKILL");
    } catch {
    }
  }
}
function newCwdFile() {
  try {
    if (!cwdDir) {
      const dir = fs5.mkdtempSync(path6.join(os5.tmpdir(), "zoicode-bash-"));
      process.once("exit", () => fs5.rmSync(dir, { recursive: true, force: true }));
      cwdDir = dir;
    }
    return path6.join(cwdDir, `cwd-${randomUUID()}`);
  } catch {
    return void 0;
  }
}
function isDirectory(p) {
  try {
    return fs5.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function readLink(p) {
  try {
    return fs5.readlinkSync(p);
  } catch {
    return "";
  }
}
var SAFE_COMMANDS, SAFE_GIT, longFlag, shortFlag, UNSAFE_ARGS, NEVER_RULED, SUBCOMMAND_TOOLS, NEVER_RULED_SUB, GIT_RULED, gitUnsafeForRule, HARMLESS_REDIRECTS, BashTool, OUTPUT_LIMIT, HALF, OUTPUT_CAP, OutputBuffer, cwdDir, shellQuote;
var init_bash = __esm({
  "src/tools/bash.ts"() {
    "use strict";
    init_git();
    init_secrets();
    SAFE_COMMANDS = /* @__PURE__ */ new Set([
      "ls",
      "pwd",
      "cat",
      "head",
      "tail",
      "wc",
      "echo",
      "which",
      "file",
      "stat",
      "du",
      "df",
      "grep",
      "rg",
      "find",
      "date",
      "whoami",
      "uname",
      "sort",
      "diff"
    ]);
    SAFE_GIT = /* @__PURE__ */ new Set(["status", "diff", "log", "show", "rev-parse", "blame"]);
    longFlag = (word, ...names) => {
      const flag = word.split("=")[0];
      return flag.length > 2 && flag.startsWith("--") && names.some((name) => `--${name}`.startsWith(flag));
    };
    shortFlag = (word, letters, valued = "") => {
      if (!/^-[^-]/.test(word)) return false;
      for (const c of word.slice(1)) {
        if (letters.includes(c)) return true;
        if (valued.includes(c)) return false;
      }
      return false;
    };
    UNSAFE_ARGS = /* @__PURE__ */ new Map([
      ["find", (w) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(w)],
      ["sort", (w) => longFlag(w, "output", "compress-program") || shortFlag(w, "o")],
      ["rg", (w) => longFlag(w, "pre", "hostname-bin")],
      ["file", (w) => longFlag(w, "compile") || shortFlag(w, "C")],
      ["git", (w) => longFlag(w, "output", "ext-diff")],
      // `date MMDDhhmm` sets the clock like --set, so the only operands allowed are +FORMAT and option values.
      ["date", (w, prev) => longFlag(w, "set") || shortFlag(w, "s", "dfIr") || !/^[-+]/.test(w) && !/^(-[dfr]|--(date|file|reference|rfc-3339))$/.test(prev)]
    ]);
    NEVER_RULED = /* @__PURE__ */ new Set([
      "env",
      "sudo",
      "doas",
      "su",
      "runuser",
      "pkexec",
      "sh",
      "bash",
      "zsh",
      "dash",
      "ksh",
      "fish",
      "busybox",
      "eval",
      "exec",
      "command",
      "builtin",
      "source",
      ".",
      "trap",
      "enable",
      "coproc",
      "time",
      "xargs",
      "parallel",
      "timeout",
      "nohup",
      "nice",
      "ionice",
      "stdbuf",
      "setsid",
      "flock",
      "watch",
      "chroot",
      "unshare",
      "nsenter",
      "strace",
      "script",
      "ssh",
      "awk",
      "gawk",
      "nawk",
      "mawk",
      "sed",
      "perl",
      "python",
      "python2",
      "python3",
      "node",
      "nodejs",
      "ruby",
      "php",
      "lua",
      "luajit",
      "tclsh",
      "wish",
      "expect",
      "Rscript",
      "osascript",
      "pwsh",
      "vi",
      "vim",
      "nvim",
      "ex",
      "ed",
      "emacs",
      "less",
      "more",
      "man",
      "tar",
      "rsync",
      "scp",
      "open",
      "xdg-open",
      "npx",
      "pnpx",
      "bunx",
      "uvx",
      "pipx"
    ]);
    SUBCOMMAND_TOOLS = /* @__PURE__ */ new Set([
      "git",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "deno",
      "cargo",
      "go",
      "docker",
      "kubectl",
      "gh",
      "pip",
      "pip3",
      "uv",
      "poetry",
      "make",
      "just",
      "dotnet",
      "mvn",
      "gradle",
      "brew"
    ]);
    NEVER_RULED_SUB = {
      npm: ["exec", "x", "explore"],
      pnpm: ["exec", "dlx"],
      yarn: ["exec", "dlx"],
      bun: ["x"],
      deno: ["eval"],
      uv: ["run", "tool"],
      poetry: ["run"],
      gh: ["extension", "alias"]
    };
    GIT_RULED = /* @__PURE__ */ new Set([
      "add",
      "am",
      "apply",
      "blame",
      "branch",
      "checkout",
      "cherry-pick",
      "clean",
      "commit",
      "describe",
      "diff",
      "fetch",
      "format-patch",
      "grep",
      "init",
      "log",
      "ls-files",
      "merge",
      "mv",
      "notes",
      "pull",
      "push",
      "rebase",
      "reflog",
      "remote",
      "reset",
      "restore",
      "revert",
      "rev-parse",
      "rm",
      "shortlog",
      "show",
      "stash",
      "status",
      "switch",
      "tag",
      "worktree"
    ]);
    gitUnsafeForRule = (word, sub) => longFlag(word, "upload-pack", "receive-pack", "exec", "exec-path", "output", "ext-diff", "open-files-in-pager", "template", "config", "config-env") || shortFlag(word, "c") || sub === "grep" && shortFlag(word, "O") || sub === "rebase" && shortFlag(word, "x");
    HARMLESS_REDIRECTS = /(^|[ \t])(\d?>&\d|&?\d?>[ \t]*\/dev\/null)(?=[ \t]|$)/g;
    BashTool = {
      name: "Bash",
      description: "Run a bash command and return its combined stdout/stderr and exit code. The working directory persists between calls. Default timeout 120s (max 600s). Avoid interactive commands. Prefer Read/Glob/Grep/LS over cat/find/grep/ls for exploring files.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          timeout: { type: "number", description: "Timeout in milliseconds" },
          description: { type: "string", description: "5-10 word description of what the command does" }
        },
        required: ["command"]
      },
      readOnly: false,
      label: (i) => typeof i?.command === "string" ? i.command : "",
      isSafe: (i, ctx) => isSafeCommand(i?.command) && (!runsGit(i.command) || riskyGitConfig(shellCwd(ctx))?.length === 0) && !argsTouchSecrets(i.command, shellCwd(ctx)),
      run(input, ctx) {
        const command = input?.command;
        if (typeof command !== "string" || !command.trim()) {
          return Promise.resolve({ output: 'Error: the "command" parameter must be a non-empty string', isError: true });
        }
        const cwd = shellCwd(ctx);
        const cwdFile = newCwdFile();
        const script = cwdFile ? `${command}
__rc=$?
pwd -P > ${shellQuote(cwdFile)}
exit $__rc` : command;
        const timeout = Math.min(Number(input.timeout) > 0 ? Number(input.timeout) : 12e4, 6e5);
        return new Promise((resolve) => {
          let child;
          try {
            child = spawn("bash", ["-c", script], {
              cwd: isDirectory(cwd) ? cwd : ctx.cwd,
              env: childEnv(),
              stdio: ["ignore", "pipe", "pipe"],
              detached: true
            });
          } catch (e) {
            return resolve({ output: `Error: ${e.message}`, isError: true });
          }
          const outputs = [1, 2].map((fd) => readLink(`/proc/${child.pid}/fd/${fd}`)).filter(Boolean);
          const out = new OutputBuffer();
          let killedBy;
          let exitCode = null;
          let exited = false;
          let done = false;
          let drain;
          const kill = (why) => {
            if (exited) return;
            killedBy ??= why;
            killTree(child.pid, outputs);
          };
          const timer = setTimeout(() => kill(`timed out after ${timeout}ms`), timeout);
          const onAbort = () => kill("interrupted by user");
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(drain);
            ctx.signal?.removeEventListener("abort", onAbort);
            const background2 = !child.stdout.readableEnded || !child.stderr.readableEnded;
            child.stdout.unref();
            child.stderr.unref();
            if (cwdFile) {
              try {
                const dir = fs5.readFileSync(cwdFile, "utf8").replace(/\n$/, "");
                if (path6.isAbsolute(dir) && isDirectory(dir)) ctx.state.bashCwd = dir;
                fs5.rmSync(cwdFile);
              } catch {
              }
            }
            if (error) return resolve({ output: `Error: ${error.message}`, isError: true });
            const { text, lines } = out.result();
            const note = background2 && !killedBy ? "\n(Background processes are still running; their output is not captured.)" : "";
            const status = killedBy ? `Command ${killedBy}` : `Exit code ${exitCode}`;
            resolve({
              output: `${text || "(no output)"}${note}

${status}`,
              isError: killedBy !== void 0 || exitCode !== 0,
              summary: killedBy ? status : `${lines} line${lines === 1 ? "" : "s"} of output${exitCode ? ` \xB7 exit ${exitCode}` : ""}`
            });
          };
          const onData = (s) => {
            if (done) return;
            out.push(s);
            if (out.total > OUTPUT_CAP) kill(`stopped after printing more than ${OUTPUT_CAP / 1e6}M characters`);
          };
          child.stdout.setEncoding("utf8").on("data", onData);
          child.stderr.setEncoding("utf8").on("data", onData);
          child.on("error", finish);
          child.on("exit", (code) => {
            exited = true;
            exitCode = code;
            clearTimeout(timer);
            drain = setTimeout(() => setImmediate(finish), 200);
          });
          child.on("close", () => finish());
        });
      }
    };
    OUTPUT_LIMIT = 3e4;
    HALF = OUTPUT_LIMIT / 2;
    OUTPUT_CAP = 5e7;
    OutputBuffer = class {
      total = 0;
      head = "";
      // the first HALF characters
      tail = "";
      // the last HALF characters up to the last non-blank one
      blank = "";
      // the blank run after that (its last HALF characters)
      blankLength = 0;
      blankNewlines = 0;
      newlines = 0;
      push(s) {
        this.total += s.length;
        this.newlines += countNewlines(s);
        if (this.head.length < HALF) this.head += s.slice(0, HALF - this.head.length);
        const end = s.trimEnd().length;
        if (end > 0) {
          this.tail = (this.tail + this.blank + s.slice(0, end)).slice(-HALF);
          this.blank = "";
          this.blankLength = this.blankNewlines = 0;
        }
        const rest = s.slice(end);
        this.blank = (this.blank + rest).slice(-HALF);
        this.blankLength += rest.length;
        this.blankNewlines += countNewlines(rest);
      }
      result() {
        const length = this.total - this.blankLength;
        const text = length <= HALF ? this.head.slice(0, length) : length <= OUTPUT_LIMIT ? this.head + this.tail.slice(HALF - length) : `${this.head}

... [${length - OUTPUT_LIMIT} characters truncated] ...

${this.tail}`;
        return { text, lines: length ? this.newlines - this.blankNewlines + 1 : 0 };
      }
    };
    shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  }
});

// src/tools/files.ts
import { isUtf8 } from "node:buffer";
import fs6 from "node:fs/promises";
import path7 from "node:path";
import { createTwoFilesPatch } from "diff";
function makeDiff(file, before, after) {
  try {
    return createTwoFilesPatch(file, file, before, after, "", "", { context: 3, timeout: 200 });
  } catch {
    return void 0;
  }
}
async function readText(abs, signal) {
  const stat = await fs6.stat(abs);
  if (!stat.isFile()) throw new Error(`${abs} is not a regular file (a device, FIFO or socket), so it is not read.`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${abs} is ${(stat.size / 1e6).toFixed(0)} MB, too large to load. Use Grep, or Bash (head, tail, sed -n) to read parts.`);
  }
  const raw = await fs6.readFile(abs, { signal });
  return { text: raw.toString("utf8"), utf8: isUtf8(raw) };
}
async function exists(p) {
  return fs6.lstat(p).then(() => true, () => false);
}
function applyEdit(before, input, file = "the file") {
  const { old_string: oldStr, new_string: newStr } = input;
  if (typeof oldStr !== "string" || typeof newStr !== "string") return { error: BAD_EDIT_ARGS };
  if (oldStr === newStr) return { error: "old_string and new_string are identical." };
  if (oldStr === "") {
    if (before === "") return { after: newStr, count: 1 };
    return {
      error: `old_string is empty, but ${file} is not. Give the exact text to replace, or use Write to replace the whole file.`
    };
  }
  const parts = before.split(oldStr);
  const count = parts.length - 1;
  if (count === 0) return { error: `old_string not found in ${file}. Check whitespace and read the file again.` };
  const replaceAll = input.replace_all === true || input.replace_all === "true";
  if (count > 1 && !replaceAll) {
    return { error: `old_string occurs ${count} times. Add more context to make it unique, or set replace_all.` };
  }
  return { after: replaceAll ? parts.join(newStr) : before.replace(oldStr, () => newStr), count };
}
var MAX_LINES, MAX_LINE_LEN, MAX_FILE_BYTES, notUtf8, BAD_EDIT_ARGS, ReadTool, WriteTool, EditTool, LSTool;
var init_files = __esm({
  "src/tools/files.ts"() {
    "use strict";
    init_types();
    MAX_LINES = 2e3;
    MAX_LINE_LEN = 2e3;
    MAX_FILE_BYTES = 5e7;
    notUtf8 = (abs) => `${abs} is not valid UTF-8 (a legacy encoding such as CP949/EUC-KR, Shift-JIS or Latin-1, or a binary file). Changing it with this tool would replace those bytes with U+FFFD and corrupt it. Use Bash (e.g. iconv) instead, or ask the user whether to convert the file to UTF-8.`;
    BAD_EDIT_ARGS = 'old_string and new_string must both be strings. To delete text, pass new_string: "".';
    ReadTool = {
      name: "Read",
      description: `Read a file from the local filesystem. Returns lines in \`cat -n\` format (line number, tab, content). Reads up to ${MAX_LINES} lines by default; use offset (1-based line) and limit for large files. Always read a file before editing it.`,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to read (absolute or relative to cwd)" },
          offset: { type: "number", description: "Line number to start reading from (1-based)" },
          limit: { type: "number", description: "Number of lines to read" }
        },
        required: ["file_path"]
      },
      readOnly: true,
      label: (i) => i.file_path,
      async run(input, ctx) {
        const abs = resolvePath(ctx, input.file_path);
        const stat = await fs6.stat(abs).catch(() => null);
        if (!stat) {
          return { output: await exists(abs) ? `${abs} is a broken symbolic link.` : `File does not exist: ${abs}`, isError: true };
        }
        if (stat.isDirectory()) return { output: `${abs} is a directory. Use LS to list it.`, isError: true };
        let read;
        try {
          read = await readText(abs, ctx.signal);
        } catch (e) {
          ctx.signal?.throwIfAborted();
          return { output: e.message, isError: true };
        }
        const { text: content, utf8 } = read;
        ctx.readFiles.set(abs, stat.mtimeMs);
        if (content.length === 0) return { output: "<file is empty>", summary: "Read empty file" };
        const lines = content.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const start = Math.max(1, input.offset ?? 1);
        const slice = lines.slice(start - 1, start - 1 + (input.limit ?? MAX_LINES));
        const out = slice.map((l, i) => `${String(start + i).padStart(6)}	${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + "\u2026" : l}`).join("\n");
        const more = start - 1 + slice.length < lines.length ? `

(file has ${lines.length} lines; use offset to read more)` : "";
        const note = utf8 ? "" : "\n\n(This file is not valid UTF-8: undecodable bytes are shown as U+FFFD, and Edit and Write will refuse to change it.)";
        return { output: out + more + note, summary: `Read ${slice.length} lines` };
      }
    };
    WriteTool = {
      name: "Write",
      description: "Write a file to the local filesystem, overwriting it if it exists. Parent directories are created. If the file already exists you must Read it first. Prefer Edit for changing existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to write" },
          content: { type: "string", description: "Full content of the file" }
        },
        required: ["file_path", "content"]
      },
      readOnly: false,
      label: (i) => i.file_path,
      async run(input, ctx) {
        if (typeof input.content !== "string") return { output: "content is required and must be a string.", isError: true };
        const abs = resolvePath(ctx, input.file_path);
        const existed = await exists(abs);
        if (existed && !ctx.readFiles.has(abs)) {
          return { output: `File ${abs} already exists. Read it before overwriting.`, isError: true };
        }
        const current = existed ? await readText(abs, ctx.signal) : { text: "", utf8: true };
        if (!current.utf8) return { output: notUtf8(abs), isError: true };
        await fs6.mkdir(path7.dirname(abs), { recursive: true });
        await fs6.writeFile(abs, input.content);
        ctx.readFiles.set(abs, (await fs6.stat(abs)).mtimeMs);
        const lines = input.content.split("\n").length;
        return {
          output: `${existed ? "Updated" : "Created"} ${abs} (${lines} lines)`,
          summary: `${existed ? "Wrote" : "Created"} ${lines} lines`,
          diff: makeDiff(displayPath(ctx, abs), current.text, input.content)
        };
      }
    };
    EditTool = {
      name: "Edit",
      description: "Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first. Do not include the line-number prefix from Read output.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path of the file to edit" },
          old_string: { type: "string", description: "Exact text to replace" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" }
        },
        required: ["file_path", "old_string", "new_string"]
      },
      readOnly: false,
      label: (i) => i.file_path,
      async run(input, ctx) {
        if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
          return { output: BAD_EDIT_ARGS, isError: true };
        }
        const abs = resolvePath(ctx, input.file_path);
        if (!await exists(abs)) {
          if (input.old_string === "") {
            return WriteTool.run({ file_path: abs, content: input.new_string }, ctx);
          }
          return { output: `File does not exist: ${abs}`, isError: true };
        }
        if (!ctx.readFiles.has(abs)) return { output: `Read ${abs} before editing it.`, isError: true };
        const mtime = (await fs6.stat(abs)).mtimeMs;
        if (mtime > (ctx.readFiles.get(abs) ?? 0) + 1) {
          return { output: `${abs} changed on disk since it was read. Read it again.`, isError: true };
        }
        const { text: before, utf8 } = await readText(abs, ctx.signal);
        if (!utf8) return { output: notUtf8(abs), isError: true };
        const edit = applyEdit(before, input, abs);
        if ("error" in edit) return { output: edit.error, isError: true };
        await fs6.writeFile(abs, edit.after);
        ctx.readFiles.set(abs, (await fs6.stat(abs)).mtimeMs);
        const replacements = edit.count > 1 ? `${edit.count} replacements` : "1 replacement";
        const diff = makeDiff(displayPath(ctx, abs), before, edit.after);
        const lines = diff?.split("\n") ?? [];
        const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        return {
          output: `Edited ${abs} (${replacements})`,
          summary: diff ? `Added ${added} lines, removed ${removed} lines` : `Made ${replacements} (diff too large to show)`,
          diff
        };
      }
    };
    LSTool = {
      name: "LS",
      description: 'List files and directories in a directory (non-recursive). Directories end with "/".',
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory to list (default: cwd)" } }
      },
      readOnly: true,
      label: (i) => i.path ?? ".",
      async run(input, ctx) {
        const abs = resolvePath(ctx, input.path);
        const entries = await fs6.readdir(abs, { withFileTypes: true }).catch((e) => e);
        if (entries instanceof Error) return { output: entries.message, isError: true };
        const names = entries.map((e) => e.isDirectory() ? e.name + "/" : e.name).sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
        return { output: `${abs}
` + names.map((n) => `  ${n}`).join("\n"), summary: `Listed ${names.length} entries` };
      }
    };
  }
});

// src/tools/search.ts
import fsCb from "node:fs";
import fs7 from "node:fs/promises";
import path8 from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { glob } from "tinyglobby";
function loopGuard() {
  const ids = /* @__PURE__ */ new Map();
  const idOf = (p) => {
    let id = ids.get(p);
    if (!id) ids.set(p, id = fs7.stat(p).then((st) => st.ino ? `${st.dev}:${st.ino}` : void 0, () => void 0));
    return id;
  };
  async function loops(link, target) {
    const st = await fs7.stat(target).catch(() => null);
    if (!st?.isDirectory() || !st.ino) return false;
    const id = `${st.dev}:${st.ino}`;
    for (let dir = path8.dirname(link), up = path8.dirname(dir); ; dir = up, up = path8.dirname(dir)) {
      if (await idOf(dir) === id) return true;
      if (up === dir) return false;
    }
  }
  function realpath(link, cb) {
    fsCb.realpath(link, (err, resolved) => {
      if (err) return cb(err, resolved);
      if (inSecrets(resolved)) return cb(Object.assign(new Error(`link into a credential folder at ${link}`), { code: "EACCES" }), resolved);
      loops(link, resolved).then(
        (loop) => cb(loop ? Object.assign(new Error(`symlink loop at ${link}`), { code: "ELOOP" }) : null, resolved)
      );
    });
  }
  const secret = secretMatcher();
  function readdir(dir, opts, cb) {
    const done = typeof opts === "function" ? opts : cb;
    const clean2 = dir.replace(/\/+$/, "") || "/";
    if (secret(clean2)) return done(null, []);
    const filter = (err, entries) => done(err, entries?.filter((e) => !secret(path8.join(clean2, typeof e === "string" ? e : e.name))));
    if (typeof opts === "function") fsCb.readdir(dir, filter);
    else fsCb.readdir(dir, opts, filter);
  }
  return { realpath, readdir };
}
function walk(pattern, cwd, signal) {
  return glob(pattern, {
    cwd,
    ignore: IGNORE,
    dot: true,
    absolute: true,
    onlyFiles: true,
    expandDirectories: false,
    signal,
    fs: loopGuard()
  });
}
function lineMatcher(pattern, flags) {
  let worker;
  const spawn2 = () => new Worker(MATCHER_WORKER, { eval: true, workerData: { pattern, flags }, execArgv: [] }).on("error", () => {
  });
  const close = () => {
    void worker?.terminate();
    worker = void 0;
  };
  const match = (text, first, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const w = worker ??= spawn2();
    const settle = (err, matches) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      w.off("message", onMatches).off("error", settle);
      if (matches) return resolve(matches);
      close();
      reject(err);
    };
    const onMatches = (matches) => settle(null, matches);
    const onAbort = () => settle(signal.reason);
    const timer = setTimeout(() => settle(new SlowPattern()), SLOW_MS);
    w.on("message", onMatches).on("error", settle);
    signal?.addEventListener("abort", onAbort);
    w.postMessage({ text, first });
  });
  return { match, close };
}
async function scanFile(file, o, onMatch) {
  let fh;
  try {
    fh = await fs7.open(file, "r");
  } catch (e) {
    return problemOf(e);
  }
  try {
    const decoder = new StringDecoder("utf8");
    let text = "";
    let lineNo = 0;
    for (let pos = 0; ; ) {
      o.signal.throwIfAborted();
      const { bytesRead } = await fh.read(o.buf, 0, o.buf.length, pos);
      if (pos === 0) {
        if (o.buf.subarray(0, Math.min(bytesRead, 8e3)).includes(0)) return void 0;
        const size = o.inWalk && bytesRead === o.buf.length ? (await fh.stat()).size : 0;
        if (size > WALK_MAX_BYTES) {
          return `${(size / 1e6).toFixed(1)} MB, over the ${WALK_MAX_BYTES / 1e6} MB limit for directory searches; pass it as path to search it`;
        }
      }
      pos += bytesRead;
      const eof = bytesRead === 0;
      text += eof ? decoder.end() : decoder.write(o.buf.subarray(0, bytesRead));
      if (!eof && text.length < o.buf.length) continue;
      let end = eof ? text.length : text.lastIndexOf("\n") + 1;
      const cut = text.length - end > MAX_LINE;
      if (cut) end = text.length;
      if (end) {
        const { hits, lines } = await o.matcher.match(text.slice(0, end), o.first, o.signal);
        for (const [i, line] of hits) onMatch(lineNo + i + 1, line);
        lineNo += lines;
        if (o.first && hits.length) return void 0;
        text = text.slice(end);
      }
      if (cut) return `searched up to line ${lineNo}, which is over ${MAX_LINE >> 20} MB long`;
      if (eof) return void 0;
    }
  } catch (e) {
    if (e instanceof SlowPattern) return `the regex ran for over ${SLOW_MS / 1e3}s on its lines; try a simpler pattern`;
    if (o.signal.aborted) throw e;
    return problemOf(e);
  } finally {
    await fh.close();
  }
}
function problemOf(e) {
  const { code, syscall, message } = e;
  if (code === "ENOENT") return void 0;
  return syscall ? `could not read it: ${code}` : `could not search it: ${message}`;
}
var IGNORE, GlobTool, WALK_MAX_BYTES, CHUNK_BYTES, MAX_LINE, SLOW_MS, BUDGET_MS, MATCHER_WORKER, SlowPattern, GrepTool;
var init_search = __esm({
  "src/tools/search.ts"() {
    "use strict";
    init_secrets();
    init_types();
    IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/__pycache__/**"];
    GlobTool = {
      name: "Glob",
      description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns paths sorted by modification time, newest first. Ignores node_modules, .git and build output.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Directory to search in (default: cwd)" }
        },
        required: ["pattern"]
      },
      readOnly: true,
      label: (i) => i.pattern + (i.path ? ` in ${i.path}` : ""),
      async run(input, ctx) {
        const cwd = resolvePath(ctx, input.path);
        const paths = await walk(input.pattern, cwd, ctx.signal);
        ctx.signal?.throwIfAborted();
        const mtimes = await Promise.all(paths.map((p) => fs7.stat(p).then((st) => st.mtimeMs, () => 0)));
        const entries = paths.map((path15, i) => ({ path: path15, mtime: mtimes[i] })).sort((a, b) => b.mtime - a.mtime);
        const files = entries.slice(0, 200).map((e) => e.path);
        if (!files.length) return { output: "No files found", summary: "Found 0 files" };
        const more = entries.length > files.length ? `
(${entries.length - files.length} more not shown)` : "";
        return { output: files.join("\n") + more, summary: `Found ${entries.length} file${entries.length === 1 ? "" : "s"}` };
      }
    };
    WALK_MAX_BYTES = 5e7;
    CHUNK_BYTES = 1 << 20;
    MAX_LINE = 4 << 20;
    SLOW_MS = 5e3;
    BUDGET_MS = 6e4;
    MATCHER_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', ({ text, first }) => {
  const lines = text.split('\\n');
  if (lines[lines.length - 1] === '') lines.pop(); // text ends with a newline
  const hits = [];
  for (let i = 0; i < lines.length && !(first && hits.length); i++) if (re.test(lines[i])) hits.push([i, lines[i].slice(0, 500)]);
  parentPort.postMessage({ hits, lines: lines.length });
});`;
    SlowPattern = class extends Error {
    };
    GrepTool = {
      name: "Grep",
      description: `Search file contents with a JavaScript regular expression. output_mode "files_with_matches" (default) lists matching files, "content" shows matching lines with line numbers, "count" shows match counts. Filter files with glob, e.g. "*.ts" or "**/*.{js,jsx}". Directory searches skip binary files and text files over ${WALK_MAX_BYTES / 1e6} MB; pass a file as path to search it whatever its size.`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for" },
          path: { type: "string", description: "File or directory to search (default: cwd)" },
          glob: { type: "string", description: "Glob filter for files" },
          case_insensitive: { type: "boolean" },
          output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] }
        },
        required: ["pattern"]
      },
      readOnly: true,
      label: (i) => `"${i.pattern}"` + (i.path ? ` in ${i.path}` : "") + (i.glob ? ` (${i.glob})` : ""),
      async run(input, ctx) {
        const flags = input.case_insensitive ? "i" : "";
        try {
          new RegExp(input.pattern, flags);
        } catch (e) {
          return { output: `Invalid regex: ${e.message}`, isError: true };
        }
        const root = resolvePath(ctx, input.path);
        const stat = await fs7.stat(root).catch(() => null);
        if (!stat) return { output: `Path does not exist: ${root}`, isError: true };
        const filePattern = input.glob ? input.glob.includes("/") ? input.glob : `**/${input.glob}` : "**/*";
        const budget = AbortSignal.timeout(BUDGET_MS);
        const signal = AbortSignal.any([budget, ...ctx.signal ? [ctx.signal] : []]);
        const mode = input.output_mode ?? "files_with_matches";
        const out = [];
        const notSearched = [];
        let matchedFiles = 0;
        let matchedLines = 0;
        let stopped = false;
        const matcher = lineMatcher(input.pattern.replace(/^(?:\.\*\??)+/, ""), flags);
        const scan = {
          matcher,
          buf: Buffer.allocUnsafe(CHUNK_BYTES),
          inWalk: !stat.isFile(),
          first: mode === "files_with_matches",
          signal
        };
        try {
          const files = stat.isFile() ? [root] : await walk(filePattern, root, signal);
          signal.throwIfAborted();
          for (const file of files) {
            let count = 0;
            const problem = await scanFile(file, scan, (lineNo, line) => {
              count++;
              if (mode === "content" && matchedLines + count <= 500) out.push(`${file}:${lineNo}:${line.slice(0, 500)}`);
            });
            if (problem) notSearched.push(`${file} (${problem})`);
            if (!count) continue;
            matchedFiles++;
            matchedLines += count;
            if (mode === "files_with_matches") out.push(file);
            if (mode === "count") out.push(`${file}:${count}`);
          }
        } catch (e) {
          if (ctx.signal?.aborted || !budget.aborted) throw e;
          stopped = true;
        } finally {
          matcher.close();
        }
        let note = "";
        if (stopped) note += `

(Search stopped after ${BUDGET_MS / 1e3}s, so results are incomplete. Narrow it down with path or glob.)`;
        if (notSearched.length) {
          const more = notSearched.length > 10 ? `, and ${notSearched.length - 10} more` : "";
          note += `

(Not fully searched: ${notSearched.slice(0, 10).join(", ")}${more}.)`;
        }
        if (!matchedFiles) return { output: "No matches found" + note, summary: "No matches" };
        return {
          output: truncate(out.join("\n"), 2e4) + note,
          summary: mode === "content" ? `Found ${matchedLines} lines` : `Found ${matchedFiles} file${matchedFiles === 1 ? "" : "s"}`
        };
      }
    };
  }
});

// src/tools/plan.ts
var ExitPlanModeTool;
var init_plan = __esm({
  "src/tools/plan.ts"() {
    "use strict";
    ExitPlanModeTool = {
      name: "ExitPlanMode",
      description: "Call this when you are in plan mode and have finished researching: present your implementation plan (markdown, concise, concrete steps and files) for the user to approve. Only use it for tasks that need code changes, not for pure research questions.",
      parameters: {
        type: "object",
        properties: { plan: { type: "string", description: "The plan, in markdown" } },
        required: ["plan"]
      },
      readOnly: true,
      label: () => "plan ready",
      async run() {
        return { output: "Plan approval is handled by the agent.", isError: true };
      }
    };
  }
});

// src/tools/task.ts
var TaskTool;
var init_task = __esm({
  "src/tools/task.ts"() {
    "use strict";
    TaskTool = {
      name: "Task",
      description: "Launch a subagent with its own fresh context to handle a self-contained task, such as searching a large codebase, investigating a question across many files, or researching docs. It has the same tools as you (except Task) and returns one final report. Give it a complete, specific prompt: it cannot see this conversation. Use it to keep your own context small; launch several in one turn for independent tasks.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short (3-5 word) description of the task" },
          prompt: { type: "string", description: "Full instructions for the subagent, including what to report back" }
        },
        required: ["description", "prompt"]
      },
      readOnly: true,
      label: (i) => i.description,
      async run(input, ctx) {
        if (!ctx.runSubagent) return { output: "Subagents are not available here.", isError: true };
        const { text, toolUses } = await ctx.runSubagent(input.description, input.prompt, (m) => ctx.progress?.(m));
        return {
          output: text || "(the subagent returned no report)",
          summary: `Done \xB7 ${toolUses} tool use${toolUses === 1 ? "" : "s"}`
        };
      }
    };
  }
});

// src/tools/todo.ts
function parseTodos(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "`todos` must be an array, but got a string that is not valid JSON.";
    }
  }
  if (!Array.isArray(value)) return `\`todos\` must be an array of {content, status} objects, but got ${value === null ? "null" : typeof value}.`;
  const bad = value.findIndex((t) => typeof t?.content !== "string" || !STATUSES.includes(t?.status));
  if (bad >= 0) {
    return `todos[${bad}] must be {"content": string, "status": "pending" | "in_progress" | "completed"}, but got ${JSON.stringify(value[bad])?.slice(0, 120)}.`;
  }
  return value.map((t) => ({ content: t.content, status: t.status }));
}
var STATUSES, TodoWriteTool;
var init_todo = __esm({
  "src/tools/todo.ts"() {
    "use strict";
    STATUSES = ["pending", "in_progress", "completed"];
    TodoWriteTool = {
      name: "TodoWrite",
      description: "Create or update the task list for the current work. Use it for multi-step tasks (3+ steps): write the whole list each time, keep exactly one item in_progress, and mark items completed as soon as they are done.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] }
              },
              required: ["content", "status"]
            }
          }
        },
        required: ["todos"]
      },
      readOnly: true,
      label: (i) => {
        const todos = parseTodos(i.todos);
        return typeof todos === "string" ? "invalid list" : `${todos.length} items`;
      },
      async run(input, ctx) {
        const todos = parseTodos(input.todos);
        if (typeof todos === "string") {
          return { output: `${todos} The previous list is unchanged; call TodoWrite again with the whole list as an array.`, isError: true };
        }
        ctx.state.todos = todos;
        const done = todos.filter((t) => t.status === "completed").length;
        return {
          output: "Todo list updated. Keep working through it.\n" + todos.map((t) => `[${t.status}] ${t.content}`).join("\n"),
          summary: `${done}/${todos.length} done`
        };
      }
    };
  }
});

// src/tools/web.ts
function dropComments(html) {
  let out = "";
  for (let i = 0; ; ) {
    const start = html.indexOf("<!--", i);
    if (start === -1) return out + html.slice(i);
    out += html.slice(i, start);
    const end = html.indexOf("-->", start + 4);
    if (end === -1) return out;
    i = end + 3;
  }
}
function htmlToText(html) {
  let out = "";
  let link;
  let skipping = "";
  const emit = (t) => {
    if (link) link.text += t;
    else out += t;
  };
  const endLink = () => {
    if (!link) return;
    const { href = "", text } = link;
    link = void 0;
    const t = text.trim();
    out += t && href && !href.startsWith("#") && !href.startsWith("javascript:") ? `[${t}](${href})` : t;
  };
  const token = /<[^<>]*>|[^<]+|</g;
  const source = dropComments(html.slice(0, MAX_HTML));
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const t = m[0];
    const tag = t.length > 1 && t[0] === "<" ? /^<(\/?)([a-z][\w-]*)/i.exec(t) : null;
    if (!tag) {
      if (!skipping && (t[0] !== "<" || t === "<")) emit(t);
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2].toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = "";
    } else if (!closing && SKIPPED.has(name)) skipping = name;
    else if (/^h[1-6]$/.test(name)) emit(closing ? "\n\n" : `

${"#".repeat(Number(name[1]))} `);
    else if (name === "a") {
      endLink();
      if (!closing) link = { href: /\shref=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(t)?.slice(1).find((v) => v !== void 0), text: "" };
    } else if (name === "li" && !closing) emit("\n- ");
    else if (name === "pre") emit("\n```\n");
    else if ((name === "br" || name === "hr") && !closing) emit("\n");
    else if (closing && BLOCK_ENDS.has(name)) emit("\n\n");
  }
  endLink();
  let s = out;
  s = s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isNaN(code)) return m;
      return code === 0 || code > 1114111 || code >= 55296 && code <= 57343 ? "\uFFFD" : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function checkUrl(url) {
  if (!["http:", "https:"].includes(url.protocol)) return "Only http and https URLs are supported.";
  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) url.protocol = "https:";
  return void 0;
}
var MAX_BYTES, MAX_REDIRECTS, ENTITIES, MAX_HTML, SKIPPED, BLOCK_ENDS, WebFetchTool;
var init_web = __esm({
  "src/tools/web.ts"() {
    "use strict";
    init_types();
    MAX_BYTES = 5e6;
    MAX_REDIRECTS = 10;
    ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026" };
    MAX_HTML = 2e6;
    SKIPPED = /* @__PURE__ */ new Set(["script", "style", "noscript", "svg", "head", "iframe"]);
    BLOCK_ENDS = /* @__PURE__ */ new Set(["p", "div", "section", "article", "header", "footer", "tr", "table", "ul", "ol", "blockquote"]);
    WebFetchTool = {
      name: "WebFetch",
      description: "Fetch a web page (http/https) and return its content as readable text/markdown. Use it to read documentation, issues or articles the user points to. Long pages are truncated. A redirect to another host is not followed: you get its URL and can fetch that with another call.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Fully-formed URL, e.g. https://example.com/docs" } },
        required: ["url"]
      },
      readOnly: false,
      label: (i) => i.url,
      async run(input, ctx) {
        let url;
        try {
          url = new URL(input.url);
        } catch {
          return { output: `Invalid URL: ${input.url}`, isError: true };
        }
        const invalid = checkUrl(url);
        if (invalid) return { output: invalid, isError: true };
        const stop = new AbortController();
        const signal = AbortSignal.any([AbortSignal.timeout(3e4), stop.signal, ...ctx.signal ? [ctx.signal] : []]);
        const headers = { "User-Agent": "zoicode/0.1 (+cli)", Accept: "text/html,text/plain,application/json,*/*" };
        let res;
        try {
          for (let current = url, hops = 0; ; hops++) {
            res = await fetch(current, { signal, redirect: "manual", headers });
            const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
            if (!location) break;
            await res.body?.cancel();
            const next = new URL(location, current);
            const invalidNext = checkUrl(next);
            if (invalidNext) return { output: `${current.href} redirects to ${next.href}. ${invalidNext}`, isError: true };
            if (next.hostname !== url.hostname) {
              return {
                output: `${current.href} redirects to a different host: ${next.href}
It was not fetched. Call WebFetch again with that URL if you need it.`,
                summary: `Redirects to ${next.hostname}`
              };
            }
            if (hops === MAX_REDIRECTS) return { output: `Too many redirects (last: ${next.href}).`, isError: true };
            current = next;
          }
        } catch (e) {
          return { output: `Fetch failed: ${e.message}`, isError: true };
        }
        const type = res.headers.get("content-type") ?? "";
        if (!/text|json|xml|javascript/.test(type) && type) {
          stop.abort();
          return { output: `Unsupported content type: ${type}`, isError: true };
        }
        const declared = Number(res.headers.get("content-length"));
        if (declared > MAX_BYTES) {
          stop.abort();
          return { output: `Response too large (${declared} bytes).`, isError: true };
        }
        const chunks = [];
        let size = 0;
        try {
          const reader = res.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
              stop.abort();
              return { output: `Response too large (over ${MAX_BYTES} bytes).`, isError: true };
            }
            chunks.push(value);
          }
        } catch (e) {
          return { output: `Fetch failed while reading the response: ${e.message}`, isError: true };
        }
        const buf = Buffer.concat(chunks);
        const raw = buf.toString("utf8");
        const isHtml = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw);
        const body = isHtml ? htmlToText(raw) : raw;
        const title = isHtml ? htmlToText(raw.slice(0, MAX_HTML).match(/<title\b[^<>]*>([^<]*)<\/title>/i)?.[1] ?? "") : "";
        const header = `URL: ${res.url}
Status: ${res.status} ${res.statusText}
${title ? `Title: ${title}
` : ""}
`;
        return {
          output: header + truncate(body, 4e4),
          isError: !res.ok,
          summary: `${res.status} \xB7 ${Math.round(buf.length / 1024)} KB \xB7 ${body.split("\n").length} lines`
        };
      }
    };
  }
});

// src/tools/index.ts
function findTool(name) {
  return [...ALL_TOOLS, ExitPlanModeTool].find((t) => t.name.toLowerCase() === name.toLowerCase());
}
function toolSpecs(tools = ALL_TOOLS) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}
var ALL_TOOLS;
var init_tools = __esm({
  "src/tools/index.ts"() {
    "use strict";
    init_bash();
    init_files();
    init_search();
    init_plan();
    init_task();
    init_todo();
    init_web();
    ALL_TOOLS = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, LSTool, TodoWriteTool, WebFetchTool, TaskTool];
  }
});

// src/agent.ts
import path9 from "node:path";
function isSimpleCommand(command) {
  const line = command.replace(/(^|[ \t])(\d?>&\d|&?\d?>[ \t]*\/dev\/null)(?=[ \t]|$)/g, "$1");
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
    } else if (ch === "\\") {
      i++;
    } else if (ch === "`" || ch === "$" && line[i + 1] === "(") {
      return false;
    } else if (quote === '"') {
      if (ch === '"') quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (";&|<>()\n".includes(ch)) {
      return false;
    }
  }
  return !quote;
}
function cutOffReason(finishReason) {
  if (finishReason === "length") return "it reached the length limit";
  if (!finishReason) return "the response ended early";
  return void 0;
}
function describe(value) {
  return value === null ? "null" : article(Array.isArray(value) ? "array" : typeof value);
}
function parseArguments(text) {
  if (!text.trim()) return { input: {} };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "the arguments are not valid JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { problem: `the arguments must be a JSON object, not ${describe(value)}` };
  }
  return { input: value };
}
function hasType(value, type) {
  switch (type) {
    case "string":
    case "boolean":
      return typeof value === type;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    default:
      return true;
  }
}
function checkArgs(tool, input) {
  const { properties = {}, required = [] } = tool.parameters;
  for (const key of /* @__PURE__ */ new Set([...required, ...Object.keys(properties)])) {
    const { type, enum: choices } = properties[key] ?? {};
    const value = input[key];
    if (value === void 0 || value === null) {
      if (required.includes(key)) {
        const got = Object.keys(input).map((k) => `"${k}"`).join(", ") || "none";
        return `missing required parameter "${key}"${type ? ` (${type})` : ""}; parameters given: ${got}`;
      }
      delete input[key];
    } else if (type && !hasType(value, type)) {
      return `parameter "${key}" must be ${article(type)}, not ${describe(value)}`;
    } else if (choices && !choices.includes(value)) {
      return `parameter "${key}" must be one of ${choices.map((c) => JSON.stringify(c)).join(", ")}`;
    }
  }
  return void 0;
}
function prepareCall(call, cutOff) {
  const tool = findTool(call.name);
  const parsed = parseArguments(call.arguments);
  const input = "input" in parsed ? parsed.input : {};
  if (!tool) return { call, input };
  if ("problem" in parsed && cutOff) {
    const error = `This tool call was cut off (${cutOff}) before its arguments were complete, so it was not run. Try again, splitting very large content into several smaller calls.`;
    return { call, tool, input, error };
  }
  const problem = "problem" in parsed ? parsed.problem : checkArgs(tool, input);
  return { call, tool, input, error: problem && `Invalid arguments for ${tool.name}: ${problem}. Received: ${call.arguments.slice(0, 500)}` };
}
function repairHistory(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const c of m.tool_calls) {
      if ("function" in c && (typeof c.function.arguments !== "string" || "problem" in parseArguments(c.function.arguments))) {
        c.function.arguments = "{}";
      }
    }
    const answered = /* @__PURE__ */ new Set();
    for (let j = i + 1; j < messages.length && messages[j].role !== "assistant"; j++) {
      const t = messages[j];
      if (t.role === "tool") answered.add(t.tool_call_id);
    }
    let end = i + 1;
    while (end < messages.length && messages[end].role === "tool") end++;
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    messages.splice(end, 0, ...missing.map((c) => ({ role: "tool", tool_call_id: c.id, content: "Not run: the session was interrupted." })));
  }
}
function safeLabel(tool, input) {
  try {
    const label = tool.label(input);
    return typeof label === "string" ? label : "";
  } catch {
    return "";
  }
}
var EDIT_TOOLS, PLAN_TOOLS, MAX_RESULT_CHARS, MAX_PROMPT_CHARS, PLAN_REMINDER, SUBAGENT_PREFIX, Agent, article;
var init_agent = __esm({
  "src/agent.ts"() {
    "use strict";
    init_prompt();
    init_tools();
    init_bash();
    init_secrets();
    init_types();
    EDIT_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit"]);
    PLAN_TOOLS = /* @__PURE__ */ new Set(["Bash", "WebFetch"]);
    MAX_RESULT_CHARS = 1e5;
    MAX_PROMPT_CHARS = 2e5;
    PLAN_REMINDER = "Plan mode is active. Do not make any changes yet: no file edits or writes, and no commands that change state. Research with read-only tools (Read, Glob, Grep, LS, read-only Bash commands, WebFetch), then call ExitPlanMode with a concise, concrete implementation plan for the user to approve. If the request is just a question, answer it directly instead.";
    SUBAGENT_PREFIX = "You are a subagent working on one task for the main Zoi Code agent. Work autonomously with your tools, then reply with a concise final report containing everything the main agent needs: findings, file paths with line numbers, and conclusions. Nobody sees your intermediate messages, only the final report.\n\nTask:\n";
    Agent = class _Agent {
      llm;
      cwd;
      messages = [];
      systemPrompt = "";
      permissionMode;
      canUseTool;
      /** Asked when the model presents a plan in plan mode. Without it, headless runs just stop at the plan. */
      onPlan;
      /** Progress reports from long-running tools (e.g. what a subagent is doing). */
      onProgress;
      /** Rules granted with "always allow": a tool name, "Bash(<program>)" or "WebFetch(<host>)". */
      allowRules = /* @__PURE__ */ new Set();
      totalUsage = { promptTokens: 0, completionTokens: 0 };
      /** Prompt tokens of the most recent request, i.e. how full the context is. */
      contextTokens = 0;
      ctx;
      maxSteps;
      isSubagent;
      /** Characters of history when contextTokens was measured, the base of estimateContextTokens(). */
      measuredChars = 0;
      /** Set when the user rejects a tool call: the rest of the turn is skipped so they can say what to do instead. */
      rejected = false;
      constructor(opts) {
        this.llm = opts.llm;
        this.cwd = opts.cwd;
        this.permissionMode = opts.permissionMode ?? "default";
        this.canUseTool = opts.canUseTool;
        this.maxSteps = opts.maxSteps ?? 100;
        this.isSubagent = !!opts.isSubagent;
        this.ctx = { cwd: opts.cwd, readFiles: /* @__PURE__ */ new Map(), state: {} };
        if (!this.isSubagent) this.ctx.runSubagent = (description, prompt, progress) => this.runSubagent(prompt, progress);
        this.refreshSystemPrompt();
      }
      refreshSystemPrompt() {
        this.systemPrompt = buildSystemPrompt(this.cwd, loadMemory(this.cwd));
      }
      clear() {
        this.messages = [];
        this.contextTokens = 0;
        this.measuredChars = 0;
        this.ctx.readFiles.clear();
        this.ctx.state = {};
        this.refreshSystemPrompt();
      }
      /** The tools offered to the model in the current mode. */
      tools() {
        const tools = this.isSubagent ? ALL_TOOLS.filter((t) => t.name !== "Task") : ALL_TOOLS;
        if (this.permissionMode !== "plan") return tools;
        return [...tools.filter((t) => t.readOnly || PLAN_TOOLS.has(t.name)), ...this.isSubagent ? [] : [ExitPlanModeTool]];
      }
      /** Rough size of the next request in tokens: the last measured usage plus ~3 characters per token added since. */
      estimateContextTokens() {
        return this.contextTokens + Math.max(0, Math.ceil((this.historyChars() - this.measuredChars) / 3));
      }
      historyChars() {
        let chars = this.systemPrompt.length;
        for (const m of this.messages) {
          if (typeof m.content === "string") chars += m.content.length;
          if (m.role === "assistant") {
            for (const c of m.tool_calls ?? []) if ("function" in c) chars += c.function.arguments.length;
          }
        }
        return chars;
      }
      /**
       * The rules an "always" answer stores for this call; empty when it can only be allowed once. A Bash
       * rule names the program (and the subcommand, for tools like git and npm), and only ever covers one
       * plain command of it that runs no other program (see bashRule).
       */
      alwaysRules(tool, input) {
        if (tool.name === "Bash") {
          const rule = bashRule(String(input?.command ?? ""), shellCwd(this.ctx));
          return rule ? [`Bash(${rule})`] : [];
        }
        if (tool.name === "WebFetch") {
          try {
            return [`WebFetch(${new URL(input?.url).hostname})`];
          } catch {
            return [];
          }
        }
        return [tool.name];
      }
      /**
       * Whether a Write/Edit target lies inside the project once symlinks are followed, and outside the
       * folders whose files make programs run later: .git (hooks, config) and the custom commands in
       * .zoicode and .claude. Auto-accepted edits and Edit/Write rules only cover such a target.
       */
      inProject(file) {
        if (typeof file !== "string") return false;
        const abs = resolvePath(this.ctx, file);
        return isInsideDir(this.cwd, abs) && ![".git", ".zoicode", ".claude"].some((d) => isInsideDir(path9.join(this.cwd, d), abs)) && !abs.split(path9.sep).includes(".git");
      }
      /**
       * Whether Read, LS, Glob or Grep would read inside a credential folder (see secrets.ts). Searches
       * skip the ones under the folder they search, so only a path or pattern inside one counts.
       */
      readsSecrets(tool, input) {
        if (!["Read", "LS", "Glob", "Grep"].includes(tool.name)) return false;
        const str = (v) => typeof v === "string" && v ? v : void 0;
        if (tool.name === "Read") return !!str(input?.file_path) && inSecrets(resolvePath(this.ctx, input.file_path));
        const base = resolvePath(this.ctx, str(input?.path) ?? ".");
        const pattern = tool.name === "Glob" ? str(input?.pattern) : tool.name === "Grep" ? str(input?.glob) : void 0;
        return inSecrets(base) || !!pattern && inSecrets(path9.resolve(base, fixedPrefix(pattern)));
      }
      async permitted(tool, input) {
        if (this.permissionMode === "bypass") return true;
        const secret = this.readsSecrets(tool, input);
        if (tool.readOnly && !secret) return true;
        if (this.permissionMode === "acceptEdits" && EDIT_TOOLS.has(tool.name) && this.inProject(input.file_path)) return true;
        if (tool.isSafe?.(input, this.ctx)) return true;
        const rules = secret ? [] : this.alwaysRules(tool, input);
        const coverable = tool.name === "Bash" ? isSimpleCommand(String(input.command)) : !EDIT_TOOLS.has(tool.name) || this.inProject(input.file_path);
        if (coverable && rules.length && rules.every((r) => this.allowRules.has(r))) return true;
        if (!this.canUseTool) return false;
        const answer = await this.canUseTool(tool, input, rules);
        if (answer === "deny") {
          this.rejected = true;
          return false;
        }
        if (answer === "always") for (const r of rules) this.allowRules.add(r);
        return true;
      }
      /** Runs a child agent with a fresh context and returns its final report. */
      async runSubagent(prompt, progress) {
        const child = new _Agent({
          llm: this.llm,
          cwd: this.cwd,
          permissionMode: this.permissionMode,
          // With nobody to ask (headless), the child denies on its own, as the parent does, instead of stopping.
          canUseTool: this.canUseTool && ((tool, input, rules) => this.canUseTool(tool, input, rules)),
          isSubagent: true,
          maxSteps: 50
        });
        child.allowRules = this.allowRules;
        let text = "";
        let toolUses = 0;
        try {
          for await (const ev of child.run(SUBAGENT_PREFIX + prompt, this.ctx.signal)) {
            if (ev.type === "tool_start") {
              toolUses++;
              progress(`${ev.name}(${ev.label.length > 60 ? ev.label.slice(0, 57) + "\u2026" : ev.label})`);
            } else if (ev.type === "assistant" && ev.text.trim()) {
              text = ev.text.trim();
            } else if (ev.type === "error") {
              text = text ? `${text}

(Subagent stopped early: ${ev.message})` : `Subagent error: ${ev.message}`;
            }
          }
        } finally {
          this.totalUsage.promptTokens += child.totalUsage.promptTokens;
          this.totalUsage.completionTokens += child.totalUsage.completionTokens;
        }
        if (child.rejected) {
          this.rejected = true;
          text = "(Subagent stopped: the user rejected one of its tool calls.)";
        }
        return { text, toolUses };
      }
      /** Executes one tool call with checked arguments, including permission checks and the plan-mode rules. */
      async execute(tool, name, input) {
        if (!tool) {
          return { result: { output: `Unknown tool "${name}". Available: ${this.tools().map((t) => t.name).join(", ")}`, isError: true } };
        }
        if (tool.name === "ExitPlanMode") {
          if (this.permissionMode !== "plan") return { result: { output: "Plan mode is not active; go ahead with the task." } };
          if (!this.onPlan) {
            return { result: { output: "Plan recorded. This session is non-interactive: stop here and give the plan as your final answer.", summary: "Plan presented" } };
          }
          const answer = await this.onPlan(String(input.plan ?? ""));
          if (answer === "keep") {
            return { result: { output: "The user wants to keep planning. Ask what they would like to change, then present a revised plan.", summary: "Kept planning" } };
          }
          this.permissionMode = answer;
          return {
            result: {
              output: `The user approved the plan and turned plan mode off (${answer === "acceptEdits" ? "file edits are auto-accepted" : "each edit needs approval"}). Implement the plan now, keeping a TodoWrite list.`,
              summary: "Plan approved"
            }
          };
        }
        const allowedInPlan = tool.readOnly || tool.name === "WebFetch" || tool.name === "Bash" && tool.isSafe?.(input, this.ctx);
        if (this.permissionMode === "plan" && !allowedInPlan) {
          return {
            result: {
              output: `Plan mode is active, so ${tool.name} is not allowed (only read-only tools and read-only commands). Finish researching and present your plan with ExitPlanMode.`,
              isError: true
            }
          };
        }
        if (!await this.permitted(tool, input)) {
          const output = this.rejected ? "The user rejected this tool call and stopped the turn. Do not retry it; wait for their instructions." : "The user denied this tool call. Do not retry it; ask the user how to proceed.";
          return { denied: true, result: { output, isError: true } };
        }
        try {
          return { result: await tool.run(input, this.ctx) };
        } catch (e) {
          return { result: { output: `Error: ${e.message}`, isError: true } };
        }
      }
      /** Describes a failed request. One whose prompt no longer fits also marks the context as full. */
      requestError(e) {
        const message = String(e?.message ?? e);
        const status = e?.status;
        const window = this.llm.config.contextWindow;
        const tooLong = (status === 400 || status === 413) && (/context length|context window|too long|exceed/i.test(message) || this.estimateContextTokens() > window * 0.9);
        if (!tooLong) return message;
        this.contextTokens = Math.max(this.estimateContextTokens(), window || 0);
        this.measuredChars = this.historyChars();
        return `${message} The conversation no longer fits in the context window: compact it (/compact) or start over (/clear).`;
      }
      /** Runs the agent loop for one user message until the model stops calling tools. */
      async *run(userText, signal) {
        repairHistory(this.messages);
        const text = truncate(userText, MAX_PROMPT_CHARS);
        const content = this.permissionMode === "plan" ? `${text}

<system-reminder>${PLAN_REMINDER}</system-reminder>` : text;
        this.messages.push({ role: "user", content });
        this.ctx.signal = signal;
        this.rejected = false;
        for (let step = 0; step < this.maxSteps; step++) {
          let done;
          const partial = { text: "", reasoning: "" };
          try {
            const msgs = [{ role: "system", content: this.systemPrompt }, ...this.messages];
            for await (const ev of this.llm.stream(msgs, toolSpecs(this.tools()), signal)) {
              if (ev.type === "reasoning" || ev.type === "text") {
                partial[ev.type] += ev.delta;
                yield ev;
              } else if (ev.type === "done") done = ev;
            }
          } catch (e) {
            if (signal?.aborted) {
              if (partial.text.trim()) {
                this.messages.push({ role: "assistant", content: partial.text });
                yield { type: "assistant", text: partial.text, reasoning: partial.reasoning };
              }
              yield { type: "interrupted" };
              return;
            }
            yield { type: "error", message: this.requestError(e) };
            return;
          }
          if (!done) return;
          if (done.usage) {
            this.totalUsage.promptTokens += done.usage.promptTokens;
            this.totalUsage.completionTokens += done.usage.completionTokens;
            this.contextTokens = done.usage.promptTokens + done.usage.completionTokens;
            this.measuredChars = this.historyChars();
            yield { type: "usage", usage: done.usage, total: { ...this.totalUsage } };
          }
          const cutOff = cutOffReason(done.finishReason);
          const calls = done.toolCalls.map((call) => prepareCall(call, cutOff));
          this.messages.push({
            role: "assistant",
            content: done.text || null,
            ...calls.length && {
              tool_calls: calls.map((c) => ({ id: c.call.id, type: "function", function: { name: c.call.name, arguments: JSON.stringify(c.input) } }))
            }
          });
          yield { type: "assistant", text: done.text, reasoning: done.reasoning };
          if (!calls.length) {
            if (cutOff) yield { type: "error", message: `The reply was cut off (${cutOff}).` };
            return;
          }
          for (const { call, tool, input, error } of calls) {
            yield { type: "tool_start", id: call.id, name: tool?.name ?? call.name, input, label: tool ? safeLabel(tool, input) : call.name };
            this.ctx.progress = (message) => this.onProgress?.(call.id, message);
            let outcome;
            if (signal?.aborted) outcome = { result: { output: "Interrupted by user", isError: true } };
            else if (this.rejected) outcome = { result: { output: "Not run: the user rejected an earlier tool call in this turn.", isError: true } };
            else if (error) outcome = { result: { output: error, isError: true } };
            else {
              try {
                outcome = await this.execute(tool, call.name, input);
              } catch (e) {
                outcome = { result: { output: `Error: ${e.message}`, isError: true } };
              }
            }
            this.ctx.progress = void 0;
            const { result, denied } = outcome;
            this.messages.push({ role: "tool", tool_call_id: call.id, content: truncate(String(result.output), MAX_RESULT_CHARS) });
            yield { type: "tool_end", id: call.id, name: tool?.name ?? call.name, result, denied };
          }
          if (signal?.aborted || this.rejected) {
            yield { type: "interrupted" };
            return;
          }
        }
        yield { type: "error", message: `Stopped after ${this.maxSteps} steps.` };
      }
      /**
       * Replaces the conversation with a model-written summary to free up context. Throws and keeps the
       * conversation when there is no usable summary: interrupted, cut off, empty, or not a summary at all.
       */
      async compact(instructions = "", signal) {
        if (!this.messages.length) return "";
        const transcript = this.messages.map((m) => {
          if (m.role === "tool") return `[tool result]
${String(m.content).slice(0, 2e3)}`;
          const calls = "tool_calls" in m && m.tool_calls ? "\n" + m.tool_calls.map((c) => "function" in c ? `[tool call] ${c.function.name} ${c.function.arguments.slice(0, 500)}` : "").join("\n") : "";
          return `[${m.role}]
${typeof m.content === "string" ? truncate(m.content, 1e4) : ""}${calls}`;
        }).join("\n\n");
        let done;
        for await (const ev of this.llm.stream(
          [
            {
              role: "system",
              content: "You summarize coding sessions so the work can continue in a fresh context. Write a dense summary with: the user's goals and requests, key decisions, files read and changed (with paths), current state, errors and how they were fixed, and pending next steps." + (instructions ? `
Focus: ${instructions}` : "")
            },
            {
              role: "user",
              // Fenced, with the request after it: given the bare transcript, the model tends to continue it.
              content: `<transcript>
${truncate(transcript, 4e5)}
</transcript>

The transcript above is complete and is only material to summarize. Do not continue it, do not act as the assistant, and do not write tool calls. Write the summary now.`
            }
          ],
          [],
          signal
        )) {
          if (ev.type === "done") done = ev;
        }
        const summary = done?.text.trim() ?? "";
        const cutOff = cutOffReason(done?.finishReason ?? "");
        if (cutOff) throw new Error(`the summary was cut off (${cutOff})`);
        if (!summary) throw new Error("the summary came back empty");
        if (/^(\[(user|assistant|tool call|tool result)\]|<tool_call>)/m.test(summary)) {
          throw new Error("the model continued the conversation instead of summarizing it");
        }
        this.messages = [
          { role: "user", content: `This session continues from an earlier conversation that was compacted. Summary:

${summary}` },
          { role: "assistant", content: "Understood. I have the context from the summary and will continue from there." }
        ];
        this.contextTokens = 0;
        this.measuredChars = 0;
        this.ctx.readFiles.clear();
        return summary;
      }
    };
    article = (word) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
  }
});

// src/ui/sanitize.ts
function clean(s, strict) {
  return String(s).replace(ESCAPE_SEQUENCE, "").replace(CONTROL, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 ? String.fromCharCode(9216 + code) : code === 127 ? "\u2421" : "\uFFFD";
  }).replace(FORMAT, (ch) => {
    const cp = ch.codePointAt(0);
    if (!strict && (EVERYDAY_FORMAT.has(cp) || cp >= 917536 && cp <= 917631)) return ch;
    return `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;
  });
}
function sanitize(s) {
  return clean(s, false);
}
function sanitizeStrict(s) {
  return clean(s, true);
}
var ESCAPE_SEQUENCE, CONTROL, FORMAT, EVERYDAY_FORMAT;
var init_sanitize = __esm({
  "src/ui/sanitize.ts"() {
    "use strict";
    ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[@-Z\\-_]|$)/g;
    CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
    FORMAT = /[\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
    EVERYDAY_FORMAT = /* @__PURE__ */ new Set([173, 8204, 8205, 8206, 8207, 1564]);
  }
});

// src/sessions.ts
import fs8 from "node:fs";
import path10 from "node:path";
import crypto from "node:crypto";
function projectDir(cwd) {
  return path10.join(CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
function newSession(cwd) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  return { id: crypto.randomUUID().slice(0, 8), cwd, createdAt: now, updatedAt: now, title: "", messages: [] };
}
function saveSession(s) {
  if (!s.messages.length) return;
  const dir = projectDir(s.cwd);
  for (const d of [CONFIG_DIR, path10.dirname(dir), dir]) {
    fs8.mkdirSync(d, { recursive: true, mode: 448 });
    fs8.chmodSync(d, 448);
  }
  if (!tightened.has(dir)) {
    tightened.add(dir);
    for (const f of fs8.readdirSync(dir)) if (f.endsWith(".json")) fs8.chmodSync(path10.join(dir, f), 384);
  }
  s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (!s.title) {
    const first = s.messages.find((m) => m.role === "user" && typeof m.content === "string");
    s.title = String(first?.content ?? "").split("\n")[0].slice(0, 80);
  }
  const file = path10.join(dir, `${s.id}.json`);
  fs8.writeFileSync(file, JSON.stringify(s), { mode: 384 });
  fs8.chmodSync(file, 384);
}
function listSessions(cwd) {
  const dir = projectDir(cwd);
  if (!fs8.existsSync(dir)) return [];
  return fs8.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      return JSON.parse(fs8.readFileSync(path10.join(dir, f), "utf8"));
    } catch {
      return null;
    }
  }).filter((s) => !!s).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function loadSession(cwd, id) {
  return listSessions(cwd).find((s) => s.id === id || s.id.startsWith(id));
}
function resolveSession(cwd, continueLast, resume) {
  if (continueLast) return listSessions(cwd)[0] ?? newSession(cwd);
  if (typeof resume === "string") return loadSession(cwd, resume);
  return newSession(cwd);
}
var tightened;
var init_sessions = __esm({
  "src/sessions.ts"() {
    "use strict";
    init_config();
    tightened = /* @__PURE__ */ new Set();
  }
});

// src/setup.ts
var setup_exports = {};
__export(setup_exports, {
  runSetup: () => runSetup,
  saveCredentials: () => saveCredentials
});
import fs9 from "node:fs";
import path11 from "node:path";
import chalk2 from "chalk";
function askSecret(question) {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let value = "";
  return new Promise((resolve) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (ch === "") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\x7F" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          process.stdout.write("\u2022");
        }
      }
    };
    stdin.on("data", onData);
  });
}
function readKeyFromStdin() {
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      stdin.off("data", onData).off("end", done).off("error", done);
      stdin.destroy();
      resolve(data.trim().split(/\r?\n/)[0].trim());
    };
    const onData = (chunk) => {
      data += chunk;
      if (/\S[^\n]*\n/.test(data)) done();
    };
    stdin.on("data", onData).once("end", done).once("error", done);
    stdin.resume();
  });
}
function saveCredentials(values) {
  const file = path11.join(CONFIG_DIR, ".env");
  const existing = fs9.existsSync(file) ? fs9.readFileSync(file, "utf8") : "";
  const lines = existing.split("\n").filter((l) => {
    const key = parseDotEnvLine(l)?.[0];
    return l.trim() && !(key && key in values);
  });
  for (const [k, v] of Object.entries(values)) lines.push(`${k}=${v}`);
  fs9.mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  fs9.writeFileSync(file, lines.join("\n") + "\n", { mode: 384 });
  fs9.chmodSync(file, 384);
  return file;
}
async function checkAndSave(key) {
  const llm = new LLM(loadConfig({ apiKey: key }));
  process.stdout.write(dim("Checking the key\u2026 "));
  let models;
  try {
    models = await llm.listModels();
  } catch (e) {
    console.log(berry(`\u2717 ${sanitize(e.message)}`));
    return false;
  }
  console.log(grass(`\u2713 works! (${models.length} model${models.length === 1 ? "" : "s"} available)`));
  const shadow = process.env.RAON_API_KEY === key ? void 0 : envSource("RAON_API_KEY");
  process.env.RAON_API_KEY = key;
  let file;
  try {
    file = saveCredentials({ RAON_API_KEY: key });
  } catch (e) {
    console.log(berry(`\u26A0 The key works but could not be saved: ${sanitize(e.message)}`));
    console.log(dim("It is used for this run only. Export RAON_API_KEY to keep it.\n"));
    return true;
  }
  console.log(dim(`Saved to ${file}
`));
  if (shadow === "environment") {
    console.log(berry(`\u26A0 Your environment also sets RAON_API_KEY, and it wins over ${file}.`));
    console.log(dim("Unset or update it, or the next start will still use the old key.\n"));
  } else if (shadow && shadow !== file) {
    console.log(berry(`\u26A0 ${shadow} also sets RAON_API_KEY and is read first.`));
    console.log(dim("Remove or update that line, or the next start will still use the old key.\n"));
  }
  return true;
}
async function runSetup() {
  if (!process.stdin.isTTY) {
    const key = await readKeyFromStdin();
    if (!key) {
      console.error(berry('No API key given. Run zoicode --setup in a terminal, pipe the key in (echo "$KEY" | zoicode --setup), or export RAON_API_KEY.'));
      process.exit(1);
    }
    if (!await checkAndSave(key)) process.exit(1);
    return;
  }
  console.log(`
${gold.bold("Welcome to Zoi Code!")} ${dim("Let's get you set up.")}
`);
  console.log(dim("Zoi Code talks to the Raon API. Paste your API key below; it is saved to"));
  console.log(dim(`${path11.join(CONFIG_DIR, ".env")} (readable only by you).`));
  console.log(dim(`No key yet? Get one at ${RAON_SITE}
`));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await askSecret(gold("Raon API key: "));
    if (!key) {
      console.log(berry("No key entered."));
      continue;
    }
    if (await checkAndSave(key)) return;
  }
  console.log(berry(`
Setup failed. You can also export RAON_API_KEY, or put RAON_API_KEY=<key> in ${path11.join(CONFIG_DIR, ".env")}.`));
  console.log(dim("(A .env file in your project is never read.)"));
  process.exit(1);
}
var gold, dim, berry, grass, RAON_SITE;
var init_setup = __esm({
  "src/setup.ts"() {
    "use strict";
    init_config();
    init_llm();
    init_sanitize();
    gold = chalk2.hex("#F7C548");
    dim = chalk2.hex("#8C7A6B");
    berry = chalk2.hex("#D9466A");
    grass = chalk2.hex("#7BC043");
    RAON_SITE = "https://raon-mini.krafton.ai/en";
  }
});

// src/ui/catAnim.ts
import { useEffect, useState } from "react";
function pickAction(mood) {
  const options = ACTIONS.filter((a) => !a.idleOnly || mood === "idle");
  let r = Math.random() * options.reduce((s, a) => s + a.weight, 0);
  for (const a of options) {
    r -= a.weight;
    if (r <= 0) return a.steps();
  }
  return options[0].steps();
}
function fidget(mood, onFrame) {
  const base = BASE[mood];
  onFrame(base);
  if (mood !== "idle" && mood !== "working") return () => {
  };
  let timer;
  let cancelled = false;
  const schedule = () => {
    const [lo, hi] = mood === "working" ? [2500, 5e3] : [3500, 8500];
    timer = setTimeout(play, lo + Math.random() * (hi - lo));
  };
  const play = () => {
    const steps = pickAction(mood);
    let i = 0;
    const next = () => {
      if (cancelled) return;
      if (i >= steps.length) {
        onFrame(base);
        return schedule();
      }
      const [f, ms] = steps[i++];
      onFrame(f);
      timer = setTimeout(next, ms);
    };
    next();
  };
  schedule();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
function useCatFrame(mood) {
  const [frame, setFrame] = useState(BASE[mood]);
  useEffect(() => fidget(mood, setFrame), [mood]);
  return frame;
}
function catJourney(t, home, dest) {
  const J = JOURNEY;
  if (t < J.notice) return { frame: "twitch", x: home.x, y: home.y };
  t -= J.notice;
  if (t < J.crouch) return { frame: "half", x: home.x, y: home.y + 1 };
  t -= J.crouch;
  if (t < J.hop) {
    const p = t / J.hop;
    const x = home.x + (dest.x - home.x) * ease(p);
    const y = home.y + (dest.y - home.y) * p * p - 8 * Math.sin(Math.PI * Math.min(1, p * 1.3));
    return { frame: "open", x, y };
  }
  t -= J.hop;
  if (t < J.land) return { frame: "half", x: dest.x, y: dest.y + 1 };
  t -= J.land;
  if (t < J.settle) return { frame: "closed", x: dest.x, y: dest.y };
  return { frame: "open", x: dest.x, y: dest.y };
}
var BASE, ACTIONS, ease, JOURNEY, JOURNEY_MS;
var init_catAnim = __esm({
  "src/ui/catAnim.ts"() {
    "use strict";
    BASE = {
      idle: "open",
      working: "open",
      alert: "twitch",
      // tail up: listening
      happy: "closed",
      // content
      sad: "half"
    };
    ACTIONS = [
      // a quick blink
      { weight: 42, steps: () => [["half", 70], ["closed", 110], ["half", 70]] },
      // a double blink
      { weight: 10, steps: () => [["half", 60], ["closed", 90], ["half", 60], ["open", 170], ["half", 60], ["closed", 90], ["half", 60]] },
      // a slow, content blink (a cat's "I like you")
      { weight: 14, idleOnly: true, steps: () => [["half", 200], ["closed", 1400], ["half", 240]] },
      // a tail flick
      { weight: 34, steps: () => [["twitch", 260], ["open", 180], ["twitch", 220]] }
    ];
    ease = (p) => p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    JOURNEY = { notice: 220, crouch: 160, hop: 720, land: 110, settle: 520 };
    JOURNEY_MS = Object.values(JOURNEY).reduce((a, b) => a + b, 0);
  }
});

// src/ui/pixels.ts
import chalk3 from "chalk";
function renderGrid(grid) {
  const lines = [];
  const width = Math.max(...grid.map((r) => r.length));
  for (let y = 0; y < grid.length; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = grid[y]?.[x] ?? null;
      const bot = grid[y + 1]?.[x] ?? null;
      if (!top && !bot) line += " ";
      else if (top && !bot) line += chalk3.hex(top)("\u2580");
      else if (!top && bot) line += chalk3.hex(bot)("\u2584");
      else if (top === bot) line += chalk3.hex(top)("\u2588");
      else line += chalk3.hex(top).bgHex(bot)("\u2580");
    }
    lines.push(line);
  }
  return lines;
}
var init_pixels = __esm({
  "src/ui/pixels.ts"() {
    "use strict";
  }
});

// src/ui/canvas.ts
import chalk4, { Chalk } from "chalk";
function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map((s) => Math.round((pa >> s & 255) + ((pb >> s & 255) - (pa >> s & 255)) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
var ink, Paint;
var init_canvas = __esm({
  "src/ui/canvas.ts"() {
    "use strict";
    ink = chalk4.level > 0 || process.env.NO_COLOR ? chalk4 : new Chalk({ level: 3 });
    Paint = class _Paint {
      constructor(w, h) {
        this.w = w;
        this.h = h;
        this.px = new Array(w * h * 2).fill(null);
        this.txt = new Array(w * h).fill(null);
      }
      w;
      h;
      px;
      txt;
      /** A copy, for drawing per-frame details over a cached background. */
      clone() {
        const p = new _Paint(this.w, this.h);
        for (let i = 0; i < this.px.length; i++) p.px[i] = this.px[i];
        for (let i = 0; i < this.txt.length; i++) p.txt[i] = this.txt[i];
        return p;
      }
      pixel(x, y, c) {
        x = Math.round(x);
        y = Math.round(y);
        if (x >= 0 && x < this.w && y >= 0 && y < this.h * 2) this.px[y * this.w + x] = c;
      }
      rect(x, y, w, h, c) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.pixel(xx, yy, c);
      }
      /** Draws a pixel grid at (x, y); transparent pixels leave what is below. */
      blit(grid, x, y) {
        x = Math.round(x);
        y = Math.round(y);
        grid.forEach((row, gy) => row.forEach((c, gx) => c && this.pixel(x + gx, y + gy, c)));
      }
      /** Writes text at cell (x, row). Characters must be single-width. */
      text(x, row, s, style) {
        let i = 0;
        for (const ch of s) {
          const cx = x + i++;
          if (cx >= 0 && cx < this.w && row >= 0 && row < this.h) this.txt[row * this.w + cx] = { ch, ...style };
        }
      }
      /** Clears text cells in a region (e.g. before redrawing a menu). */
      clearText(x, row, w, h) {
        for (let r = row; r < row + h; r++) for (let cx = x; cx < x + w; cx++) if (cx >= 0 && cx < this.w && r >= 0 && r < this.h) this.txt[r * this.w + cx] = null;
      }
      lines() {
        const out = [];
        for (let row = 0; row < this.h; row++) {
          let line = "";
          let run = "";
          let key = "";
          let style = null;
          const flush = () => {
            if (run) line += style ? style(run) : run;
            run = "";
          };
          for (let x = 0; x < this.w; x++) {
            const top = this.px[row * 2 * this.w + x];
            const bot = this.px[(row * 2 + 1) * this.w + x];
            const t = this.txt[row * this.w + x];
            let ch;
            let fg;
            let bg;
            let bold = false;
            if (t) {
              ch = t.ch;
              fg = t.fg;
              bg = t.bg ?? top ?? bot ?? void 0;
              bold = !!t.bold;
            } else if (!top && !bot) {
              ch = " ";
            } else if (top === bot) {
              ch = " ";
              bg = top;
            } else if (top && !bot) {
              ch = "\u2580";
              fg = top;
            } else if (!top && bot) {
              ch = "\u2584";
              fg = bot;
            } else {
              ch = "\u2580";
              fg = top;
              bg = bot;
            }
            const k = `${fg ?? ""}|${bg ?? ""}|${bold ? 1 : 0}`;
            if (k !== key) {
              flush();
              key = k;
              let s = ink;
              if (fg) s = s.hex(fg);
              if (bg) s = s.bgHex(bg);
              if (bold) s = s.bold;
              style = fg || bg || bold ? s : null;
            }
            run += ch;
          }
          flush();
          out.push(line);
        }
        return out;
      }
    };
  }
});

// src/ui/sprites/cat.ts
var cat;
var init_cat = __esm({
  "src/ui/sprites/cat.ts"() {
    "use strict";
    cat = {
      name: "cat",
      width: 32,
      height: 42,
      palette: { a: "#FCF7EB", b: "#E9D8C2", c: "#A59091", d: "#3A2834", e: "#7B646C", f: "#FCBCAF", g: "#F8E1D2", h: "#947E82", i: "#CDB698", j: "#BAA8A0", k: "#D1BFB3", l: "#D6777A", m: "#D9CABE", n: "#74B1ED", p: "#614C54", q: "#5F93C4", r: "#4A3741", s: "#262A3E" },
      frames: {
        open: [
          "................................",
          ".................dd.............",
          "................dccd............",
          "..d............dcccd............",
          ".dcdd.........dcccfcd...........",
          ".dcccd.......dccccffd...........",
          ".dfcccdd.ddddcccffffd...........",
          "dcffcccddbaabcccggffd...........",
          "dcfggccbbbaabbbcccgfcd..........",
          ".dfgccbbbaaaabbbbccfcd..........",
          ".dfccbbbcaaaabbbcbbcd...........",
          "..dcbbbccbaaacbccbbbd...........",
          "..dbbbbcccaaaccccmbbbdd.........",
          ".dbbbccddcbaaccddccbbdd.........",
          "dbbbbcdassbaabsasdckbddd........",
          ".dbbccdsssbaaasssdcckbbd........",
          ".dbccccnnbaaaacnnccckbp.........",
          "dbbccccccaallaaacccmaad.........",
          "ddbbccccaaapjaaaccaaad..........",
          ".daaaccaaaabbbaaabaaad..........",
          "..daaaabaaaaaaaabaaad...........",
          "...dbaaabbaaaaabaaad............",
          "....dbaaabbbbbbaabd.............",
          "....dbbaaabbbbaaabbd............",
          "...dbbaaaaaaaaaaaabdd...dd......",
          "...dbaaaaaaaaaaaaabbd..dmmd.....",
          "..dbbaaaaaaaaaaaaaabd..daadd....",
          "..dbcaabaaaaaaaabaad..daaaaad...",
          "...dcbabaaaaaaaabaacd.dbaaaabd..",
          "..dibbaabbaaaabbaabbd..dbaaagbd.",
          ".dbbbcaaaabaabaaaabbbd..dbaabbpd",
          ".dbabcbaaabbbbaaabbbabd.dcbbbjbd",
          ".paaabhaaabhbgaaahbaabd.dcbbccbd",
          ".paaaahaaabhbaaabhaaaajdccbccccd",
          ".daaaamhaabhhaaahbaaaabdcmccccd.",
          ".dgaagbhaaadhbaahbaaabbrccccccd.",
          ".dbaabbhbaadhaaadbbabbdccccced..",
          ".dbbbbbhdaadhaaadbbbbbdeccceed..",
          "..dbbbhdaaaadabaadbbbdeeeeeed...",
          "...dbbhdgaaadabagdbbdeeeeerd....",
          "....ddddbabbdbcabddd.ddddd......",
          "........dddd.dddd..............."
        ],
        twitch: [
          "................................",
          ".................dd.............",
          "................dccd............",
          "..d............dcccd............",
          ".dcdd.........dcccfcd...........",
          ".dcccd.......dccccffd...........",
          ".dfcccdd.ddddcccffffd...........",
          "dcffcccddbaabcccggffd...........",
          "dcfggccbbbaabbbcccgfcd..........",
          ".dfgccbbbaaaabbbbccfcd..........",
          ".dfccbbbcaaaabbbcbbcd...........",
          "..dcbbbccbaaacbccbbbd...........",
          "..dbbbbcccaaaccccmbbbdd.........",
          ".dbbbccddcbaaccddccbbdd.........",
          "dbbbbcdassbaabsasdckbddd........",
          ".dbbccdsssbaaasssdcckbbd........",
          ".dbccccnnbaaaacnnccckbp.........",
          "dbbccccccaallaaacccmaad.........",
          "ddbbccccaaapjaaaccaaad..........",
          ".daaaccaaaabbbaaabaaad..........",
          "..daaaabaaaaaaaabaaad...........",
          "...dbaaabbaaaaabaaad............",
          "....dbaaabbbbbbaabd.............",
          "....dbbaaabbbbaaabbd.....dd.....",
          "...dbbaaaaaaaaaaaabdd...daadd...",
          "...dbaaaaaaaaaaaaabbd..daaaar...",
          "..dbbaaaaaaaaaaaaaabd..daaaaad..",
          "..dbcaabaaaaaaaabaad...dbbaaad..",
          "...dcbabaaaaaaaabaacd...dbgaabd.",
          "..dibbaabbaaaabbaabbd...dbbaabd.",
          ".dbbbcaaaabaabaaaabbbd...dbbbbbd",
          ".dbabcbaaabbbbaaabbbabd..dcbbcbd",
          ".paaabhaaabhbgaaahbaabd.dccbccbd",
          ".paaaahaaabhbaaabhaaaajdccbccccd",
          ".daaaamhaabhhaaahbaaaabdcmccccd.",
          ".dgaagbhaaadhbaahbaaabbrccccccd.",
          ".dbaabbhbaadhaaadbbabbdccccced..",
          ".dbbbbbhdaadhaaadbbbbbdeccceed..",
          "..dbbbhdaaaadabaadbbbdeeeeeed...",
          "...dbbhdgaaadabagdbbdeeeeerd....",
          "....ddddbabbdbcabddd.ddddd......",
          "........dddd.dddd..............."
        ],
        half: [
          "................................",
          ".................dd.............",
          "................dccd............",
          "..d............dcccd............",
          ".dcdd.........dcccfcd...........",
          ".dcccd.......dccccffd...........",
          ".dfcccdd.ddddcccffffd...........",
          "dcffcccddbaabcccggffd...........",
          "dcfggccbbbaabbbcccgfcd..........",
          ".dfgccbbbaaaabbbbccfcd..........",
          ".dfccbbbcaaaabbbcbbcd...........",
          "..dcbbbccbaaacbccbbbd...........",
          "..dbbbbcccaaacccckbbbdd.........",
          ".dbbbcccccbaaccccccbbdd.........",
          "dbbbbcddddbaabddddcjbddd........",
          ".dbbccdssdbaaadssdccjbbd........",
          ".dbccccnnbaaaacnncccjbe.........",
          "dbbccccccaallaaacccjaad.........",
          "ddbbccccaaapeaaaccaaad..........",
          ".daaaccaaaabbbaaabaaad..........",
          "..daaaabaaaaaaaabaaad...........",
          "...dbaaabbaaaaabaaad............",
          "....dbaaabbbbbbaabd.............",
          "....dbbaaabbbbaaabbd............",
          "...dbbaaaaaaaaaaaabdd...dd......",
          "...dbaaaaaaaaaaaaabbd..dmmd.....",
          "..dbbaaaaaaaaaaaaaabd..daadd....",
          "..dbcaabaaaaaaaabaad..daaaaad...",
          "...dcbabaaaaaaaabaacd.dbaaaabd..",
          "..dibbaabbaaaabbaabbd..dbaaagbd.",
          ".dbbbcaaaabaabaaaabbbd..dbaabbpd",
          ".dbabcbaaabbbbaaabbbabd.dcbbbjbd",
          ".paaabhaaabhbgaaahbaabd.dcbbccbd",
          ".paaaahaaabhbaaabhaaaajdccbccccd",
          ".daaaamhaabhhaaahbaaaabdcmccccd.",
          ".dgaagbhaaadhbaahbaaabbrccccccd.",
          ".dbaabbhbaadhaaadbbabbdccccced..",
          ".dbbbbbhdaadhaaadbbbbbdeccceed..",
          "..dbbbhdaaaadabaadbbbdeeeeeed...",
          "...dbbhdgaaadabagdbbdeeeeerd....",
          "....ddddbabbdbcabddd.ddddd......",
          "........dddd.dddd..............."
        ],
        closed: [
          "................................",
          ".................dd.............",
          "................dccd............",
          "..d............dcccd............",
          ".dcdd.........dcccfcd...........",
          ".dcccd.......dccccffd...........",
          ".dfcccdd.ddddcccffffd...........",
          "dcffcccddbaabcccggffd...........",
          "dcfggccbbbaabbbcccgfcd..........",
          ".dfgccbbbaaaabbbbccfcd..........",
          ".dfccbbbcaaaabbbcbbcd...........",
          "..dcbbbccbaaacbccbbbd...........",
          "..dbbbbcccaaaccccmbbbdd.........",
          ".dbbbcccccbaaccccccbbdd.........",
          "dbbbbccddcbaabcddccjbddd........",
          ".dbbccdccdbaaadccdcckbbd........",
          ".dbccccccbaaaacccccckbr.........",
          "dbbccccccaallaaaccckaad.........",
          "ddbbccccaaapcaaaccaaad..........",
          ".daaaccaaaabbbaaabaaad..........",
          "..daaaabaaaaaaaabaaad...........",
          "...dbaaabbaaaaabaaad............",
          "....dbaaabbbbbbaabd.............",
          "....dbbaaabbbbaaabbd............",
          "...dbbaaaaaaaaaaaabdd...dd......",
          "...dbaaaaaaaaaaaaabbd..dmmd.....",
          "..dbbaaaaaaaaaaaaaabd..daadd....",
          "..dbcaabaaaaaaaabaad..daaaaad...",
          "...dcbabaaaaaaaabaacd.dbaaaabd..",
          "..dibbaabbaaaabbaabbd..dbaaagbd.",
          ".dbbbcaaaabaabaaaabbbd..dbaabbpd",
          ".dbabcbaaabbbbaaabbbabd.dcbbbjbd",
          ".paaabhaaabhbgaaahbaabd.dcbbccbd",
          ".paaaahaaabhbaaabhaaaajdccbccccd",
          ".daaaamhaabhhaaahbaaaabdcmccccd.",
          ".dgaagbhaaadhbaahbaaabbrccccccd.",
          ".dbaabbhbaadhaaadbbabbdccccced..",
          ".dbbbbbhdaadhaaadbbbbbdeccceed..",
          "..dbbbhdaaaadabaadbbbdeeeeeed...",
          "...dbbhdgaaadabagdbbdeeeeerd....",
          "....ddddbabbdbcabddd.ddddd......",
          "........dddd.dddd..............."
        ]
      }
    };
  }
});

// src/ui/sprites/computer.ts
var computer;
var init_computer = __esm({
  "src/ui/sprites/computer.ts"() {
    "use strict";
    computer = {
      name: "computer",
      width: 34,
      height: 24,
      palette: {
        O: "#7F7466",
        // monitor outline (warm taupe frame)
        H: "#F6F4F0",
        // bezel highlight
        M: "#DDD8D0",
        // bezel, light warm gray
        m: "#C4BDB2",
        // chin shade
        c: "#8F877B",
        // webcam
        L: "#7FD18A",
        // power led
        S: "#EAF1F8",
        // screen (code draws here)
        D: "#56524D",
        // stand
        o: "#6B645B",
        // keyboard outline
        Q: "#A39C91",
        // keyboard base
        q: "#8A8379",
        // keyboard front face
        K: "#F5F3EF",
        // keycap top
        J: "#D6D2CB",
        // keycap lower half
        k: "#7E8796",
        // keycap chrome rim
        G: "#D6AE4E"
        // gold rivet
      },
      frames: {
        main: [
          "..OOOOOOOOOOOOOOOOOOOOOOOOOOOOOO..",
          ".OHHHHHHHHHHHHHHccHHHHHHHHHHHHHHO.",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSMO",
          "OMMMMMMMMMMMMMMMMMMMMMMMMMMMMLMMMO",
          ".OmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmO.",
          "..OOOOOOOOODDDDDDDDDDDDOOOOOOOOO..",
          "..........DDDDDDDDDDDDDD..........",
          "..oooooooooooooooooooooooooooooo..",
          ".oQQKKQKKQKKQKKQKKQKKQKKQKKQKKQQo.",
          ".oQQkkGkkGkkGkkGkkGkkGkkGkkGkkQQo.",
          ".oQKKQKKQKKQKKQKKQKKQKKQKKQKKQKKo.",
          ".oQkkGkkGkkGkkGkkGkkGkkGkkGkkGkko.",
          "..oooooooooooooooooooooooooooooo.."
        ]
      }
    };
  }
});

// src/ui/sprites/logo.ts
var logo;
var init_logo = __esm({
  "src/ui/sprites/logo.ts"() {
    "use strict";
    logo = {
      name: "logo",
      width: 112,
      height: 24,
      palette: { a: "#FDF2D7", b: "#5BD7FC", c: "#2D1737", d: "#CCB7DF", e: "#898BDD", f: "#9EE6FC", g: "#6FBFF4", h: "#77DDFC", i: "#6E88DA", j: "#6A60A4", k: "#3E325B", l: "#E8D7DB" },
      frames: {
        main: [
          "...ccccccccccccccc................................cccccccc...............................ccccc..................",
          ".ccaaaaaaaaaaaaaacc.................cccccc.....ccckffffffccc............................ccffffc.................",
          ".caaaaaaaaaaaaaaaac................caaaaaac...ccffhbbbbbbffcc...........................cffbbbc.................",
          ".cdaaaaaaaaaaaaaadc................caaaaaac..ccffbbbbbbbbbhfcc..........................cfbbbbc.................",
          ".cddddddddddaaaaadc................cdaaaadc..cfhbbbbbbbbbbbhfc..........................cfbbbbc.................",
          ".ccdddddddddaaaaadc................cdlllddc..cfhbbbbggggbbbhhc..........................cfbbbbc.................",
          "..cccccccccaaaaadcc....ccccccc......cddddc..ccfbbbbbeeeebbbbbc....ccccccc.........cccccccfbbbbc....ccccccccc....",
          "........ccaaaaadcc...cccaaaaaccc....cccccc..cfbbbbbbccccebbbec..cccfffffccc.....cccfffffcfbbbbc..cccfffffffccc..",
          ".......ccaaaaaddc...ccaaaaaaaaacc..ccaaaacc.cbbbbbccc..cceeecc.ccffbbbbbffcc...ccffbbbbbffbbbbc..cffbbbbbbhffc..",
          "......ccaaaaaddcc..ccaaaaaaaaaaacc.caaaaaac.cbbbbbc.....ccccc.ccfhbbbbbbbbfcc.ccffbbbbbbbbbbbbc.ccfbbbbbbbbbffc.",
          ".....ccaaaaaddcc...caaaaaaaaaaaaac.caaaaaac.cbbbbbc...........cfhbbbbbbbbbbfc.cffbbbbbbbbbbbbbc.cfbbbeeeebbbbfcc",
          "....ccaaaaaadcc...ccaaaaadddaaaaacccaaaaaac.cbbbbbc..........ccfbbbbeeebbbbfcccfbbbbbeeebbbbbbcccfbbbecccbbbbbfc",
          "...ccaaaaaadcc....caaaaadcccdaaaaaccaaaaaac.cbbbbbc..........cfbbbbecccebbbbfcfbbbbbccccebbbbbccfbbbecccccbbbbbc",
          "..ccaaaaaadcc.....caaaaacc.ccaaaaaccaaaaaac.cbbbbbc..........cbbbbbcc.ccbbbbbcbbbbbcc..ccbbbbbccbbbbffffffbbbbbc",
          "..caaaaaaddc......caaaaac...caaaaaccaaaaaac.cbbbbbc.....ccccccbbbbbc...cbbbbbcbbbbbc....cbbbbbccbbbbbbbbbbbbbbec",
          ".caaaaaaldcc......caaaaac...caaaaaccaaaaaac.cbbbbbccc..ccfffccbbbbbc...cbbbbbcbbbbbc....cbbbbbccbbbbbgggggggggec",
          "ccaaaaaadcc.......caaaaacc.ccaaaaaccaaaaaac.cebbbbffccccfbbbfcbbbbbcc.ccbbbbbcbbbbbcc..ccbbbbbccbbbbeeeeeeeeeecc",
          "caaaaaadcccccccccccdaaaaacccaaaaadccaaaaaac.cebbbbbbffffbbbbbcebbbbfcccfbbbbecebbbbfccccfhbbbbccebbbccccccccccc.",
          "caaaaaaaaaaaaaaaaccdaaaaaaaaaaaaadccaaaaaac.ccbbbbbbbbbbbbbbicebbbbbfffbbbbbecebbbbbffffbbbbbbccebbbffccccffffcc",
          "cdaaaaaaaaaaaaaaaaccddaaaaaaaaaddcccdaaaadc..ceebbbbbbbbbbbekcceebbbbbbbbbeeccceebbbbbbbbbbbbbcccebbbbffffbbbbfc",
          "cddaaaaaaaaaaaaaadcccdddaaaaadddcc.cdaaaadc..cceeebbbbbbbeeec.cceebbbbbbeeecc.cceegbbbbeeebbbec.ceeebbbbbbbbeeec",
          "ccdddddddddddddddcc.ccdddddddddcc..cddddddc...cceeeeeeeeeeecc..cceeeeeeeeecc...cceeeeeeeeeeeeec.cceeeeeeeeeeeecc",
          ".cdddddddddddddddcc..cccdddddccc...ccddddcc....ccceeeeeeeccc....cceeeeeeccc.....ccjeeeeccceeecc..ccceeeeeeeccc..",
          ".ccccccccccccccccc.....ccccccc......cccccc.......ccccccccc.......cccccccc.........cccccc.ccccc.....ccccccccc...."
        ]
      }
    };
  }
});

// src/ui/sprites/types.ts
function sheetGrid(sheet, frame) {
  const rows = sheet.frames[frame] ?? sheet.frames[Object.keys(sheet.frames)[0]];
  return rows.map((r) => [...r].map((ch) => ch === "." ? null : sheet.palette[ch] ?? null));
}
function keyRect(sheet, frame, key) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  sheet.frames[frame]?.forEach(
    (r, y) => [...r].forEach((ch, x) => {
      if (ch !== key) return;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    })
  );
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
var init_types2 = __esm({
  "src/ui/sprites/types.ts"() {
    "use strict";
  }
});

// src/ui/sprites/index.ts
var CAT_W, CAT_H;
var init_sprites = __esm({
  "src/ui/sprites/index.ts"() {
    "use strict";
    init_cat();
    init_computer();
    init_logo();
    init_types2();
    init_types2();
    CAT_W = cat.width;
    CAT_H = cat.height;
  }
});

// src/ui/scene.ts
function sceneLayout(cols, rows) {
  const view = rows - 1;
  const deskTop = (TITLE_ROWS + 1 + PET_ROWS) * 2;
  const bannerRows = deskTop / 2 + 4;
  if (cols < logo.width + 4 || view < bannerRows + 1) return null;
  const home = { x: cols - CAT_W - Math.max(6, Math.floor((cols - logo.width) / 2) + 4), y: deskTop + 2 - CAT_H };
  const comp = { x: Math.max(MENU_WIDTH + 8, home.x - computer.width - 10), y: deskTop + 4 - computer.height };
  const s = keyRect(computer, "main", "S") ?? { x: 4, y: 3, w: 26, h: 12 };
  const worldRows = bannerRows + LIVE_ROWS;
  return {
    cols,
    rows,
    view,
    bannerRows,
    worldRows,
    startPan: 0,
    endPan: Math.max(0, worldRows - view),
    deskTop,
    home,
    dest: { x: cols - CAT_W - PET_MARGIN, y: bannerRows * 2 },
    comp,
    logo: { x: Math.floor((cols - logo.width) / 2), y: 2 },
    menu: { col: 4, row: TITLE_ROWS + 2, width: MENU_WIDTH },
    screen: { x: comp.x + s.x, y: comp.y + s.y, w: s.w, h: s.h }
  };
}
function seeded(seed) {
  return () => {
    seed = seed * 1103515245 + 12345 & 2147483647;
    return seed / 2147483647;
  };
}
function paintRoom(p, L) {
  const rand = seeded(7);
  const h = L.bannerRows * 2;
  for (let y = 0; y < L.deskTop; y++) {
    const color = y % 4 === 3 ? ROOM.seam : ROOM.plank[Math.floor(y / 4) % ROOM.plank.length];
    p.rect(0, y, L.cols, 1, color);
  }
  for (let i = 0; i < L.cols / 6; i++) p.pixel(Math.floor(rand() * L.cols), Math.floor(rand() * (L.deskTop / 4)) * 4 + 1, ROOM.nail);
  p.rect(0, L.deskTop, L.cols, 1, ROOM.deskEdge);
  p.rect(0, L.deskTop + 1, L.cols, 3, ROOM.deskTop);
  p.rect(0, L.deskTop + 4, L.cols, h - L.deskTop - 5, ROOM.desk);
  p.rect(0, h - 1, L.cols, 1, ROOM.deskDark);
}
function background(L) {
  const key = `${L.cols}x${L.rows}`;
  let p = roomCache.get(key);
  if (!p) {
    p = new Paint(L.cols, L.worldRows);
    paintRoom(p, L);
    p.blit(sheetGrid(computer, "main"), L.comp.x, L.comp.y);
    p.blit(sheetGrid(logo, "main"), L.logo.x, L.logo.y);
    roomCache.set(key, p);
  }
  return p;
}
function paintScreen(p, L, angle) {
  const { x, y, w, h } = L.screen;
  for (let yy = 0; yy < h; yy++) p.rect(x, y + yy, w, 1, mix("#2F5A3A", "#1F3B28", yy / h));
  const kw = MINI_K[0].length;
  const kh = MINI_K.length;
  const cos = Math.cos(angle);
  const cx = x + w / 2;
  const top = y + Math.round((h - kh) / 2);
  for (let ky = 0; ky < kh; ky++) {
    for (let kx = 0; kx < kw; kx++) {
      if (MINI_K[ky][kx] !== "#") continue;
      const px = cx + (kx - kw / 2 + 0.5) * cos;
      p.pixel(Math.floor(px), top + ky, cos >= 0 ? mix("#B8F28C", "#7BC043", ky / kh) : mix("#7BC043", "#4E8A2A", ky / kh));
    }
  }
  if (Math.abs(cos) < 0.25) p.rect(Math.round(cx) - 1, top, 1, kh, "#4E8A2A");
}
function paintMenu(p, L, items, selected) {
  let row = L.menu.row;
  const lastRow = Math.floor(L.deskTop / 2) - 1;
  const gap = items.length * 2 + items.filter((i) => i.section).length <= lastRow - row ? 1 : 0;
  items.forEach((item, i) => {
    if (item.section) p.text(L.menu.col + 1, row++, item.section, { fg: MENU.section, bold: true });
    const sel = i === selected;
    const w = L.menu.width - 2;
    p.rect(L.menu.col, row * 2, w, 2, sel ? MENU.plankSel : MENU.plank);
    p.rect(L.menu.col + 1, row * 2 + 2, w, 1, MENU.shadow);
    p.text(L.menu.col + 1, row, `${sel ? "\u25B6 " : "  "}${item.label}`.padEnd(w - 2), { fg: sel ? MENU.textSel : MENU.text, bold: sel });
    row += 1 + gap;
  });
}
function paintInfo(p, L, lines) {
  lines.forEach((l, i) => {
    const text = l.text.length > L.menu.width + 6 ? "\u2026" + l.text.slice(-(L.menu.width + 5)) : l.text;
    p.text(L.menu.col, L.menu.row + i, ` ${text} `, { fg: l.fg, bold: l.bold, bg: "#5E3218" });
  });
}
function paintPrompt(p, L) {
  const top = L.bannerRows + PET_ROWS;
  const w = L.cols;
  p.text(0, top, "\u256D" + "\u2500".repeat(w - 2) + "\u256E", { fg: PROMPT.border });
  p.text(0, top + 1, "\u2502", { fg: PROMPT.border });
  p.text(w - 1, top + 1, "\u2502", { fg: PROMPT.border });
  p.text(2, top + 1, "\u203A", { fg: PROMPT.glyph, bold: true });
  p.text(5, top + 1, "Type a request\u2026 (/ for commands, @ to mention files)", { fg: PROMPT.placeholder });
  p.text(0, top + 2, "\u2570" + "\u2500".repeat(w - 2) + "\u256F", { fg: PROMPT.border });
  p.text(2, top + 3, "? /help for commands", { fg: PROMPT.status });
}
function paintWorld(L, s) {
  const p = background(L).clone();
  paintScreen(p, L, s.screenAngle ?? 0);
  if (s.menu) paintMenu(p, L, s.menu.items, s.menu.selected);
  if (s.info) paintInfo(p, L, s.info);
  if (s.prompt) paintPrompt(p, L);
  if (s.cat) p.blit(sheetGrid(cat, s.cat.frame), s.cat.x, s.cat.y);
  return p;
}
function renderScene(L, s) {
  const p = paintWorld(L, s);
  const pan = Math.round(s.pan ?? L.startPan);
  if (s.hint) {
    const row = pan + L.view - 1;
    p.clearText(0, row, L.cols, 1);
    p.text(Math.max(0, Math.floor((L.cols - s.hint.length) / 2)), row, s.hint, { fg: "#F5DEB3", bold: true });
  }
  return p.lines().slice(pan, pan + L.view);
}
function renderBanner(L, info) {
  return paintWorld(L, { info, cat: null }).lines().slice(0, L.bannerRows);
}
var PET_ROWS, PROMPT_ROWS, LIVE_ROWS, PET_MARGIN, TITLE_ROWS, MENU_WIDTH, ROOM, roomCache, MINI_K, MENU, PROMPT;
var init_scene = __esm({
  "src/ui/scene.ts"() {
    "use strict";
    init_canvas();
    init_sprites();
    PET_ROWS = CAT_H / 2;
    PROMPT_ROWS = 3;
    LIVE_ROWS = PET_ROWS + PROMPT_ROWS + 1;
    PET_MARGIN = 2;
    TITLE_ROWS = logo.height / 2 + 2;
    MENU_WIDTH = 22;
    ROOM = {
      plank: ["#C9783A", "#BE6F33", "#D3843F"],
      seam: "#7A3F1C",
      nail: "#5C2E17",
      deskEdge: "#E39A55",
      deskTop: "#C47A3F",
      desk: "#9C5B2E",
      deskDark: "#5E3218"
    };
    roomCache = /* @__PURE__ */ new Map();
    MINI_K = ["##....##", "##...##.", "##..##..", "##.##...", "####....", "####....", "##.##...", "##..##..", "##...##.", "##....##"];
    MENU = { plank: "#E8B565", plankSel: "#F7D27A", text: "#4A2A12", textSel: "#3B1F0A", shadow: "#7A3F1C", section: "#FBE8B5" };
    PROMPT = { border: "#C08040", glyph: "#F7C548", placeholder: "#8C7A6B", status: "#8C7A6B" };
  }
});

// src/ui/theme.ts
import chalk5 from "chalk";
var C, paint, SPINNER_VERBS, SPINNER_FRAMES;
var init_theme = __esm({
  "src/ui/theme.ts"() {
    "use strict";
    C = {
      wood: "#8B5A2B",
      woodDark: "#5C3A1A",
      woodLight: "#C08040",
      parchment: "#F5DEB3",
      gold: "#F7C548",
      goldLight: "#FFE680",
      grass: "#7BC043",
      sky: "#6EC1F0",
      berry: "#D9466A",
      purple: "#A06CD5",
      stone: "#9A8F86",
      dim: "#8C7A6B"
    };
    paint = {
      wood: chalk5.hex(C.wood),
      gold: chalk5.hex(C.gold),
      grass: chalk5.hex(C.grass),
      dim: chalk5.hex(C.dim)
    };
    SPINNER_VERBS = [
      "Thinking",
      "Pondering",
      "Purring",
      "Tinkering",
      "Brewing coffee",
      "Untangling yarn",
      "Chasing bugs",
      "Kneading the code",
      "Sniffing around",
      "Scheming",
      "Doodling",
      "Batting at bugs",
      "Stretching",
      "Mulling it over",
      "Connecting the dots",
      "Polishing",
      "Napping on the keyboard",
      "Chasing the cursor"
    ];
    SPINNER_FRAMES = ["\xB7", "\u2058", "\u2722", "\u273F", "\u2740", "\u273F", "\u2722", "\u2058"];
  }
});

// src/ui/Cat.tsx
import { useMemo } from "react";
import { Box, Text } from "ink";
import { jsx, jsxs } from "react/jsx-runtime";
function CatCompanion({ mood }) {
  const frame = useCatFrame(mood);
  const lines = useMemo(() => renderGrid(sheetGrid(cat, frame)), [frame]);
  return /* @__PURE__ */ jsx(Box, { flexDirection: "column", flexShrink: 0, width: CAT_W, marginRight: PET_MARGIN, children: lines.map((l, i) => /* @__PURE__ */ jsx(Text, { children: l }, i)) });
}
function Bubble({ text }) {
  return /* @__PURE__ */ jsxs(Box, { alignItems: "flex-end", children: [
    /* @__PURE__ */ jsx(Box, { borderStyle: "round", borderColor: C.parchment, paddingX: 1, children: /* @__PURE__ */ jsx(Text, { color: C.parchment, children: text }) }),
    /* @__PURE__ */ jsx(Box, { marginBottom: 1, children: /* @__PURE__ */ jsx(Text, { color: C.parchment, children: "\u25B8" }) })
  ] });
}
function pickLine(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}
var CAT_LINES;
var init_Cat = __esm({
  "src/ui/Cat.tsx"() {
    "use strict";
    init_catAnim();
    init_pixels();
    init_scene();
    init_sprites();
    init_theme();
    CAT_LINES = {
      greet: ["Mrrp! Ready when you are.", "Meow! Let\u2019s write some code.", "*stretches* Hi there!"],
      permission: ["Mrrow? Your call.", "*tilts head*", "Can I? Can I?"],
      plan: ["*sniffs the plan*", "Ooh, a plan!", "Purr\u2026 looks tasty."],
      allowed: ["*happy tail flick*", "Mrrp!", "On it!"],
      denied: ["*flattens ears*", "Okay\u2026 \u{1F63F}", "Fair enough."],
      done: ["Purrr \u2713", "*slow blink*", "All done!", "Nap time? \u{1F4A4}"],
      error: ["Hss\u2026 that broke.", "*puffs up*", "Uh oh\u2026 \u{1F63F}"],
      interrupted: ["*freezes*", "Okay, stopping!", "*sits very still*"],
      pet: ["Purrrr \u2665", "*headbutts your hand*", "*slow blink* \u2665", "*rolls over*"]
    };
  }
});

// src/ui/commands.ts
import fs10 from "node:fs";
import os6 from "node:os";
import path12 from "node:path";
function runsWhileBusy(cmd, args) {
  return typeof cmd.whileBusy === "function" ? cmd.whileBusy(args) : !!cmd.whileBusy;
}
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: m[2] };
}
function loadCustomCommands(cwd, skipped = []) {
  const home = os6.homedir();
  const dirs = [
    [path12.join(home, ".claude", "commands"), "user"],
    [path12.join(home, ".zoicode", "commands"), "user"],
    [path12.join(cwd, ".claude", "commands"), "project"],
    [path12.join(cwd, ".zoicode", "commands"), "project"]
  ];
  const found = /* @__PURE__ */ new Map();
  for (const [dir, source] of dirs) {
    let files = [];
    try {
      files = fs10.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -3).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const full = path12.join(dir, file);
      let text;
      try {
        if (!fs10.statSync(full).isFile()) throw new Error("not a regular file");
        text = fs10.readFileSync(full, "utf8");
      } catch {
        skipped.push(full);
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const firstLine = body.trim().split("\n")[0].replace(/^#+\s*/, "");
      found.set(name, {
        name,
        source,
        description: sanitize(meta.description || firstLine || "Custom command").slice(0, 60),
        run: (args, api) => {
          const prompt = body.includes("$ARGUMENTS") ? body.replaceAll("$ARGUMENTS", args) : args ? `${body.trim()}

Arguments: ${args}` : body.trim();
          api.submit(prompt, `/${name}${args ? " " + args : ""}`);
        }
      });
    }
  }
  return [...found.values()].filter((c) => !COMMANDS.some((b) => b.name === c.name || b.aliases?.includes(c.name)));
}
function findCommand(name, commands = COMMANDS) {
  return commands.find((c) => c.name === name || c.aliases?.includes(name));
}
function suggestCommands(value, commands = COMMANDS) {
  const q = value.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))).sort((a, b) => Number(b.name === q) - Number(a.name === q)).map((c) => ({ name: c.name, description: c.description }));
}
function expandMentions(text, cwd, readFiles) {
  const attached = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const abs = path12.resolve(cwd, m[1]);
    try {
      const stat = fs10.statSync(abs);
      if (stat.isFile() && stat.size < 256e3) {
        attached.push(`<file path="${abs}">
${fs10.readFileSync(abs, "utf8")}
</file>`);
        readFiles.set(abs, stat.mtimeMs);
      } else if (stat.isDirectory()) {
        attached.push(`<directory path="${abs}">
${fs10.readdirSync(abs).join("\n")}
</directory>`);
      }
    } catch {
    }
  }
  return attached.length ? `${text}

Attached files:
${attached.join("\n\n")}` : text;
}
var INIT_PROMPT, COMMANDS;
var init_commands = __esm({
  "src/ui/commands.ts"() {
    "use strict";
    init_prompt();
    init_sessions();
    init_sanitize();
    init_theme();
    INIT_PROMPT = `Please analyze this codebase and create a ZOICODE.md file in the project root. It will be given to future coding agents working in this repository.

Include:
1. Commands to build, lint, test and run (including how to run a single test).
2. High-level architecture: the big picture that takes reading several files to understand.

Be concise. Do not list every file, and do not invent information that isn't in the repo. If a ZOICODE.md or CLAUDE.md exists, improve it instead. Also include important parts of README.md, .cursorrules or similar files. Start the file with:

# ZOICODE.md

This file provides guidance to Zoi Code when working with code in this repository.`;
    COMMANDS = [
      {
        name: "help",
        whileBusy: true,
        aliases: ["?"],
        description: "Show commands and shortcuts",
        run: (_a, api) => {
          const cmds = api.commands.map((c) => `  /${c.name.padEnd(12)} ${c.description}${c.source ? ` (${c.source})` : ""}`).join("\n");
          api.info(
            `Zoi Code help

Commands
${cmds}

Shortcuts
  !cmd         run a shell command directly
  #note        save a note to ZOICODE.md
  @path        attach a file to your message
  \\ + enter    new line
  \u2191 / \u2193        prompt history
  shift+tab    cycle permission mode
  esc          interrupt Raon
  ctrl+c \xD72    quit`,
            C.parchment
          );
        }
      },
      {
        name: "clear",
        aliases: ["reset", "new"],
        description: "Start a fresh conversation",
        run: (_a, api) => {
          api.agent.clear();
          api.clearScreen();
        }
      },
      {
        name: "compact",
        description: "Summarize the conversation to free up context",
        run: (args, api) => api.compact(args)
      },
      {
        name: "cost",
        whileBusy: true,
        aliases: ["usage"],
        description: "Show token usage for this session",
        run: (_a, api) => {
          const u = api.agent.totalUsage;
          const ctx = api.agent.contextTokens;
          const win = api.agent.llm.config.contextWindow;
          api.info(
            `Token usage
  Input tokens:   ${u.promptTokens.toLocaleString()}
  Output tokens:  ${u.completionTokens.toLocaleString()}
  Context in use: ${ctx.toLocaleString()} / ${win.toLocaleString()} (${(ctx / win * 100).toFixed(1)}%)`,
            C.gold
          );
        }
      },
      {
        name: "model",
        whileBusy: (args) => !args.trim(),
        description: "Show or switch the model",
        run: async (args, api) => {
          const llm = api.agent.llm;
          if (args.trim()) {
            llm.config.model = args.trim();
            api.info(`Switched to ${llm.config.model}`, C.grass);
            return;
          }
          const models = await llm.listModels().catch(() => []);
          api.info(
            `Current model: ${llm.config.model}
Available: ${models.join(", ") || "(could not list)"}
Use /model <name> to switch.`,
            C.parchment
          );
        }
      },
      {
        name: "init",
        description: "Write a ZOICODE.md with notes about this project",
        run: (_a, api) => api.submit(INIT_PROMPT, "/init")
      },
      {
        name: "memory",
        whileBusy: true,
        description: "Show loaded memory files (ZOICODE.md, CLAUDE.md)",
        run: (_a, api) => {
          const files = loadMemory(api.agent.cwd);
          api.info(
            files.length ? "\u{1F9E0} Memory files\n" + files.map((f) => `  ${f.path} (${f.content.split("\n").length} lines)`).join("\n") : "No memory files yet. Run /init, or start a line with # to add a note.",
            C.purple
          );
        }
      },
      {
        name: "permissions",
        whileBusy: true,
        description: "Show the permission mode and allowed rules",
        run: (_a, api) => {
          const rules = [...api.agent.allowRules];
          api.info(
            `\u{1F510} Permission mode: ${api.agent.permissionMode}
Always allowed this session: ${rules.length ? rules.join(", ") : "(none)"}
Read-only tools and safe commands (ls, cat, git status\u2026) never ask, except in credential folders like ~/.ssh.`,
            C.parchment
          );
        }
      },
      {
        name: "resume",
        whileBusy: (args) => !args.trim(),
        description: "Resume a previous conversation in this directory",
        run: (args, api) => {
          const sessions = listSessions(api.agent.cwd);
          if (args.trim()) return api.resume(args.trim());
          if (!sessions.length) return api.info("No saved sessions here yet.");
          api.info(
            "\u{1F4FC} Saved sessions (use /resume <id>)\n" + sessions.slice(0, 10).map((s) => `  ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title || "(untitled)"}`).join("\n"),
            C.parchment
          );
        }
      },
      {
        name: "export",
        whileBusy: true,
        description: "Save the conversation to a markdown file",
        run: (args, api) => {
          const file = path12.resolve(api.agent.cwd, args.trim() || `zoicode-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
          const parts = [`# Zoi Code conversation

${(/* @__PURE__ */ new Date()).toLocaleString()} \xB7 ${api.agent.cwd}
`];
          for (const m of api.agent.messages) {
            if (m.role === "user" && typeof m.content === "string") {
              parts.push(`## You

${m.content.replace(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>$/, "")}`);
            } else if (m.role === "assistant") {
              if (typeof m.content === "string" && m.content.trim()) parts.push(`## Raon

${m.content.trim()}`);
              for (const c of m.tool_calls ?? []) if ("function" in c) parts.push(`> \u{1F527} **${c.function.name}** \`${c.function.arguments.slice(0, 300)}\``);
            }
          }
          fs10.writeFileSync(file, parts.join("\n\n") + "\n");
          api.info(`\u{1F4DC} Exported ${api.agent.messages.length} messages to ${path12.relative(api.agent.cwd, file) || file}`, C.grass);
        }
      },
      {
        name: "pet",
        whileBusy: true,
        description: "Pet the cat",
        run: (_a, api) => {
          api.pet();
          api.info("\u2665 You pet the cat. It purrs.", C.berry);
        }
      },
      {
        name: "exit",
        whileBusy: true,
        aliases: ["quit", "bye"],
        description: "Quit",
        run: (_a, api) => api.exit()
      }
    ];
  }
});

// src/ui/markdown.ts
import chalk6 from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight, supportsLanguage } from "cli-highlight";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
function getMarked(width) {
  if (marked && width === cachedWidth) return marked;
  cachedWidth = width;
  marked = new Marked();
  marked.use(
    markedTerminal(
      {
        width,
        reflowText: false,
        tab: 2,
        showSectionPrefix: false,
        heading: chalk6.hex(C.gold).bold,
        firstHeading: chalk6.hex(C.gold).bold.underline,
        strong: chalk6.bold.hex(C.parchment),
        em: chalk6.italic,
        codespan: chalk6.hex(C.goldLight),
        code: (code) => code,
        blockquote: chalk6.hex(C.dim).italic,
        link: chalk6.hex(C.sky),
        href: chalk6.hex(C.sky).underline,
        listitem: (s) => s,
        hr: chalk6.hex(C.wood),
        table: chalk6.reset,
        paragraph: chalk6.reset,
        html: chalk6.hex(C.dim),
        del: chalk6.dim.strikethrough,
        emoji: true
      },
      { theme: {} }
    )
  );
  marked.use({
    renderer: {
      code({ text, lang }) {
        const language = (lang ?? "").trim().split(/\s+/)[0];
        let body = sanitize(text);
        if (language && supportsLanguage(language)) {
          try {
            body = highlight(body, { language, ignoreIllegals: true });
          } catch {
          }
        }
        const gutter = paint.wood("\u2502 ");
        const header = lang ? paint.wood("\u256D\u2500 ") + paint.dim(sanitize(lang)) + "\n" : paint.wood("\u256D\u2500") + "\n";
        return "\n" + header + body.split("\n").map((l) => gutter + l).join("\n") + "\n" + paint.wood("\u2570\u2500") + "\n\n";
      }
    }
  });
  return marked;
}
function renderMarkdown(text, width = process.stdout.columns || 80) {
  try {
    const out = getMarked(Math.max(40, width - 4)).parse(text, { async: false });
    return plainLinks(out).replace(/\n+$/, "");
  } catch {
    return text;
  }
}
function plainLinks(out) {
  let res = "";
  for (let i = 0; ; ) {
    const open = out.indexOf(HYPERLINK, i);
    if (open === -1) return res + out.slice(i);
    res += out.slice(i, open);
    const urlEnd = out.indexOf("\x07", open + HYPERLINK.length);
    const close = urlEnd === -1 ? -1 : out.indexOf(HYPERLINK + "\x07", urlEnd + 1);
    if (close === -1) {
      i = urlEnd === -1 ? open + HYPERLINK.length : urlEnd + 1;
      continue;
    }
    const url = out.slice(open + HYPERLINK.length, urlEnd);
    const text = out.slice(urlEnd + 1, close);
    res += text.replace(/\x1b\[[0-9;]*m/g, "") === url ? text : `${text} (${url})`;
    i = close + HYPERLINK.length + 1;
  }
}
function renderDiff(patch, maxLines = 40, clean2 = sanitize) {
  const out = [];
  let oldLn = 0;
  let newLn = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) {
      if (out.length) out.push(paint.dim("   \u22EE"));
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const line = clean2(raw);
    if (line.startsWith("+")) {
      out.push(chalk6.bgHex("#1F3A1A").hex("#B8F28C")(`${String(newLn++).padStart(4)} + ${line.slice(1)}`));
    } else if (line.startsWith("-")) {
      out.push(chalk6.bgHex("#3F1A20").hex("#F7A1B0")(`${String(oldLn++).padStart(4)} - ${line.slice(1)}`));
    } else if (line.startsWith(" ")) {
      out.push(paint.dim(`${String(newLn).padStart(4)}   `) + line.slice(1));
      oldLn++;
      newLn++;
    }
  }
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), paint.dim(`   \u2026 +${out.length - maxLines} more lines`)].join("\n");
  }
  return out.join("\n");
}
function bulleted(text, bullet, width) {
  const indent = " ".repeat(stringWidth(bullet));
  return wrapAnsi(text, Math.max(10, width - indent.length), { hard: true, trim: false }).split("\n").map((line, i) => (i === 0 ? bullet : indent) + line.replace(/ +$/, "")).join("\n");
}
var cachedWidth, marked, HYPERLINK;
var init_markdown = __esm({
  "src/ui/markdown.ts"() {
    "use strict";
    init_sanitize();
    init_theme();
    cachedWidth = 0;
    HYPERLINK = "\x1B]8;;";
  }
});

// src/ui/Messages.tsx
import path13 from "node:path";
import { Box as Box2, Text as Text2 } from "ink";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function shortLabel(label, cwd) {
  const lines = sanitize(label).split("\n");
  label = lines[0] + (lines.length > 1 ? " \u2026" : "");
  if (path13.isAbsolute(label)) {
    const rel = path13.relative(cwd, label);
    if (!rel.startsWith("..")) return rel || ".";
  }
  return label.length > 120 ? label.slice(0, 117) + "\u2026" : label;
}
function Result({ children, color }) {
  return /* @__PURE__ */ jsx2(Box2, { paddingLeft: 2, children: /* @__PURE__ */ jsx2(Text2, { color, children: bulleted(children, paint.dim("\u23BF  "), columns() - 2) }) });
}
function preview(output, lines = 4) {
  const all = sanitize(output).replace(/\n+Exit code 0$/, "").split("\n");
  const shown = all.slice(0, lines).map((l) => l.length > 160 ? l.slice(0, 157) + "\u2026" : l);
  return shown.join("\n") + (all.length > lines ? `
\u2026 +${all.length - lines} lines` : "");
}
function TodoList({ todos, max = 12 }) {
  const current = Math.max(0, todos.findIndex((t) => t.status !== "completed"));
  const start = Math.max(0, Math.min(current - 2, todos.length - max));
  const shown = todos.slice(start, start + max);
  return /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", paddingLeft: 2, children: [
    /* @__PURE__ */ jsx2(Text2, { color: C.gold, bold: true, children: "\u{1F4DC} To-do list" }),
    start > 0 ? /* @__PURE__ */ jsxs2(Text2, { color: C.dim, children: [
      "  \u2026 ",
      start,
      " done above"
    ] }) : null,
    shown.map((t, i) => /* @__PURE__ */ jsxs2(
      Text2,
      {
        color: t.status === "completed" ? C.grass : t.status === "in_progress" ? C.gold : C.parchment,
        strikethrough: t.status === "completed",
        bold: t.status === "in_progress",
        wrap: "truncate-end",
        children: [
          "  ",
          t.status === "completed" ? "\u2611" : t.status === "in_progress" ? "\u25B6" : "\u2610",
          " ",
          sanitize(String(t.content))
        ]
      },
      start + i
    )),
    start + max < todos.length ? /* @__PURE__ */ jsxs2(Text2, { color: C.dim, children: [
      "  \u2026 ",
      todos.length - start - max,
      " more"
    ] }) : null
  ] });
}
function ToolLine({ item, cwd }) {
  const dot = item.status === "running" ? C.gold : item.status === "done" ? C.grass : item.status === "denied" ? C.stone : C.berry;
  const r = item.result;
  return /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", marginTop: 1, children: [
    /* @__PURE__ */ jsxs2(Text2, { wrap: "truncate-end", children: [
      /* @__PURE__ */ jsx2(Text2, { color: dot, children: "\u23FA " }),
      /* @__PURE__ */ jsx2(Text2, { bold: true, color: C.parchment, children: sanitize(item.name) }),
      /* @__PURE__ */ jsxs2(Text2, { color: C.dim, children: [
        "(",
        shortLabel(item.label, cwd),
        ")"
      ] })
    ] }),
    item.status === "running" ? /* @__PURE__ */ jsxs2(Text2, { color: C.dim, wrap: "truncate-end", children: [
      "  \u23BF  ",
      TOOL_ICONS[item.name] ?? "\u2699",
      " ",
      item.progress ? sanitize(item.progress) : "working\u2026"
    ] }) : item.status === "denied" ? /* @__PURE__ */ jsx2(Text2, { color: C.stone, children: "  \u23BF  Denied" }) : r?.isError ? /* @__PURE__ */ jsx2(Result, { color: C.berry, children: preview(r.output, 6) }) : /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", paddingLeft: 2, children: [
      /* @__PURE__ */ jsxs2(Text2, { color: C.dim, wrap: "truncate-end", children: [
        "\u23BF  ",
        r?.summary ? sanitize(r.summary) : preview(r?.output ?? "", 1)
      ] }),
      r?.diff ? /* @__PURE__ */ jsx2(Box2, { paddingLeft: 3, children: /* @__PURE__ */ jsx2(Text2, { children: renderDiff(r.diff) }) }) : item.name === "Bash" && r?.output ? /* @__PURE__ */ jsx2(Box2, { paddingLeft: 3, children: /* @__PURE__ */ jsx2(Text2, { color: C.stone, children: preview(r.output) }) }) : null
    ] })
  ] });
}
function MessageItem({ item, cwd }) {
  switch (item.kind) {
    case "banner":
      return /* @__PURE__ */ jsx2(Text2, { children: item.lines.join("\n") });
    case "user":
      return /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsxs2(Text2, { color: C.dim, children: [
        /* @__PURE__ */ jsx2(Text2, { color: C.gold, children: "\u203A " }),
        sanitize(item.text)
      ] }) });
    case "assistant":
      return /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsx2(Text2, { children: bulleted(renderMarkdown(sanitize(item.text), columns() - 2), paint.grass("\u23FA "), columns()) }) });
    case "plan":
      return /* @__PURE__ */ jsxs2(Box2, { marginTop: 1, flexDirection: "column", borderStyle: "round", borderColor: C.sky, paddingX: 1, children: [
        /* @__PURE__ */ jsx2(Text2, { color: C.sky, bold: true, children: "\u{1F4DC} Raon's plan" }),
        /* @__PURE__ */ jsx2(Text2, { children: bulleted(renderMarkdown(sanitize(item.text), columns() - 6), "", columns() - 4) })
      ] });
    case "thought":
      return /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsxs2(Text2, { color: C.dim, italic: true, children: [
        "\u273B Thought for ",
        item.seconds,
        "s"
      ] }) });
    case "tool":
      return /* @__PURE__ */ jsx2(ToolLine, { item, cwd });
    case "todos":
      return /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsx2(TodoList, { todos: item.todos }) });
    case "bash":
      return /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", marginTop: 1, children: [
        /* @__PURE__ */ jsxs2(Text2, { children: [
          /* @__PURE__ */ jsx2(Text2, { color: C.berry, bold: true, children: "! " }),
          /* @__PURE__ */ jsx2(Text2, { color: C.parchment, children: sanitize(item.command) })
        ] }),
        /* @__PURE__ */ jsx2(Result, { color: item.isError ? C.berry : C.stone, children: preview(item.output, 12) })
      ] });
    case "info":
      return /* @__PURE__ */ jsx2(Box2, { marginTop: 1, paddingLeft: 2, children: /* @__PURE__ */ jsx2(Text2, { color: item.color ?? C.dim, children: sanitize(item.text) }) });
    default:
      return null;
  }
}
var TOOL_ICONS, columns;
var init_Messages = __esm({
  "src/ui/Messages.tsx"() {
    "use strict";
    init_markdown();
    init_sanitize();
    init_theme();
    TOOL_ICONS = {
      Read: "\u{1F4D6}",
      Write: "\u{1F4DD}",
      Edit: "\u270E",
      Bash: "\u26A1",
      Glob: "\u{1F50D}",
      Grep: "\u{1F50D}",
      LS: "\u{1F5C2}",
      TodoWrite: "\u{1F4DC}",
      WebFetch: "\u{1F310}",
      Task: "\u{1F9F6}",
      ExitPlanMode: "\u{1F4DC}"
    };
    columns = () => process.stdout.columns || 80;
  }
});

// src/ui/Permission.tsx
import { useMemo as useMemo2, useRef, useState as useState2 } from "react";
import fs11 from "node:fs";
import { Box as Box3, Text as Text3, useInput } from "ink";
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function previewDiff(tool, input, cwd, maxLines) {
  try {
    const abs = resolvePath({ cwd }, input.file_path);
    const before = fs11.existsSync(abs) ? fs11.readFileSync(abs, "utf8") : "";
    let after;
    if (tool.name === "Write") after = String(input.content ?? "");
    else if (tool.name === "Edit") {
      const edit = applyEdit(before, input);
      if ("error" in edit) return null;
      after = edit.after;
    } else return null;
    const patch = makeDiff(displayPath({ cwd }, abs), before, after);
    return patch ? renderDiff(patch, maxLines, sanitizeStrict) : `(large change: ${before.split("\n").length} \u2192 ${after.split("\n").length} lines)`;
  } catch {
    return null;
  }
}
function clip(text, max) {
  const lines = text.split("\n");
  return lines.length <= max ? text : [...lines.slice(0, Math.max(1, max - 1)), `\u2026 +${lines.length - Math.max(1, max - 1)} more lines`].join("\n");
}
function useArmed(quietMs = 450) {
  const shownAt = useRef(Date.now());
  const lastKey = useRef(0);
  const armed = useRef(false);
  return () => {
    if (armed.current) return true;
    const now = Date.now();
    armed.current = now - Math.max(shownAt.current, lastKey.current) >= quietMs;
    lastKey.current = now;
    return armed.current;
  };
}
function PermissionPrompt({
  tool,
  input,
  cwd,
  rules = [],
  maxLines = 30,
  onAnswer
}) {
  const [sel, setSel] = useState2(0);
  const armed = useArmed();
  const budget = Math.max(3, maxLines - CHROME_LINES);
  const diff = useMemo2(() => previewDiff(tool, input, cwd, Math.max(2, budget - 1)), [tool, input, cwd, budget]);
  const command = sanitizeStrict(String(input.command ?? ""));
  const gitWarning = useMemo2(() => {
    if (tool.name !== "Bash" || !/(^|[;&|(]\s*)git(\s|$)/m.test(String(input.command ?? ""))) return "";
    const hooks = gitHooks(cwd);
    const config = (riskyGitConfig(cwd) ?? []).filter((k) => k !== "submodules");
    const parts = [
      hooks.length ? `its git hooks (${hooks.slice(0, 4).join(", ")}) run too` : "",
      config.length ? `its git config can run programs (${config.slice(0, 3).join(", ")})` : ""
    ].filter(Boolean);
    return parts.length ? sanitizeStrict(`This repository is set up so that ${parts.join(", and ")}.`) : "";
  }, [tool, input, cwd]);
  const ruleLabel = (rule) => {
    const m = rule.match(/^(\w+)\((.*)\)$/);
    if (tool.name === "Bash" && m) return `\`${sanitize(m[2])}\` commands`;
    if (tool.name === "WebFetch" && m) return sanitize(m[2]);
    return `${tool.name} in this project`;
  };
  const options = [
    { label: "Yes", answer: "allow" },
    ...rules.length ? [{ label: `Yes, and don't ask again for ${rules.map(ruleLabel).join(", ")} this session`, answer: "always" }] : [],
    { label: "No, and tell Raon what to do differently (esc)", answer: "deny" }
  ];
  const n = options.length;
  useInput((ch, key) => {
    if (key.escape) return onAnswer("deny");
    if (!armed()) return;
    if (key.upArrow) setSel((s) => (s + n - 1) % n);
    else if (key.downArrow || key.tab) setSel((s) => (s + 1) % n);
    else if (key.return) onAnswer(options[sel].answer);
    else if (/^[1-9]$/.test(ch) && Number(ch) <= n) onAnswer(options[Number(ch) - 1].answer);
  });
  const title = tool.name === "Bash" ? "Bash command" : tool.name === "Write" ? "Create file" : tool.name === "Edit" ? "Edit file" : tool.name === "WebFetch" ? "Fetch from the web" : tool.readOnly ? `${tool.name} in a credential folder` : tool.name;
  const target = input.file_path ?? input.path;
  const abs = target ? resolvePath({ cwd }, String(target)) : "";
  const file = abs ? sanitizeStrict(displayPath({ cwd }, abs)) : "";
  const outside = abs && !isInsideDir(cwd, abs);
  return /* @__PURE__ */ jsxs3(Box3, { flexDirection: "column", borderStyle: "round", borderColor: C.gold, paddingX: 1, children: [
    /* @__PURE__ */ jsxs3(Text3, { color: C.gold, bold: true, children: [
      "\u{1F43E} ",
      title
    ] }),
    /* @__PURE__ */ jsx3(Box3, { marginY: 1, flexDirection: "column", paddingLeft: 2, children: tool.name === "Bash" ? /* @__PURE__ */ jsxs3(Fragment, { children: [
      /* @__PURE__ */ jsx3(Text3, { color: C.parchment, children: clip(command, budget - (input.description ? 1 : 0) - (gitWarning ? 1 : 0)) }),
      input.description ? /* @__PURE__ */ jsx3(Text3, { color: C.dim, wrap: "truncate-end", children: sanitizeStrict(String(input.description)) }) : null,
      gitWarning ? /* @__PURE__ */ jsxs3(Text3, { color: C.berry, children: [
        "\u26A0 ",
        gitWarning
      ] }) : null
    ] }) : tool.name === "WebFetch" ? /* @__PURE__ */ jsx3(Text3, { color: C.sky, children: clip(sanitizeStrict(String(input.url ?? "")), budget) }) : /* @__PURE__ */ jsxs3(Fragment, { children: [
      /* @__PURE__ */ jsxs3(Text3, { color: C.parchment, wrap: "truncate-end", children: [
        file,
        outside ? /* @__PURE__ */ jsx3(Text3, { color: C.berry, children: " (outside the project)" }) : null
      ] }),
      tool.name === "Glob" || tool.name === "Grep" ? /* @__PURE__ */ jsx3(Text3, { color: C.dim, wrap: "truncate-end", children: sanitizeStrict(String(input.glob ?? input.pattern ?? "")) }) : null,
      diff ? /* @__PURE__ */ jsx3(Text3, { children: diff }) : null
    ] }) }),
    /* @__PURE__ */ jsx3(Text3, { color: C.parchment, children: "Do you want to proceed?" }),
    options.map((o, i) => /* @__PURE__ */ jsxs3(Text3, { color: i === sel ? C.gold : C.dim, wrap: "truncate-end", children: [
      i === sel ? "\u276F " : "  ",
      i + 1,
      ". ",
      o.label
    ] }, i))
  ] });
}
function PlanApproval({ plan, maxLines = 30, onAnswer }) {
  const [sel, setSel] = useState2(0);
  const armed = useArmed();
  const options = [
    { label: "Yes, and auto-accept edits", answer: "acceptEdits" },
    { label: "Yes, and manually approve edits", answer: "default" },
    { label: "No, keep planning (esc)", answer: "keep" }
  ];
  useInput((ch, key) => {
    if (key.escape) return onAnswer("keep");
    if (!armed()) return;
    if (key.upArrow) setSel((s) => (s + 2) % 3);
    else if (key.downArrow || key.tab) setSel((s) => (s + 1) % 3);
    else if (key.return) onAnswer(options[sel].answer);
    else if (["1", "2", "3"].includes(ch)) onAnswer(options[Number(ch) - 1].answer);
  });
  const rendered = renderMarkdown(sanitize(plan.trim() || "(empty plan)"), (process.stdout.columns || 80) - 6);
  const budget = Math.max(3, maxLines - CHROME_LINES);
  const lines = rendered.split("\n");
  const shown = lines.length <= budget ? rendered : [...lines.slice(0, budget - 1), `\u2026 ${lines.length - budget + 1} more lines (the full plan is above \u2191)`].join("\n");
  return /* @__PURE__ */ jsxs3(Box3, { flexDirection: "column", borderStyle: "round", borderColor: C.sky, paddingX: 1, children: [
    /* @__PURE__ */ jsx3(Text3, { color: C.sky, bold: true, children: "\u{1F4DC} Raon's plan" }),
    /* @__PURE__ */ jsx3(Box3, { marginY: 1, paddingLeft: 1, children: /* @__PURE__ */ jsx3(Text3, { children: shown }) }),
    /* @__PURE__ */ jsx3(Text3, { color: C.parchment, children: "Would you like to proceed?" }),
    options.map((o, i) => /* @__PURE__ */ jsxs3(Text3, { color: i === sel ? C.gold : C.dim, children: [
      i === sel ? "\u276F " : "  ",
      i + 1,
      ". ",
      o.label
    ] }, i))
  ] });
}
var CHROME_LINES;
var init_Permission = __esm({
  "src/ui/Permission.tsx"() {
    "use strict";
    init_files();
    init_types();
    init_markdown();
    init_sanitize();
    init_git();
    init_theme();
    CHROME_LINES = 9;
  }
});

// src/ui/PromptInput.tsx
import { useRef as useRef2, useState as useState3 } from "react";
import { Box as Box4, Text as Text4, useInput as useInput2 } from "ink";
import chalk7 from "chalk";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function menuWindow(count, selected) {
  const start = Math.max(0, Math.min(selected - MAX_SUGGESTIONS + 1, count - MAX_SUGGESTIONS));
  const end = Math.min(count, start + MAX_SUGGESTIONS);
  return { start, end, rows: end - start + (start > 0 ? 1 : 0) + (end < count ? 1 : 0) };
}
function SuggestionMenu({ matches, selected }) {
  const { start, end } = menuWindow(matches.length, selected);
  if (start === end) return null;
  return /* @__PURE__ */ jsxs4(Box4, { flexDirection: "column", paddingX: 2, children: [
    start > 0 ? /* @__PURE__ */ jsxs4(Text4, { color: C.dim, children: [
      "  \u2191 ",
      start,
      " more"
    ] }) : null,
    matches.slice(start, end).map((m, i) => /* @__PURE__ */ jsxs4(Text4, { color: start + i === selected ? C.gold : C.dim, wrap: "truncate-end", children: [
      start + i === selected ? "\u276F " : "  ",
      ("/" + m.name).padEnd(14),
      " ",
      sanitize(m.description)
    ] }, m.name)),
    end < matches.length ? /* @__PURE__ */ jsxs4(Text4, { color: C.dim, children: [
      "  \u2193 ",
      matches.length - end,
      " more"
    ] }) : null
  ] });
}
function modeOf(value) {
  if (value.startsWith("!")) return { glyph: "!", color: C.berry, hint: "bash mode" };
  if (value.startsWith("#")) return { glyph: "#", color: C.purple, hint: "memory mode \xB7 saved to ZOICODE.md" };
  if (value.startsWith("/")) return { glyph: "\u203A", color: C.sky, hint: "" };
  return { glyph: "\u203A", color: C.gold, hint: "" };
}
function PromptInput({ active, history, suggestions, onSubmit, onKey, onStatus }) {
  const st = useRef2({ value: "", cursor: 0, histIdx: -1, draft: "", selected: 0, recalled: false });
  const [, rerender] = useState3(0);
  const reported = useRef2("");
  const pasting = useRef2(false);
  const update = (patch) => {
    Object.assign(st.current, patch);
    rerender((n) => n + 1);
    const matches = matchesOf(st.current);
    const mode2 = modeOf(st.current.value);
    const key = `${st.current.selected}|${mode2.hint}|${matches.map((m) => m.name).join(" ")}`;
    if (key === reported.current) return;
    reported.current = key;
    onStatus?.({ matches, selected: st.current.selected, hint: mode2.hint ? { text: mode2.hint, color: mode2.color } : void 0 });
  };
  const setValue = (value2, cursor2 = value2.length) => update({ value: value2, cursor: Math.max(0, Math.min(cursor2, value2.length)), selected: 0, recalled: false });
  const matchesOf = (s) => s.value.startsWith("/") && !s.value.includes(" ") && !s.recalled ? suggestions(s.value) : [];
  const recall = (histIdx, patch = {}) => {
    const value2 = history[history.length - 1 - histIdx];
    update({ ...patch, histIdx, value: value2, cursor: value2.length, selected: 0, recalled: true });
  };
  const enter = () => {
    const s = st.current;
    if (s.value.endsWith("\\")) return setValue(s.value.slice(0, -1) + "\n");
    const matches = matchesOf(s);
    const v = matches.length ? "/" + matches[s.selected].name : s.value;
    if (!v.trim()) return;
    update({ value: "", cursor: 0, histIdx: -1, draft: "", selected: 0, recalled: false });
    onSubmit(v.trim());
  };
  useInput2(
    (input, key) => {
      if (input === PASTE_START || input === PASTE_END) {
        pasting.current = input === PASTE_START;
        return;
      }
      const s = st.current;
      if (onKey?.(input, key, s.value, (v) => setValue(v))) return;
      const matches = matchesOf(s);
      if (key.tab && matches.length) return setValue("/" + matches[s.selected].name + " ");
      if (key.return) return enter();
      if (key.upArrow) {
        if (matches.length) return update({ selected: (s.selected - 1 + matches.length) % matches.length });
        if (!history.length) return;
        return recall(Math.min(history.length - 1, s.histIdx + 1), s.histIdx === -1 ? { draft: s.value } : {});
      }
      if (key.downArrow) {
        if (matches.length) return update({ selected: (s.selected + 1) % matches.length });
        if (s.histIdx > 0) return recall(s.histIdx - 1);
        if (s.histIdx === 0) update({ histIdx: -1, value: s.draft, cursor: s.draft.length, recalled: false });
        return;
      }
      if (key.leftArrow) return update({ cursor: Math.max(0, s.cursor - 1) });
      if (key.rightArrow) return update({ cursor: Math.min(s.value.length, s.cursor + 1) });
      if (key.backspace || key.delete) {
        if (s.cursor === 0) return;
        return setValue(s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), s.cursor - 1);
      }
      if (key.ctrl) {
        if (input === "a") return update({ cursor: 0 });
        if (input === "e") return update({ cursor: s.value.length });
        if (input === "u") return setValue(s.value.slice(s.cursor), 0);
        if (input === "k") return setValue(s.value.slice(0, s.cursor), s.cursor);
        if (input === "w") {
          const before = s.value.slice(0, s.cursor).replace(/\S+\s*$/, "");
          return setValue(before + s.value.slice(s.cursor), before.length);
        }
        return;
      }
      if (key.tab || key.escape || key.meta) return;
      if (input) {
        const typedEnter = !pasting.current && /^[^\r\n]+\r$/.test(input);
        const text = (typedEnter ? input.slice(0, -1) : input).replace(/\r\n?/g, "\n");
        setValue(s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), s.cursor + text.length);
        if (typedEnter) enter();
      }
    },
    { isActive: active }
  );
  const { value, cursor } = st.current;
  const mode = modeOf(value);
  const at = value[cursor] ?? " ";
  const shown = active ? value.slice(0, cursor) + chalk7.inverse(at === "\n" ? " " : at) + (at === "\n" ? "\n" : "") + value.slice(cursor + 1) : value;
  return /* @__PURE__ */ jsxs4(Box4, { borderStyle: "round", borderColor: active ? mode.color === C.gold ? C.woodLight : mode.color : C.woodDark, paddingX: 1, children: [
    /* @__PURE__ */ jsxs4(Text4, { color: mode.color, bold: true, children: [
      mode.glyph,
      " "
    ] }),
    /* @__PURE__ */ jsx4(Box4, { flexGrow: 1, children: value ? /* @__PURE__ */ jsx4(Text4, { children: shown }) : /* @__PURE__ */ jsxs4(Text4, { color: C.dim, children: [
      active ? chalk7.inverse(" ") : "",
      active ? "Type a request\u2026 (/ for commands, @ to mention files)" : ""
    ] }) })
  ] });
}
var MAX_SUGGESTIONS, PASTE_START, PASTE_END;
var init_PromptInput = __esm({
  "src/ui/PromptInput.tsx"() {
    "use strict";
    init_sanitize();
    init_theme();
    MAX_SUGGESTIONS = 8;
    PASTE_START = "[200~";
    PASTE_END = "[201~";
  }
});

// src/ui/pinBottom.ts
function pinToBottom(live, rows) {
  let root = live;
  while (root.parentNode) root = root.parentNode;
  const layout = root.onComputeLayout;
  const box = live.yogaNode;
  if (typeof layout !== "function" || !box || typeof box.setMinHeight !== "function") {
    return { refill() {
    }, release() {
    } };
  }
  let keep = rows() - 1;
  const pinned = () => {
    layout();
    try {
      const printed = root.staticNode?.yogaNode?.getComputedHeight() ?? 0;
      box.setMinHeight(Math.max(0, Math.min(rows() - 1, keep - printed)));
      layout();
      keep = box.getComputedHeight();
    } catch {
    }
  };
  root.onComputeLayout = pinned;
  return {
    refill() {
      keep = rows() - 1;
    },
    release() {
      if (root.onComputeLayout === pinned) root.onComputeLayout = layout;
    }
  };
}
var init_pinBottom = __esm({
  "src/ui/pinBottom.ts"() {
    "use strict";
  }
});

// src/ui/App.tsx
import { useEffect as useEffect2, useLayoutEffect, useRef as useRef3, useState as useState4 } from "react";
import fs12 from "node:fs";
import path14 from "node:path";
import { Box as Box5, Static, Text as Text5, useApp, useInput as useInput3, useStdout } from "ink";
import wrapAnsi2 from "wrap-ansi";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function itemsFromMessages(messages) {
  const items = [];
  const pending = /* @__PURE__ */ new Map();
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      items.push({ kind: "user", id: uid(), text: m.content.split("\n\nAttached files:\n")[0].replace(/\n\n<system-reminder>[\s\S]*$/, "") });
    } else if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content.trim()) items.push({ kind: "assistant", id: uid(), text: m.content });
      for (const c of m.tool_calls ?? []) {
        if (!("function" in c)) continue;
        let input = {};
        try {
          input = JSON.parse(c.function.arguments);
        } catch {
        }
        const tool = findTool(c.function.name);
        const item = {
          kind: "tool",
          id: uid(),
          name: c.function.name,
          label: tool ? safe(() => tool.label(input)) : "",
          status: "done",
          input
        };
        pending.set(c.id, item);
        items.push(item);
      }
    } else if (m.role === "tool") {
      const item = pending.get(m.tool_call_id);
      if (item) item.result = { output: String(m.content), summary: String(m.content).split("\n")[0].slice(0, 100) };
    }
  }
  return items;
}
function safe(f) {
  try {
    const v = f();
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
function ContextMeter({ used, total }) {
  const full = Math.min(1, Math.max(0, used / total));
  const n = Math.round(full * 10);
  const color = full < 0.5 ? C.grass : full < 0.8 ? C.gold : C.berry;
  return /* @__PURE__ */ jsxs5(Text5, { children: [
    /* @__PURE__ */ jsx5(Text5, { color: C.dim, children: "context " }),
    /* @__PURE__ */ jsx5(Text5, { color, children: "\u25B0".repeat(n) }),
    /* @__PURE__ */ jsx5(Text5, { color: C.woodDark, children: "\u25B1".repeat(10 - n) })
  ] });
}
function Spinner({ frame, verb, started, tokens }) {
  const secs = Math.floor((Date.now() - started) / 1e3);
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const colors = [C.grass, C.gold, C.berry, C.gold];
  return /* @__PURE__ */ jsx5(Box5, { marginTop: 1, children: /* @__PURE__ */ jsxs5(Text5, { wrap: "truncate-end", children: [
    /* @__PURE__ */ jsxs5(Text5, { color: colors[Math.floor(frame / SPINNER_FRAMES.length) % colors.length], children: [
      glyph,
      " "
    ] }),
    /* @__PURE__ */ jsxs5(Text5, { color: C.gold, children: [
      verb,
      "\u2026 "
    ] }),
    /* @__PURE__ */ jsxs5(Text5, { color: C.dim, children: [
      "(",
      secs,
      "s",
      tokens ? ` \xB7 \u2193 ${tokens.toLocaleString()} tokens` : "",
      " \xB7 esc to interrupt)"
    ] })
  ] }) });
}
function tail(text, width, max) {
  const rows = wrapAnsi2(text, Math.max(10, width), { hard: true, trim: false }).split("\n");
  if (rows.length <= max) return rows.join("\n");
  return [`\u2026 ${rows.length - max + 1} more lines above`, ...rows.slice(-(max - 1))].join("\n");
}
function App({ agent, session: initialSession, initialPrompt, banner, makeBanner: makeBanner2, greet, onSession }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState4(() => [
    { kind: "banner", id: uid(), lines: banner },
    ...itemsFromMessages(initialSession.messages),
    ...initialSession.messages.length ? [{ kind: "info", id: uid(), text: `\u21BA Resumed session ${initialSession.id}`, color: C.grass }] : []
  ]);
  const [staticKey, setStaticKey] = useState4(0);
  const [ready, setReady] = useState4(false);
  const [busy, setBusy] = useState4(false);
  const [frame, setFrame] = useState4(0);
  const [running, setRunning] = useState4([]);
  const [todos, setTodos] = useState4([]);
  const [permission, setPermission] = useState4(null);
  const [planApproval, setPlanApproval] = useState4(null);
  const [mode, setMode] = useState4(agent.permissionMode);
  const [exitArmed, setExitArmed] = useState4(false);
  const [history, setHistory] = useState4([]);
  const [queue, setQueue] = useState4([]);
  const [, forceRender] = useState4(0);
  const skippedCommands = useRef3([]);
  const [commands] = useState4(() => [...COMMANDS, ...loadCustomCommands(agent.cwd, skippedCommands.current)]);
  const [mood, setMood] = useState4("idle");
  const [inputStatus, setInputStatus] = useState4({ matches: [], selected: 0 });
  const [say, setSay] = useState4(null);
  const [modes] = useState4(
    () => agent.permissionMode === "bypass" ? ["default", "acceptEdits", "plan", "bypass"] : ["default", "acceptEdits", "plan"]
  );
  const session = useRef3(initialSession);
  const controller = useRef3(null);
  const live = useRef3({ text: "", reasoning: "", started: 0, verb: "", outTokens: 0 });
  const busyRef = useRef3(false);
  const work = useRef3(null);
  const exiting = useRef3(false);
  const sayTimer = useRef3(void 0);
  const moodTimer = useRef3(void 0);
  const exitTimer = useRef3(void 0);
  const liveBox = useRef3(null);
  const pin = useRef3(null);
  const push = (...more) => setItems((prev) => [...prev, ...more]);
  const info = (text, color) => push({ kind: "info", id: uid(), text, color });
  const speak = (text, ms = 4500) => {
    clearTimeout(sayTimer.current);
    setSay(text);
    sayTimer.current = setTimeout(() => setSay(null), ms);
  };
  const moodFor = (m, ms) => {
    clearTimeout(moodTimer.current);
    setMood(m);
    moodTimer.current = setTimeout(() => setMood(busyRef.current ? "working" : "idle"), ms);
  };
  const track = (p) => {
    work.current = p;
    p.finally(() => {
      if (work.current === p) work.current = null;
    }).catch(() => {
    });
    return p;
  };
  const persist = () => {
    session.current.messages = agent.messages;
    if (agent.messages.length) {
      try {
        saveSession(session.current);
      } catch {
      }
    }
    onSession?.(session.current);
  };
  const resetScreen = (next) => {
    process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
    pin.current?.refill();
    setStaticKey((k) => k + 1);
    setItems([{ kind: "banner", id: uid(), lines: makeBanner2() }, ...next]);
  };
  useLayoutEffect(() => {
    const p = liveBox.current ? pinToBottom(liveBox.current, () => stdout.rows || 24) : null;
    pin.current = p;
    setReady(true);
    return () => p?.release();
  }, []);
  useEffect2(() => {
    if (busy) {
      clearTimeout(moodTimer.current);
      setMood("working");
    }
  }, [busy]);
  useEffect2(() => {
    if (greet) speak(pickLine(CAT_LINES.greet), 6e3);
    if (skippedCommands.current.length) info(`Skipped unreadable custom commands: ${skippedCommands.current.join(", ")}`, C.berry);
    if (initialPrompt) submit(initialPrompt);
    return () => {
      clearTimeout(sayTimer.current);
      clearTimeout(moodTimer.current);
      clearTimeout(exitTimer.current);
    };
  }, []);
  useEffect2(() => {
    agent.onPlan = (plan) => new Promise((resolve) => {
      if (exiting.current) return resolve("keep");
      clearTimeout(moodTimer.current);
      setMood("alert");
      speak(pickLine(CAT_LINES.plan), 12e4);
      push({ kind: "plan", id: uid(), text: plan });
      setPlanApproval({
        plan,
        resolve: (a) => {
          setPlanApproval(null);
          if (a !== "keep") setMode(a);
          setMood("working");
          speak(a === "keep" ? "Back to the drawing board!" : pickLine(CAT_LINES.allowed), 2500);
          resolve(a);
        }
      });
    });
    agent.onProgress = (id, message) => setRunning((r) => r.map((t) => t.id === id ? { ...t, progress: message } : t));
    agent.canUseTool = (tool, input, rules = []) => new Promise((resolve) => {
      if (exiting.current) return resolve("deny");
      clearTimeout(moodTimer.current);
      setMood("alert");
      speak(pickLine(CAT_LINES.permission), 12e4);
      setPermission({
        tool,
        input,
        rules,
        resolve: (a) => {
          setPermission(null);
          setMood("working");
          speak(pickLine(a === "deny" ? CAT_LINES.denied : CAT_LINES.allowed), 2500);
          resolve(a);
        }
      });
    });
  }, [agent]);
  useEffect2(() => {
    if (!busy) return;
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, [busy]);
  useEffect2(() => {
    if (busy || busyRef.current || exiting.current || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    runJob(next);
  }, [busy, queue]);
  function startJob(job) {
    if (busyRef.current) setQueue((q) => [...q, job]);
    else runJob(job);
  }
  function runJob(job) {
    if (job.kind === "prompt") track(runTurn(job.prompt, job.display, job.echoed));
    else if (job.kind === "bash") track(runBang(job.command));
    else track(runCommand(job.raw, true));
  }
  function beginWork(verb) {
    busyRef.current = true;
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    live.current = { text: "", reasoning: "", started: Date.now(), outTokens: 0, verb };
    return ac;
  }
  function endWork() {
    controller.current = null;
    busyRef.current = false;
    setRunning([]);
    setBusy(false);
    persist();
  }
  async function runTurn(prompt, display, echoed = false) {
    if (!echoed) push({ kind: "user", id: uid(), text: display });
    const ac = beginWork(SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]);
    let thinkStart = 0;
    let thinkEnd = 0;
    const labels = /* @__PURE__ */ new Map();
    let outcome = "ok";
    try {
      for await (const ev of agent.run(prompt, ac.signal)) {
        const l2 = live.current;
        switch (ev.type) {
          case "reasoning":
            if (!thinkStart) thinkStart = Date.now();
            thinkEnd = Date.now();
            l2.reasoning += ev.delta;
            l2.outTokens += 1;
            break;
          case "text":
            l2.text += ev.delta;
            l2.outTokens += 1;
            break;
          case "assistant": {
            const out = [];
            if (ev.reasoning && thinkStart) {
              out.push({ kind: "thought", id: uid(), seconds: Math.max(1, Math.round((thinkEnd - thinkStart) / 1e3)), text: ev.reasoning });
            }
            if (ev.text.trim()) out.push({ kind: "assistant", id: uid(), text: ev.text.trim() });
            push(...out);
            l2.text = "";
            l2.reasoning = "";
            thinkStart = 0;
            break;
          }
          case "tool_start":
            labels.set(ev.id, ev.label);
            setRunning((r) => [...r, { kind: "tool", id: ev.id, name: ev.name, label: ev.label, status: "running", input: ev.input }]);
            break;
          case "tool_end": {
            setRunning((r) => r.filter((t) => t.id !== ev.id));
            if (ev.name === "TodoWrite" && !ev.result.isError) {
              const list = agent.ctx.state.todos ?? [];
              setTodos(list);
              push({ kind: "todos", id: uid(), todos: list });
            } else {
              push({
                kind: "tool",
                id: uid(),
                name: ev.name,
                label: labels.get(ev.id) ?? "",
                status: ev.denied ? "denied" : ev.result.isError ? "error" : "done",
                result: ev.result
              });
            }
            break;
          }
          case "usage":
            break;
          case "error":
            outcome = "error";
            info(`\u2717 ${sanitize(ev.message)}`, C.berry);
            break;
          case "interrupted":
            outcome = "interrupted";
            info("\u23BF  Interrupted \xB7 What should Raon do instead?", C.berry);
            break;
        }
      }
    } catch (e) {
      outcome = "error";
      info(`\u2717 ${sanitize(e.message)}`, C.berry);
    } finally {
      endWork();
    }
    if (exiting.current) return;
    if (outcome === "error") {
      moodFor("sad", 5e3);
      speak(pickLine(CAT_LINES.error), 5e3);
    } else if (outcome === "interrupted") {
      moodFor("alert", 1500);
      speak(pickLine(CAT_LINES.interrupted), 3e3);
    } else {
      moodFor("happy", 3500);
      speak(pickLine(CAT_LINES.done), 5e3);
    }
    if (!exiting.current && agent.estimateContextTokens() > agent.llm.config.contextWindow * 0.85) {
      info("The context is almost full: compacting the conversation\u2026", C.gold);
      await doCompact("");
    }
  }
  async function runBang(command) {
    const ac = beginWork("Running");
    try {
      const result = await BashTool.run({ command }, { ...agent.ctx, signal: ac.signal });
      push({ kind: "bash", id: uid(), command, output: result.output, isError: !!result.isError });
      agent.messages.push({
        role: "user",
        content: `<bash-input>${command}</bash-input>
<bash-output>${result.output}</bash-output>
(The user ran this command directly; no reply needed unless asked.)`
      });
    } catch (e) {
      info(`\u2717 ${sanitize(e.message)}`, C.berry);
    } finally {
      endWork();
    }
  }
  async function doCompact(instructions) {
    const ac = beginWork("Compacting the conversation");
    try {
      const summary = await agent.compact(instructions, ac.signal);
      if (ac.signal.aborted) {
        info("Compaction stopped; the conversation is unchanged.", C.dim);
        return;
      }
      resetScreen([
        { kind: "info", id: uid(), text: "Conversation compacted. Summary:", color: C.gold },
        { kind: "assistant", id: uid(), text: summary || "(empty)" }
      ]);
    } catch (e) {
      info(
        ac.signal.aborted ? "Compaction stopped; the conversation is unchanged." : `\u2717 Compact failed: ${sanitize(e.message)} \xB7 the conversation was kept`,
        C.berry
      );
    } finally {
      endWork();
    }
  }
  async function shutdown() {
    if (exiting.current) return;
    exiting.current = true;
    setQueue([]);
    controller.current?.abort();
    permission?.resolve("deny");
    planApproval?.resolve("keep");
    const pending = work.current;
    if (pending) await Promise.race([pending.catch(() => {
    }), new Promise((r) => setTimeout(r, 3e3))]);
    persist();
    exit();
  }
  const api = {
    agent,
    info,
    commands,
    clearScreen: () => {
      resetScreen([]);
      setTodos([]);
      session.current = { ...session.current, id: Math.random().toString(16).slice(2, 10), messages: [], title: "" };
      onSession?.(session.current);
    },
    exit: () => void shutdown(),
    pet: () => {
      moodFor("happy", 3e3);
      speak(pickLine(CAT_LINES.pet), 3500);
    },
    submit: (prompt, display) => startJob({ kind: "prompt", prompt, display: display ?? prompt, echoed: true }),
    compact: (instructions) => track(doCompact(instructions)),
    resume: (id) => {
      const s = loadSession(agent.cwd, id);
      if (!s) return info(`No session matching "${sanitize(id)}"`, C.berry);
      agent.clear();
      agent.messages = s.messages;
      session.current = s;
      onSession?.(s);
      resetScreen([...itemsFromMessages(s.messages), { kind: "info", id: uid(), text: `\u21BA Resumed session ${s.id}`, color: C.grass }]);
    }
  };
  async function runCommand(raw, queued = false) {
    const [name, ...rest] = raw.slice(1).split(" ");
    const args = rest.join(" ");
    const cmd = findCommand(name, commands);
    if (!cmd) return info(`Unknown command /${sanitize(name)}. Try /help.`, C.berry);
    if (!queued) push({ kind: "user", id: uid(), text: raw });
    if (busyRef.current && !runsWhileBusy(cmd, args)) {
      setQueue((q) => [...q, { kind: "command", raw, display: raw }]);
      info(`\u23F3 /${name} will run when Raon is done`, C.dim);
      return;
    }
    try {
      await cmd.run(args, api);
    } catch (e) {
      info(`\u2717 ${sanitize(e.message)}`, C.berry);
    }
  }
  function submit(raw) {
    setHistory((h) => h.at(-1) === raw ? h : [...h, raw]);
    setExitArmed(false);
    if (raw.startsWith("/")) return void runCommand(raw);
    if (raw.startsWith("!")) {
      const command = raw.slice(1).trim();
      if (command) startJob({ kind: "bash", command, display: raw });
      return;
    }
    if (raw.startsWith("#")) {
      const note = raw.slice(1).trim();
      const file = path14.join(agent.cwd, "ZOICODE.md");
      try {
        const prefix = fs12.existsSync(file) ? fs12.readFileSync(file, "utf8").endsWith("\n") ? "" : "\n" : "# ZOICODE.md\n\n";
        fs12.appendFileSync(file, `${prefix}- ${note}
`);
        agent.refreshSystemPrompt();
        info(`\u{1F9E0} Remembered in ${path14.relative(agent.cwd, file)}: ${note}`, C.purple);
      } catch (e) {
        info(`\u2717 Could not save the note: ${e.message}`, C.berry);
      }
      return;
    }
    startJob({ kind: "prompt", prompt: expandMentions(raw, agent.cwd, agent.ctx.readFiles), display: raw });
  }
  function onKey(input, key, value, setValue) {
    if (key.tab && key.shift) {
      const next = modes[(modes.indexOf(mode) + 1) % modes.length] ?? "default";
      agent.permissionMode = next;
      setMode(next);
      return true;
    }
    if (key.escape) {
      if (busyRef.current) controller.current?.abort();
      else if (value) setValue("");
      return true;
    }
    if (key.ctrl && input === "c") {
      if (busyRef.current && !exitArmed) {
        controller.current?.abort();
      } else if (value) {
        setValue("");
        return true;
      }
      if (exitArmed) void shutdown();
      else {
        setExitArmed(true);
        clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => setExitArmed(false), 2e3);
      }
      return true;
    }
    if (key.ctrl && input === "l") {
      forceRender((n) => n + 1);
      return true;
    }
    return false;
  }
  const l = live.current;
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;
  const modeLabel = MODE_LABEL[mode] ?? MODE_LABEL.default;
  const prompting = !!(permission || planApproval);
  useInput3(
    (input, key) => {
      if (!(key.ctrl && input === "c")) return;
      if (exitArmed) return void shutdown();
      controller.current?.abort();
      permission?.resolve("deny");
      planApproval?.resolve("keep");
      setExitArmed(true);
      clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), 2e3);
    },
    { isActive: prompting }
  );
  const menu = !prompting && inputStatus.matches.length ? inputStatus : null;
  const menuRows = menu ? menuWindow(menu.matches.length, menu.selected).rows : 0;
  const hint = prompting ? void 0 : inputStatus.hint;
  const petHeight = PET_ROWS;
  const petWidth = CAT_W + PET_MARGIN;
  const petShown = cols >= petWidth + 40 && rows >= petHeight + 8 && (!prompting || rows >= petHeight + 20);
  const leftWidth = cols - (petShown ? petWidth : 0);
  const showSpinner = busy && !prompting;
  const runningRows = running.length * 3;
  const todoMax = Math.max(3, Math.min(12, Math.floor((rows - 20) / 2)));
  const showTodos = busy && !prompting && todos.some((t) => t.status !== "completed");
  const todoRows = showTodos ? Math.min(todos.length, todoMax) + 3 : 0;
  const sideRows = runningRows + todoRows + (queue.length ? 1 : 0) + (say ? 3 : 0) + (showSpinner ? 2 : 0) + menuRows + 2;
  const textBudget = rows - 1 - (PROMPT_ROWS_UI + 1) - sideRows - 1;
  const promptBudget = rows - 1 - (petShown ? petHeight : 0) - 1 - 2;
  const reasoningTail = sanitize(l.reasoning.trim().split("\n").filter(Boolean).slice(-2).join(" ")).slice(-leftWidth + 10);
  const streaming = busy && l.text && textBudget >= 3 ? tail(bulleted(renderMarkdown(sanitize(l.text), leftWidth - 2), paint.grass("\u23FA "), leftWidth), leftWidth, textBudget) : "";
  const usage = (agent.totalUsage.promptTokens + agent.totalUsage.completionTokens).toLocaleString();
  const left = exitArmed ? "Press Ctrl-C again to quit" : hint ? hint.text : modeLabel.text ? `${modeLabel.text} (shift+tab to cycle)` : busy ? "esc to interrupt \xB7 type to queue a message" : "? /help for commands";
  return /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx5(Static, { items: ready ? items : [], children: (item) => /* @__PURE__ */ jsx5(Box5, { flexDirection: "column", children: /* @__PURE__ */ jsx5(MessageItem, { item, cwd: agent.cwd }) }, item.id) }, staticKey),
    /* @__PURE__ */ jsxs5(Box5, { ref: liveBox, flexDirection: "column", justifyContent: "flex-end", display: ready ? "flex" : "none", children: [
      /* @__PURE__ */ jsxs5(Box5, { flexDirection: "row", alignItems: "flex-end", children: [
        /* @__PURE__ */ jsxs5(Box5, { flexDirection: "column", width: leftWidth, minHeight: petShown ? petHeight : 0, justifyContent: "flex-end", children: [
          busy && reasoningTail && !l.text && !prompting ? /* @__PURE__ */ jsx5(Box5, { marginTop: 1, children: /* @__PURE__ */ jsxs5(Text5, { color: C.dim, italic: true, wrap: "truncate-end", children: [
            "\u273B ",
            reasoningTail
          ] }) }) : null,
          streaming && !prompting ? /* @__PURE__ */ jsx5(Box5, { marginTop: 1, children: /* @__PURE__ */ jsx5(Text5, { children: streaming }) }) : null,
          running.map((t) => /* @__PURE__ */ jsx5(ToolLine, { item: t, cwd: agent.cwd }, t.id)),
          showTodos ? /* @__PURE__ */ jsx5(Box5, { marginTop: 1, children: /* @__PURE__ */ jsx5(TodoList, { todos, max: todoMax }) }) : null,
          queue.length > 0 ? /* @__PURE__ */ jsx5(Box5, { paddingLeft: 2, children: /* @__PURE__ */ jsxs5(Text5, { color: C.dim, wrap: "truncate-end", children: [
            "\u23F3 queued: ",
            queue.map((q) => sanitize(q.display)).join(" \xB7 ")
          ] }) }) : null,
          say && petShown ? /* @__PURE__ */ jsx5(Box5, { justifyContent: "flex-end", children: /* @__PURE__ */ jsx5(Bubble, { text: say }) }) : null,
          showSpinner ? /* @__PURE__ */ jsx5(Spinner, { frame, verb: l.verb, started: l.started, tokens: l.outTokens }) : null,
          menu ? /* @__PURE__ */ jsx5(SuggestionMenu, { matches: menu.matches, selected: menu.selected }) : null
        ] }),
        petShown ? /* @__PURE__ */ jsx5(CatCompanion, { mood }) : null
      ] }),
      planApproval ? /* @__PURE__ */ jsx5(PlanApproval, { plan: planApproval.plan, maxLines: promptBudget, onAnswer: planApproval.resolve }) : permission ? /* @__PURE__ */ jsx5(
        PermissionPrompt,
        {
          tool: permission.tool,
          input: permission.input,
          cwd: agent.cwd,
          rules: permission.rules,
          maxLines: promptBudget,
          onAnswer: permission.resolve
        }
      ) : null,
      /* @__PURE__ */ jsx5(Box5, { display: prompting ? "none" : "flex", flexDirection: "column", children: /* @__PURE__ */ jsx5(
        PromptInput,
        {
          active: !prompting,
          history,
          suggestions: (v) => suggestCommands(v, commands),
          onSubmit: submit,
          onKey,
          onStatus: setInputStatus
        }
      ) }),
      /* @__PURE__ */ jsxs5(Box5, { paddingX: 2, height: 1, children: [
        /* @__PURE__ */ jsx5(Box5, { flexGrow: 1, flexShrink: 1, children: /* @__PURE__ */ jsx5(Text5, { color: exitArmed ? C.berry : hint ? hint.color : modeLabel.color, wrap: "truncate-end", children: left }) }),
        /* @__PURE__ */ jsx5(Box5, { flexShrink: 0, children: /* @__PURE__ */ jsxs5(Text5, { color: C.dim, children: [
          /* @__PURE__ */ jsx5(ContextMeter, { used: agent.contextTokens, total: agent.llm.config.contextWindow }),
          cols >= 90 ? /* @__PURE__ */ jsxs5(Text5, { color: C.dim, children: [
            "  ",
            usage,
            " tokens"
          ] }) : null
        ] }) })
      ] })
    ] })
  ] });
}
var nextId, uid, PROMPT_ROWS_UI, MODE_LABEL;
var init_App = __esm({
  "src/ui/App.tsx"() {
    "use strict";
    init_bash();
    init_tools();
    init_sessions();
    init_Cat();
    init_commands();
    init_markdown();
    init_Messages();
    init_Permission();
    init_PromptInput();
    init_pinBottom();
    init_sanitize();
    init_scene();
    init_sprites();
    init_theme();
    nextId = 0;
    uid = () => String(++nextId);
    PROMPT_ROWS_UI = 3;
    MODE_LABEL = {
      default: { text: "", color: C.dim },
      acceptEdits: { text: "\u23F5\u23F5 auto-accept edits on", color: C.purple },
      plan: { text: "\u23F8 plan mode on", color: C.sky },
      bypass: { text: "\u26A0 bypass permissions on: nothing asks first", color: C.berry }
    };
  }
});

// src/ui/opening.ts
function openingMenu(canContinue) {
  return [
    { id: "new", label: "New Session" },
    ...canContinue ? [{ id: "continue", label: "Continue" }] : [],
    { id: "plan", label: "Plan Studio", section: "Creator Mode" },
    { id: "build", label: "Build Studio" }
  ];
}
function infoLines(model, cwd, choice) {
  const home = process.env.HOME ?? "";
  const folder = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const mode = choice === "plan" ? "\u23F8 Plan Studio" : choice === "build" ? "\u23F5\u23F5 Build Studio" : choice === "continue" ? "\u21BA Continuing" : "\u273F New session";
  return [
    { text: mode, fg: "#F7C548", bold: true },
    { text: sanitize(model), fg: "#B8F28C" },
    { text: sanitize(folder), fg: "#F5DEB3" },
    { text: "/help for commands", fg: "#E8C9A0" }
  ];
}
function compactBanner(model, cwd) {
  const cols = Math.min(process.stdout.columns || 80, 100);
  const showLogo = cols >= logo.width + 4;
  const info = infoLines(model, cwd, "new").slice(1);
  const top = showLogo ? Math.ceil((logo.height + 2) / 2) : 0;
  const p = new Paint(cols, top + info.length + 1);
  if (showLogo) p.blit(sheetGrid(logo, "main"), 2, 1);
  else p.text(2, 0, "Zoi Code", { fg: "#7BC043", bold: true });
  info.forEach((l, i) => p.text(2, top + i + (showLogo ? 0 : 1), l.text.slice(0, cols - 4), { fg: l.fg, bold: l.bold }));
  return p.lines();
}
function runOpening(opts) {
  const out = process.stdout;
  const stdin = process.stdin;
  let layout = sceneLayout(out.columns || 80, out.rows || 24);
  if (!layout || !stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const items = openingMenu(opts.canContinue);
    let selected = 0;
    let catFrame = "open";
    let spinStart = null;
    let leaving = null;
    let prev = [];
    const timers = /* @__PURE__ */ new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    const PAN_DELAY = 200;
    const PAN_MS = 900;
    const panAt = (t) => {
      const p = Math.min(1, Math.max(0, (t - PAN_DELAY) / PAN_MS));
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      return layout.startPan + (layout.endPan - layout.startPan) * e;
    };
    const draw = () => {
      const L = layout;
      const now = Date.now();
      const t = leaving ? now - leaving.start : 0;
      const pose = leaving ? catJourney(t, L.home, L.dest) : null;
      const angle = spinStart === null ? 0 : Math.min(1, (now - spinStart) / 1200) * Math.PI * 2;
      const lines = renderScene(L, leaving ? { info: infoLines(opts.model, opts.cwd, leaving.choice), cat: pose, screenAngle: angle, prompt: true, pan: panAt(t) } : { menu: { items, selected }, cat: { frame: catFrame, ...L.home }, screenAngle: angle, hint: "\u2191\u2193 choose \xB7 enter \u21B5 start", pan: L.startPan });
      let buf = BSU;
      lines.forEach((line, i) => {
        if (line !== prev[i]) buf += `\x1B[${i + 1};1H${line}\x1B[K`;
      });
      out.write(buf + ESU);
      prev = lines;
      return leaving ? t >= Math.max(JOURNEY_MS, PAN_DELAY + PAN_MS) : false;
    };
    let stopFidget = () => {
    };
    const scheduleSpin = () => later(() => {
      if (leaving) return;
      spinStart = Date.now();
      const tick = () => {
        if (leaving || spinStart === null) return;
        if (Date.now() - spinStart > 1200) {
          spinStart = null;
          draw();
          return scheduleSpin();
        }
        draw();
        later(tick, 60);
      };
      tick();
    }, 6e3 + Math.random() * 4e3);
    const cleanup = () => {
      stopFidget();
      for (const t of timers) clearTimeout(t);
      stdin.off("data", onKey);
      out.off("resize", onResize);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const walk2 = () => {
      if (draw()) {
        cleanup();
        out.write("\x1B[1;1H");
        resolve({ choice: leaving.choice, banner: renderBanner(layout, infoLines(opts.model, opts.cwd, leaving.choice)) });
        return;
      }
      later(walk2, 40);
    };
    const onKey = (data) => {
      const key = data.toString("utf8");
      if (key === "") {
        cleanup();
        out.write("\x1B[?25h\x1B[2J\x1B[H");
        process.exit(130);
      }
      if (leaving) return;
      if (key === "\x1B[A" || key === "k") selected = (selected + items.length - 1) % items.length;
      else if (key === "\x1B[B" || key === "j" || key === "	") selected = (selected + 1) % items.length;
      else if (key === "\r" || key === "\n" || key === " ") {
        leaving = { start: Date.now(), choice: items[selected].id };
        return walk2();
      } else return;
      draw();
    };
    const onResize = () => {
      layout = sceneLayout(out.columns || 80, out.rows || 24);
      if (!layout) {
        cleanup();
        out.write("\x1B[2J\x1B[H");
        return resolve(null);
      }
      out.write("\x1B[2J");
      prev = [];
      draw();
    };
    out.write("\n".repeat((out.rows || 24) - 1) + "\x1B[?25l");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onKey);
    out.on("resize", onResize);
    stopFidget = fidget("idle", (f) => {
      catFrame = f;
      if (!leaving) draw();
    });
    scheduleSpin();
  });
}
var BSU, ESU;
var init_opening = __esm({
  "src/ui/opening.ts"() {
    "use strict";
    init_canvas();
    init_catAnim();
    init_scene();
    init_sanitize();
    init_sprites();
    BSU = "\x1B[?2026h";
    ESU = "\x1B[?2026l";
  }
});

// src/ui/start.tsx
var start_exports = {};
__export(start_exports, {
  startInteractive: () => startInteractive
});
import { render } from "ink";
import { jsx as jsx6 } from "react/jsx-runtime";
function makeBanner(model, cwd, choice) {
  const layout = sceneLayout(process.stdout.columns || 80, process.stdout.rows || 24);
  return layout ? renderBanner(layout, infoLines(model, cwd, choice)) : compactBanner(model, cwd);
}
async function startInteractive(opts) {
  if (!process.stdin.isTTY) {
    console.error("Interactive mode needs a terminal. Use -p for piped input.");
    process.exit(1);
  }
  const cwd = process.cwd();
  const agent = new Agent({ llm: opts.llm, cwd, permissionMode: opts.permissionMode });
  const model = opts.llm.config.model;
  if (opts.resume === true && !opts.continueLast) {
    const all = listSessions(cwd);
    if (!all.length) console.log(paint.dim("No saved sessions here yet; starting fresh."));
    else {
      console.log(paint.gold("\u{1F4FC} Saved sessions \u2014 resume with zoicode -r <id>\n"));
      for (const s of all.slice(0, 15)) {
        console.log(`  ${paint.gold(s.id)}  ${paint.dim(new Date(s.updatedAt).toLocaleString())}  ${sanitize(s.title || "(untitled)")}`);
      }
      process.exit(0);
    }
  }
  let session = resolveSession(cwd, !!opts.continueLast, opts.resume === true ? void 0 : opts.resume);
  if (!session) {
    console.error(`No session matching "${sanitize(String(opts.resume))}" in ${sanitize(cwd)}`);
    process.exit(1);
  }
  const intro = opts.splash ?? !session.messages.length;
  let choice = session.messages.length ? "continue" : "new";
  let banner;
  if (intro) {
    const opened = await runOpening({ model, cwd, canContinue: listSessions(cwd).length > 0 });
    if (opened) {
      ({ choice, banner } = opened);
      if (choice === "continue") session = listSessions(cwd)[0] ?? session;
      if (choice === "plan") agent.permissionMode = "plan";
      if (choice === "build") agent.permissionMode = "acceptEdits";
    }
  }
  agent.messages = session.messages;
  let current = session;
  process.stdout.write("\x1B[?2004h");
  process.once("exit", () => process.stdout.write("\x1B[?2004l"));
  const instance = render(
    /* @__PURE__ */ jsx6(
      App,
      {
        agent,
        session,
        initialPrompt: opts.prompt || void 0,
        banner: banner ?? makeBanner(model, cwd, choice),
        makeBanner: () => makeBanner(model, cwd, "new"),
        greet: intro,
        onSession: (s) => current = s
      }
    ),
    { exitOnCtrlC: false }
  );
  await instance.waitUntilExit();
  const u = agent.totalUsage;
  console.log(
    paint.gold("\n\u{1F43E} Bye! ") + paint.dim(`Used ${(u.promptTokens + u.completionTokens).toLocaleString()} tokens.`) + (current.messages.length ? paint.dim(` Resume with: zoicode -r ${current.id}`) : "")
  );
  process.exit(0);
}
var init_start = __esm({
  "src/ui/start.tsx"() {
    "use strict";
    init_agent();
    init_sessions();
    init_App();
    init_opening();
    init_scene();
    init_sanitize();
    init_theme();
  }
});

// src/cli.tsx
init_config();
init_llm();
init_agent();
import fs13 from "node:fs";
import { Command, Option } from "commander";

// src/headless.ts
init_sanitize();
import chalk from "chalk";
var OUTPUT_FORMATS = ["text", "json", "stream-json"];
async function runHeadless(agent, prompt, format, verbose) {
  const err = (s) => process.stderr.write(s);
  if (!OUTPUT_FORMATS.includes(format)) {
    err(chalk.red(`Error: unknown output format "${format}" (use ${OUTPUT_FORMATS.join(", ")})
`));
    return 1;
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  let finalText = "";
  let failed = false;
  let atMessageStart = true;
  try {
    for await (const ev of agent.run(prompt, controller.signal)) {
      if (format === "stream-json") {
        process.stdout.write(JSON.stringify(ev) + "\n");
      }
      switch (ev.type) {
        case "text": {
          if (format !== "text") break;
          const delta = atMessageStart ? ev.delta.replace(/^\s+/, "") : ev.delta;
          if (!delta) break;
          atMessageStart = false;
          process.stdout.write(sanitize(delta));
          break;
        }
        case "reasoning":
          if (verbose && format === "text") err(chalk.dim.italic(sanitize(ev.delta)));
          break;
        case "assistant":
          if (ev.text.trim()) finalText = ev.text.trim();
          if (format === "text" && !atMessageStart && !ev.text.endsWith("\n")) process.stdout.write("\n");
          atMessageStart = true;
          break;
        case "tool_start":
          if (verbose && format === "text") err(chalk.cyan(`\u23FA ${sanitize(ev.name)}(${sanitize(ev.label)})
`));
          break;
        case "tool_end":
          if (verbose && format === "text") {
            const color = ev.result.isError ? chalk.red : chalk.dim;
            err(color(`  \u23BF ${ev.denied ? "Denied" : sanitize(ev.result.summary ?? ev.result.output.split("\n")[0])}
`));
          }
          break;
        case "error":
          failed = true;
          err(chalk.red(`Error: ${sanitize(ev.message)}
`));
          break;
        case "interrupted":
          failed = true;
          err(chalk.yellow("Interrupted\n"));
          break;
      }
    }
  } catch (e) {
    failed = true;
    err(chalk.red(`Error: ${sanitize(e.message)}
`));
  }
  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ result: finalText, is_error: failed, usage: agent.totalUsage, num_messages: agent.messages.length }) + "\n"
    );
  }
  return failed ? 1 : 0;
}

// src/cli.tsx
init_sessions();
var PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypass"];
var OUTPUT_FORMATS2 = ["text", "json", "stream-json"];
async function readStdin() {
  const stat = fs13.fstatSync(0);
  if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return "";
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let data = "";
    let timer;
    const onData = (chunk) => {
      clearTimeout(timer);
      data += chunk;
    };
    const finish = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      resolve(data);
    };
    stdin.on("data", onData).once("end", finish).once("error", finish);
    if (stat.isSocket()) {
      timer = setTimeout(() => {
        process.stderr.write("Warning: no stdin data received in 3s, continuing without it. End stdin (or use < /dev/null) to skip the wait.\n");
        stdin.pause();
        finish();
      }, 3e3);
    }
  });
}
async function exitWhenFlushed(code) {
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise((resolve) => s.write("", resolve))));
  process.exit(code);
}
var program = new Command().name("zoicode").description("Zoi Code: a cozy coding agent for your terminal, powered by Raon").version(VERSION).argument("[prompt...]", "initial prompt").option("-p, --print", "print the response and exit (non-interactive)").option("-m, --model <model>", "model to use").addOption(new Option("--output-format <format>", "with --print: output format").choices(OUTPUT_FORMATS2).default("text")).addOption(new Option("--permission-mode <mode>", "which tool calls run without asking").choices(PERMISSION_MODES).default("default")).option("--yolo", "skip all permission prompts (same as --permission-mode bypass)").option("-c, --continue", "continue the most recent session in this directory").option("-r, --resume [id]", "resume a session by id (without an id: list them)").option("--verbose", "show tool calls and reasoning in --print mode").option("--no-splash", "skip the opening scene").option("--setup", "enter or change your Raon API key").action(async (promptWords, opts) => {
  const interactive = process.stdin.isTTY && !opts.print;
  if (opts.setup || interactive && !process.env.RAON_API_KEY?.trim()) {
    const { runSetup: runSetup2 } = await Promise.resolve().then(() => (init_setup(), setup_exports));
    await runSetup2();
    if (opts.setup && !promptWords.length) return;
  }
  const config = loadConfig({ model: opts.model });
  const llm = new LLM(config);
  const permissionMode = opts.yolo ? "bypass" : opts.permissionMode;
  let prompt = promptWords.join(" ");
  if (opts.print) {
    const cwd = process.cwd();
    if (opts.resume === true && !opts.continue) {
      console.error("--resume needs a session id with --print. Run zoicode -r to list the sessions here.");
      process.exit(1);
    }
    const session = resolveSession(cwd, !!opts.continue, opts.resume);
    if (!session) {
      console.error(`No session matching "${opts.resume}" in ${cwd}. (-r takes the next word as the id: put the prompt after the id.)`);
      process.exit(1);
    }
    const stdin = opts.setup ? "" : await readStdin();
    if (stdin) prompt = prompt ? `${prompt}

${stdin}` : stdin;
    if (!prompt.trim()) {
      console.error('No prompt given. Usage: zoicode -p "your prompt"');
      process.exit(1);
    }
    const agent = new Agent({ llm, cwd, permissionMode });
    agent.messages = session.messages;
    process.stdout.on("error", (e) => {
      if (e.code === "EPIPE") process.exit(0);
      throw e;
    });
    const code = await runHeadless(agent, prompt, opts.outputFormat, !!opts.verbose);
    session.messages = agent.messages;
    try {
      saveSession(session);
    } catch {
    }
    await exitWhenFlushed(code);
  }
  const { startInteractive: startInteractive2 } = await Promise.resolve().then(() => (init_start(), start_exports));
  await startInteractive2({ llm, permissionMode, prompt, continueLast: !!opts.continue, resume: opts.resume, splash: opts.splash ? void 0 : false });
});
program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
