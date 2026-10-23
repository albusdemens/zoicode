import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

export const MEMORY_FILES = ['RAONCODE.md', 'CLAUDE.md'];

export interface MemoryFile {
  path: string;
  content: string;
}

/** Memory files: ~/.raoncode/RAONCODE.md, then every RAONCODE.md/CLAUDE.md from the filesystem root down to cwd. */
export function loadMemory(cwd: string): MemoryFile[] {
  const found: MemoryFile[] = [];
  const add = (p: string) => {
    try {
      found.push({ path: p, content: fs.readFileSync(p, 'utf8') });
    } catch { /* missing */ }
  };
  add(path.join(CONFIG_DIR, 'RAONCODE.md'));
  const dirs: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of dirs) for (const name of MEMORY_FILES) add(path.join(d, name));
  return found;
}

function gitInfo(cwd: string): string {
  try {
    const run = (c: string) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const branch = run('git rev-parse --abbrev-ref HEAD');
    const status = run('git status --short | head -20');
    return `Git branch: ${branch}\nGit status:\n${status || '(clean)'}`;
  } catch {
    return 'Not a git repository';
  }
}

export function buildSystemPrompt(cwd: string, memory: MemoryFile[]): string {
  const memorySection = memory.length
    ? '\n# Project memory\nThese instruction files were provided by the user. Follow them.\n\n' +
      memory.map(m => `<file path="${m.path}">\n${m.content.trim()}\n</file>`).join('\n\n')
    : '';

  return `You are Raoncode, an interactive CLI coding agent. You help the user with software engineering tasks in their project: fixing bugs, adding features, refactoring, explaining code, running commands.

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
