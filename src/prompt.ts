import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { currentBranch, findGitDir, QUIET_GIT_ENV, riskyGitConfig } from './tools/git.js';

export const MEMORY_FILES = ['ZOICODE.md', 'CLAUDE.md'];

export interface MemoryFile {
  path: string;
  content: string;
}

/** The most read from one memory file: they come with a project, and all of it goes into every request. */
const MAX_MEMORY_BYTES = 256 * 1024;

/** Memory files: ~/.zoicode/ZOICODE.md, then every ZOICODE.md/CLAUDE.md from the filesystem root down to cwd. */
export function loadMemory(cwd: string): MemoryFile[] {
  const found: MemoryFile[] = [];
  const add = (p: string) => {
    let fd: number | undefined;
    try {
      if (!fs.statSync(p).isFile()) return;
      fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(MAX_MEMORY_BYTES + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const content = buf.subarray(0, Math.min(n, MAX_MEMORY_BYTES)).toString('utf8');
      found.push({ path: p, content: n > MAX_MEMORY_BYTES ? `${content}\n\n(cut: only the first 256 KB of this file is loaded)` : content });
    } catch {
      /* missing or unreadable */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  add(path.join(CONFIG_DIR, 'ZOICODE.md'));
  const dirs: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of dirs) for (const name of MEMORY_FILES) add(path.join(d, name));
  return found;
}

function gitInfo(cwd: string): string {
  const gitDir = findGitDir(cwd);
  if (!gitDir) return 'Not a git repository'; // and no git process, which on a Mac without developer tools pops up an installer
  const branch = currentBranch(gitDir) ?? '(unknown)';
  // Submodules don't matter here: the status below doesn't look inside them.
  const risky = riskyGitConfig(cwd)?.filter(k => k !== 'submodules');
  if (!risky || risky.length) {
    const why = risky ? `its own git config sets ${risky.slice(0, 5).map(k => k.slice(0, 60)).join(', ')}` : 'git could not read its config';
    return `Git branch: ${branch}\nGit status: not checked, because ${why}, which can make git run other programs. Git commands here need the user's approval.`;
  }
  try {
    const status = execFileSync('git', ['status', '--short', '--ignore-submodules=all'], {
      cwd,
      env: { ...process.env, ...QUIET_GIT_ENV },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString().trimEnd();
    const lines = status.split('\n');
    const shown = lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n… ${lines.length - 20} more` : '');
    return `Git branch: ${branch}\nGit status:\n${status ? shown : '(clean)'}`;
  } catch {
    return `Git branch: ${branch}`;
  }
}

export function buildSystemPrompt(cwd: string, memory: MemoryFile[]): string {
  const memorySection = memory.length
    ? '\n# Project memory\nThese instruction files were provided by the user. Follow them.\n\n' +
      memory.map(m => `<file path="${m.path}">\n${m.content.trim()}\n</file>`).join('\n\n')
    : '';

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
Platform: ${os.platform()} ${os.release()}
Shell: bash
Date: ${new Date().toISOString().slice(0, 10)}
${gitInfo(cwd)}
${memorySection}`;
}
