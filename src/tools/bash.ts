import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { gitHooks, QUIET_GIT_ENV, riskyGitConfig } from './git.js';
import { containsSecrets, fixedPrefix, inSecrets } from './secrets.js';
import type { Tool, ToolContext } from './types.js';

// Programs that only read. Anything that can write files or run other programs
// (env, xargs, tree -o, uniq OUT, ...) is deliberately left out.
const SAFE_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'which', 'file', 'stat', 'du', 'df',
  'grep', 'rg', 'find', 'date', 'whoami', 'uname', 'sort', 'diff',
]);
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'blame']);

/** `--name`, `--name=VALUE`, or an abbreviation such as `--na`, which GNU getopt accepts too. */
const longFlag = (word: string, ...names: string[]) => {
  const flag = word.split('=')[0];
  return flag.length > 2 && flag.startsWith('--') && names.some(name => `--${name}`.startsWith(flag));
};
/**
 * A bundle of short options such as `-uo` or `-oFILE` that sets one of `letters`. Scanning stops at an
 * option in `valued`, which takes the rest of the word as its value.
 */
const shortFlag = (word: string, letters: string, valued = '') => {
  if (!/^-[^-]/.test(word)) return false;
  for (const c of word.slice(1)) {
    if (letters.includes(c)) return true;
    if (valued.includes(c)) return false;
  }
  return false;
};

/** Arguments that make an otherwise read-only program write files, run other programs or set the clock. */
const UNSAFE_ARGS = new Map<string, (word: string, previous: string) => boolean>([
  ['find', w => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(w)],
  ['sort', w => longFlag(w, 'output', 'compress-program') || shortFlag(w, 'o')],
  ['rg', w => longFlag(w, 'pre', 'hostname-bin')],
  ['file', w => longFlag(w, 'compile') || shortFlag(w, 'C')],
  ['git', w => longFlag(w, 'output', 'ext-diff')],
  // `date MMDDhhmm` sets the clock like --set, so the only operands allowed are +FORMAT and option values.
  ['date', (w, prev) => longFlag(w, 'set') || shortFlag(w, 's', 'dfIr') ||
    (!/^[-+]/.test(w) && !/^(-[dfr]|--(date|file|reference|rfc-3339))$/.test(prev))],
]);

/**
 * Splits a command line into simple commands, with quotes removed from their words. Returns null when
 * the words would depend on the shell at run time (variables, substitutions, escapes, braces, redirections,
 * subshells, comments), for background jobs, and when the quotes don't match. `globbed` marks an unquoted
 * wildcard, which expands to whatever file names are on disk.
 */
export function splitCommand(command: string): { words: string[]; globbed: boolean }[] | null {
  const commands: { words: string[]; globbed: boolean }[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let globbed = false;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, globbed });
    words = [];
    globbed = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === ' ' || c === '\t') endWord();
    else if (c === '&' && command[i + 1] !== '&') return null; // a background job outlives the call
    else if ('\n;&|'.includes(c)) {
      endCommand();
      if (c === '&') i++;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return null;
      const quoted = command.slice(i + 1, end);
      // Inside "..." the shell still expands $ ` and \ (a $ right before the closing quote stays literal).
      if (c === '"' && /[`\\]|\$./s.test(quoted)) return null;
      word = (word ?? '') + quoted;
      i = end;
    } else if ('$`\\<>(){}#!'.includes(c)) return null;
    else {
      if ('*?['.includes(c)) globbed = true;
      word = (word ?? '') + c;
    }
  }
  endCommand();
  return commands;
}

/** True for commands made only of read-only programs, with no redirection, substitution or flag that writes. */
export function isSafeCommand(command: string): boolean {
  // Tool arguments are not validated against the schema, so `command` can be anything.
  const commands = typeof command === 'string' ? splitCommand(command) : null;
  if (!commands?.length) return false;
  return commands.every(({ words, globbed }) => {
    const [cmd, sub, ...rest] = words;
    const unsafeArg = UNSAFE_ARGS.get(cmd);
    // A wildcard can expand to a file named like a flag (`-delete`), so these programs need plain words.
    if (unsafeArg && (globbed || words.some((w, i) => i > 0 && unsafeArg(w, words[i - 1])))) return false;
    if (cmd === 'git') {
      // `git branch` / `git remote` only when listing.
      if (sub === 'branch') return rest.every(a => /^(-a|-r|-v|-vv|--list|--all|--remotes|--show-current)$/.test(a));
      if (sub === 'remote') return rest.every(a => /^(-v|--verbose)$/.test(a));
      return SAFE_GIT.has(sub);
    }
    return SAFE_COMMANDS.has(cmd);
  });
}

/**
 * Programs that run code given in their arguments (or are interpreters, or run whatever package they
 * are given), so a "don't ask again" rule for one would allow anything. They are asked about each time.
 */
const NEVER_RULED = new Set([
  'env', 'sudo', 'doas', 'su', 'runuser', 'pkexec', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'eval', 'exec',
  'command', 'builtin', 'source', '.', 'trap', 'enable', 'coproc', 'time', 'xargs', 'parallel', 'timeout', 'nohup', 'nice',
  'ionice', 'stdbuf', 'setsid', 'flock', 'watch', 'chroot', 'unshare', 'nsenter', 'strace', 'script', 'ssh',
  'awk', 'gawk', 'nawk', 'mawk', 'sed', 'perl', 'python', 'python2', 'python3', 'node', 'nodejs', 'ruby', 'php', 'lua',
  'luajit', 'tclsh', 'wish', 'expect', 'Rscript', 'osascript', 'pwsh', 'vi', 'vim', 'nvim', 'ex', 'ed', 'emacs', 'less',
  'more', 'man', 'tar', 'rsync', 'scp', 'open', 'xdg-open', 'npx', 'pnpx', 'bunx', 'uvx', 'pipx',
]);
/** Tools whose rules name the subcommand too: `npm test` and `npm exec` are very different things. */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'pip', 'pip3', 'uv', 'poetry',
  'make', 'just', 'dotnet', 'mvn', 'gradle', 'brew',
]);
/** Subcommands that run arbitrary code or packages: no rule covers them. */
const NEVER_RULED_SUB: Record<string, string[]> = {
  npm: ['exec', 'x', 'explore'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'], deno: ['eval'],
  uv: ['run', 'tool'], poetry: ['run'], gh: ['extension', 'alias'],
};
/** Built-in git commands a rule may cover. Aliases are not built in, and config, submodule or bisect can run programs. */
const GIT_RULED = new Set([
  'add', 'am', 'apply', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'describe', 'diff', 'fetch',
  'format-patch', 'grep', 'init', 'log', 'ls-files', 'merge', 'mv', 'notes', 'pull', 'push', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show', 'stash', 'status', 'switch', 'tag', 'worktree',
]);
/** Options that make one of those run another program, or write where the command doesn't say. */
const gitUnsafeForRule = (word: string, sub: string) =>
  longFlag(word, 'upload-pack', 'receive-pack', 'exec', 'exec-path', 'output', 'ext-diff', 'open-files-in-pager', 'template', 'config', 'config-env') ||
  shortFlag(word, 'c') || (sub === 'grep' && shortFlag(word, 'O')) || (sub === 'rebase' && shortFlag(word, 'x'));

/** `2>&1` and `>/dev/null` change nothing a rule cares about. */
const HARMLESS_REDIRECTS = /(^|[ \t])(\d?>&\d|&?\d?>[ \t]*\/dev\/null)(?=[ \t]|$)/g;

/**
 * The rule a "don't ask again" answer stores for this command, which also decides which later commands
 * it covers: `git commit` for git and other tools with subcommands, the program name otherwise. Undefined
 * when no rule may cover it, and then the prompt doesn't offer one: anything but one plain command
 * (chains, pipes, wildcards, variables, substitutions), a program given by path, a program in
 * NEVER_RULED, or arguments that make it run other programs or write elsewhere (the same checks the
 * safe path uses, see UNSAFE_ARGS, plus git's own). A git rule also needs a plain repository config.
 */
export function bashRule(command: string, cwd: string): string | undefined {
  if (typeof command !== 'string') return undefined;
  const commands = splitCommand(command.replace(HARMLESS_REDIRECTS, '$1'));
  if (commands?.length !== 1 || commands[0].globbed) return undefined;
  const words = commands[0].words;
  const [program, sub] = words;
  if (!/^[\w@+-][\w@.+-]*$/.test(program) || NEVER_RULED.has(program)) return undefined;
  const unsafeArg = UNSAFE_ARGS.get(program);
  if (unsafeArg && words.some((w, i) => i > 0 && unsafeArg(w, words[i - 1]))) return undefined;
  if (program === 'git') {
    if (!GIT_RULED.has(sub) || words.some((w, i) => i > 1 && gitUnsafeForRule(w, sub))) return undefined;
    if (riskyGitConfig(cwd)?.length !== 0 || gitHooks(cwd).length) return undefined;
    return `git ${sub}`;
  }
  if (!SUBCOMMAND_TOOLS.has(program) || !sub || !/^[a-z][\w:-]*$/i.test(sub)) return program;
  return NEVER_RULED_SUB[program]?.includes(sub) ? undefined : `${program} ${sub}`;
}

/**
 * Whether a command's arguments reach a credential folder (see secrets.ts): then it asks first. Reading
 * programs can recurse (grep -r, find, du), so a folder that contains one counts too; ls and stat only
 * show names, so for them only a path inside one does.
 */
function argsTouchSecrets(command: string, cwd: string): boolean {
  return !!splitCommand(command)?.some(({ words }) =>
    words.slice(1).some(word => {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word; // --file=PATH
      return [word, value].some(w => {
        if (/^~[^/]/.test(w)) return true; // another user's home
        const abs = path.resolve(cwd, fixedPrefix(w.replace(/^~(?=\/|$)/, os.homedir())));
        return inSecrets(abs) || (!['ls', 'stat'].includes(words[0]) && containsSecrets(abs));
      });
    }),
  );
}

/** Whether any of the simple commands runs git (they are only "safe" in a repository with a plain config, see git.ts). */
function runsGit(command: string): boolean {
  return !!splitCommand(command)?.some(({ words }) => words[0] === 'git');
}

/** Where the shell is: commands run where the last `cd` left it. */
export function shellCwd(ctx: ToolContext): string {
  return (ctx.state.bashCwd as string | undefined) ?? ctx.cwd;
}

/** The environment for commands: no pagers, and not the API key, which Raon has no use for. */
function childEnv(): NodeJS.ProcessEnv {
  const { RAON_API_KEY: _key, ...env } = process.env;
  return { ...env, ...QUIET_GIT_ENV, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };
}

export const BashTool: Tool<{ command: string; timeout?: number; description?: string }> = {
  name: 'Bash',
  description:
    'Run a bash command and return its combined stdout/stderr and exit code. The working directory persists ' +
    'between calls. Default timeout 120s (max 600s). Avoid interactive commands. Prefer Read/Glob/Grep/LS ' +
    'over cat/find/grep/ls for exploring files.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout: { type: 'number', description: 'Timeout in milliseconds' },
      description: { type: 'string', description: '5-10 word description of what the command does' },
    },
    required: ['command'],
  },
  readOnly: false,
  label: i => (typeof i?.command === 'string' ? i.command : ''),
  isSafe: (i, ctx) =>
    isSafeCommand(i?.command) &&
    (!runsGit(i.command) || riskyGitConfig(shellCwd(ctx))?.length === 0) &&
    !argsTouchSecrets(i.command, shellCwd(ctx)),
  run(input, ctx) {
    const command = input?.command;
    if (typeof command !== 'string' || !command.trim()) {
      return Promise.resolve({ output: 'Error: the "command" parameter must be a non-empty string', isError: true });
    }
    const cwd = shellCwd(ctx);
    const cwdFile = newCwdFile();
    const script = cwdFile ? `${command}\n__rc=$?\npwd -P > ${shellQuote(cwdFile)}\nexit $__rc` : command;
    const timeout = Math.min(Number(input.timeout) > 0 ? Number(input.timeout) : 120_000, 600_000);

    return new Promise(resolve => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn('bash', ['-c', script], {
          cwd: isDirectory(cwd) ? cwd : ctx.cwd,
          env: childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        return resolve({ output: `Error: ${(e as Error).message}`, isError: true });
      }
      // Linux only: lets a kill find processes that left the session (setsid) but still hold the output.
      const outputs = [1, 2].map(fd => readLink(`/proc/${child.pid}/fd/${fd}`)).filter(Boolean);
      const out = new OutputBuffer();
      let killedBy: string | undefined;
      let exitCode: number | null = null;
      let exited = false;
      let done = false;
      let drain: NodeJS.Timeout | undefined;
      const kill = (why: string) => {
        if (exited) return;
        killedBy ??= why;
        killTree(child.pid!, outputs);
      };
      const timer = setTimeout(() => kill(`timed out after ${timeout}ms`), timeout);
      const onAbort = () => kill('interrupted by user');
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(drain);
        ctx.signal?.removeEventListener('abort', onAbort);
        // Background jobs may still hold the pipes: keep reading so they never block, but let the CLI exit without them.
        const background = !child.stdout.readableEnded || !child.stderr.readableEnded;
        (child.stdout as Socket).unref();
        (child.stderr as Socket).unref();
        if (cwdFile) {
          try {
            const dir = fs.readFileSync(cwdFile, 'utf8').replace(/\n$/, '');
            if (path.isAbsolute(dir) && isDirectory(dir)) ctx.state.bashCwd = dir;
            fs.rmSync(cwdFile);
          } catch { /* command exited before pwd */ }
        }
        if (error) return resolve({ output: `Error: ${error.message}`, isError: true });
        const { text, lines } = out.result();
        const note = background && !killedBy ? '\n(Background processes are still running; their output is not captured.)' : '';
        const status = killedBy ? `Command ${killedBy}` : `Exit code ${exitCode}`;
        resolve({
          output: `${text || '(no output)'}${note}\n\n${status}`,
          isError: killedBy !== undefined || exitCode !== 0,
          summary: killedBy ? status : `${lines} line${lines === 1 ? '' : 's'} of output${exitCode ? ` · exit ${exitCode}` : ''}`,
        });
      };

      // One decoder per stream, so a multi-byte character split across chunks stays whole.
      const onData = (s: string) => {
        if (done) return;
        out.push(s);
        if (out.total > OUTPUT_CAP) kill(`stopped after printing more than ${OUTPUT_CAP / 1e6}M characters`);
      };
      child.stdout.setEncoding('utf8').on('data', onData);
      child.stderr.setEncoding('utf8').on('data', onData);
      child.on('error', finish);
      child.on('exit', code => {
        exited = true;
        exitCode = code;
        clearTimeout(timer);
        // 'close' normally follows at once, but waits for every process holding the pipes, e.g. `server &`.
        // setImmediate gives the loop one more I/O pass, so output already in the pipes is still read.
        drain = setTimeout(() => setImmediate(finish), 200);
      });
      child.on('close', () => finish());
    });
  },
};

const OUTPUT_LIMIT = 30_000; // what the model gets, as with truncate()
const HALF = OUTPUT_LIMIT / 2;
const OUTPUT_CAP = 50_000_000; // stops runaway output (`cat /dev/zero`, `yes`) instead of reading it until the timeout

/**
 * Keeps a command's output in bounded memory. result() gives the same text as truncate(all.trimEnd())
 * and its line count, without ever holding all of the output.
 */
class OutputBuffer {
  total = 0;
  private head = ''; // the first HALF characters
  private tail = ''; // the last HALF characters up to the last non-blank one
  private blank = ''; // the blank run after that (its last HALF characters)
  private blankLength = 0;
  private blankNewlines = 0;
  private newlines = 0;

  push(s: string) {
    this.total += s.length;
    this.newlines += countNewlines(s);
    if (this.head.length < HALF) this.head += s.slice(0, HALF - this.head.length);
    const end = s.trimEnd().length;
    if (end > 0) {
      this.tail = (this.tail + this.blank + s.slice(0, end)).slice(-HALF);
      this.blank = '';
      this.blankLength = this.blankNewlines = 0;
    }
    const rest = s.slice(end);
    this.blank = (this.blank + rest).slice(-HALF);
    this.blankLength += rest.length;
    this.blankNewlines += countNewlines(rest);
  }

  result(): { text: string; lines: number } {
    const length = this.total - this.blankLength; // of all.trimEnd()
    const text =
      length <= HALF ? this.head.slice(0, length)
      : length <= OUTPUT_LIMIT ? this.head + this.tail.slice(HALF - length)
      : `${this.head}\n\n... [${length - OUTPUT_LIMIT} characters truncated] ...\n\n${this.tail}`;
    return { text, lines: length ? this.newlines - this.blankNewlines + 1 : 0 };
  }
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * SIGKILLs everything a command started: its process group and, on Linux, the rest of its session
 * (coreutils `timeout` moves to a group of its own) and anything that left the session but holds its output.
 */
function killTree(pid: number, outputs: string[]) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && Number(p) !== process.pid); } catch { /* no /proc */ }
  for (const p of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
      const session = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]);
      const holdsOutput = () => fs.readdirSync(`/proc/${p}/fd`).some(fd => outputs.includes(readLink(`/proc/${p}/fd/${fd}`)));
      if (session === pid || (outputs.length && holdsOutput())) process.kill(Number(p), 'SIGKILL');
    } catch { /* exited meanwhile, or not ours */ }
  }
}

let cwdDir: string | undefined;
/** A fresh path in a private (0700) temp directory, where bash reports the directory it ended in. */
function newCwdFile(): string | undefined {
  try {
    if (!cwdDir) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-bash-'));
      process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
      cwdDir = dir;
    }
    return path.join(cwdDir, `cwd-${randomUUID()}`);
  } catch {
    return undefined; // no usable temp dir: the working directory just won't carry over
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readLink(p: string): string {
  try {
    return fs.readlinkSync(p);
  } catch {
    return '';
  }
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
