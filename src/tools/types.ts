import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Absolute paths the model has read in this session (Edit/Write require a prior Read). */
  readFiles: Map<string, number>;
  /** Shared state for tools that keep state across calls, e.g. TodoWrite. */
  state: Record<string, unknown>;
  /** Runs a subagent on a task and resolves with its final report (Task tool). */
  runSubagent?: (description: string, prompt: string, progress: (message: string) => void) => Promise<{ text: string; toolUses: number }>;
  /** Reports progress of the currently running tool to the UI. */
  progress?: (message: string) => void;
}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  isError?: boolean;
  /** One-line summary for the UI, e.g. "Read 120 lines". */
  summary?: string;
  /** Unified diff for file edits, rendered in color by the UI. */
  diff?: string;
}

export interface Tool<I = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools never prompt for permission. */
  readOnly: boolean;
  /** Short human label for the call, e.g. the file path or command. */
  label(input: I): string;
  /** Optional check that lets e.g. safe bash commands skip the prompt. */
  isSafe?(input: I): boolean;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Resolves a tool's path argument against cwd; a leading ~ is the home directory, as in a shell.
 * Anything that shows or checks a tool's target (e.g. the approval prompt) must use this too, so it sees the same file.
 */
export function resolvePath(ctx: Pick<ToolContext, 'cwd'>, p: string | undefined): string {
  if (!p) return ctx.cwd;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(ctx.cwd, p);
}

export function displayPath(ctx: Pick<ToolContext, 'cwd'>, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

/** Where a write to abs really lands: every symlink is followed, including a dangling one, which a write would create. */
function realTarget(abs: string): string {
  abs = path.resolve(abs);
  const parts = abs.split(path.sep).filter(Boolean);
  let real = path.parse(abs).root;
  for (let links = 0; parts.length; ) {
    const next = path.join(real, parts.shift()!);
    let link: string;
    try {
      link = fs.readlinkSync(next);
    } catch {
      real = next; // not a symlink, or does not exist yet
      continue;
    }
    if (++links > 40) return next; // a symlink loop: writing there fails with ELOOP anyway
    parts.unshift(...link.split(path.sep).filter(Boolean));
    if (path.isAbsolute(link)) real = path.parse(link).root;
  }
  return real;
}

/** Whether abs is inside dir once symlinks are followed, so a link in the project that points elsewhere is outside. */
export function isInsideDir(dir: string, abs: string): boolean {
  const rel = path.relative(realTarget(dir), realTarget(abs));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function truncate(s: string, max = 30000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - max} characters truncated] ...\n\n${s.slice(-half)}`;
}
