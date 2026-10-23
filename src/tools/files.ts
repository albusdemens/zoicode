import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { type Tool, resolvePath, displayPath } from './types.js';

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

/**
 * Unified diff for the UI, or undefined if it takes over 200ms: diffing a large rewrite is quadratic and runs
 * on the main thread, freezing the TUI. Never throws, since it runs after the file is already written.
 */
export function makeDiff(file: string, before: string, after: string): string | undefined {
  try {
    return createTwoFilesPatch(file, file, before, after, '', '', { context: 3, timeout: 200 });
  } catch {
    return undefined;
  }
}

/** The largest file Read, Edit and Write load: past it, Grep or Bash (head, sed -n) read parts. */
const MAX_FILE_BYTES = 50_000_000;

/**
 * Reads a file as text. utf8 is false when its bytes are not valid UTF-8, so the text could not be
 * written back as is. Only regular files of a sane size: a FIFO would wait forever and /dev/zero never
 * ends. The signal stops a slow read (Esc).
 */
async function readText(abs: string, signal?: AbortSignal) {
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`${abs} is not a regular file (a device, FIFO or socket), so it is not read.`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${abs} is ${(stat.size / 1e6).toFixed(0)} MB, too large to load. Use Grep, or Bash (head, tail, sed -n) to read parts.`);
  }
  const raw = await fs.readFile(abs, { signal });
  return { text: raw.toString('utf8'), utf8: isUtf8(raw) };
}

const notUtf8 = (abs: string) =>
  `${abs} is not valid UTF-8 (a legacy encoding such as CP949/EUC-KR, Shift-JIS or Latin-1, or a binary file). ` +
  'Changing it with this tool would replace those bytes with U+FFFD and corrupt it. Use Bash (e.g. iconv) instead, ' +
  'or ask the user whether to convert the file to UTF-8.';

/** lstat, so a dangling symlink counts as existing: Write cannot create its target elsewhere without a Read first. */
async function exists(p: string) {
  return fs.lstat(p).then(() => true, () => false);
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const BAD_EDIT_ARGS = 'old_string and new_string must both be strings. To delete text, pass new_string: "".';

/** What an Edit does to a file's text. Shared with the approval prompt, so its preview matches what Edit writes. */
export function applyEdit(
  before: string,
  input: Omit<EditInput, 'file_path'>,
  file = 'the file',
): { after: string; count: number } | { error: string } {
  const { old_string: oldStr, new_string: newStr } = input;
  // Tool calls are not schema-checked, and a missing new_string would be written as "undefined" or join with ",".
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return { error: BAD_EDIT_ARGS };
  if (oldStr === newStr) return { error: 'old_string and new_string are identical.' };
  // An empty old_string matches between every character, so it may only fill an empty file.
  if (oldStr === '') {
    if (before === '') return { after: newStr, count: 1 };
    return {
      error: `old_string is empty, but ${file} is not. Give the exact text to replace, or use Write to replace the whole file.`,
    };
  }
  const parts = before.split(oldStr);
  const count = parts.length - 1;
  if (count === 0) return { error: `old_string not found in ${file}. Check whitespace and read the file again.` };
  const replaceAll = input.replace_all === true || (input.replace_all as unknown) === 'true';
  if (count > 1 && !replaceAll) {
    return { error: `old_string occurs ${count} times. Add more context to make it unique, or set replace_all.` };
  }
  return { after: replaceAll ? parts.join(newStr) : before.replace(oldStr, () => newStr), count };
}

export const ReadTool: Tool<{ file_path: string; offset?: number; limit?: number }> = {
  name: 'Read',
  description:
    'Read a file from the local filesystem. Returns lines in `cat -n` format (line number, tab, content). ' +
    `Reads up to ${MAX_LINES} lines by default; use offset (1-based line) and limit for large files. ` +
    'Always read a file before editing it.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to read (absolute or relative to cwd)' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
  readOnly: true,
  label: i => i.file_path,
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      return { output: (await exists(abs)) ? `${abs} is a broken symbolic link.` : `File does not exist: ${abs}`, isError: true };
    }
    if (stat.isDirectory()) return { output: `${abs} is a directory. Use LS to list it.`, isError: true };
    let read: { text: string; utf8: boolean };
    try {
      read = await readText(abs, ctx.signal);
    } catch (e) {
      ctx.signal?.throwIfAborted();
      return { output: (e as Error).message, isError: true };
    }
    const { text: content, utf8 } = read;
    ctx.readFiles.set(abs, stat.mtimeMs);
    if (content.length === 0) return { output: '<file is empty>', summary: 'Read empty file' };
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, input.offset ?? 1);
    const slice = lines.slice(start - 1, start - 1 + (input.limit ?? MAX_LINES));
    const out = slice
      .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`)
      .join('\n');
    const more = start - 1 + slice.length < lines.length ? `\n\n(file has ${lines.length} lines; use offset to read more)` : '';
    const note = utf8
      ? ''
      : '\n\n(This file is not valid UTF-8: undecodable bytes are shown as U+FFFD, and Edit and Write will refuse to change it.)';
    return { output: out + more + note, summary: `Read ${slice.length} lines` };
  },
};

export const WriteTool: Tool<{ file_path: string; content: string }> = {
  name: 'Write',
  description:
    'Write a file to the local filesystem, overwriting it if it exists. Parent directories are created. ' +
    'If the file already exists you must Read it first. Prefer Edit for changing existing files.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to write' },
      content: { type: 'string', description: 'Full content of the file' },
    },
    required: ['file_path', 'content'],
  },
  readOnly: false,
  label: i => i.file_path,
  async run(input, ctx) {
    if (typeof input.content !== 'string') return { output: 'content is required and must be a string.', isError: true };
    const abs = resolvePath(ctx, input.file_path);
    const existed = await exists(abs);
    if (existed && !ctx.readFiles.has(abs)) {
      return { output: `File ${abs} already exists. Read it before overwriting.`, isError: true };
    }
    // The model only ever saw U+FFFD for bytes that are not UTF-8, so whatever it writes cannot keep them.
    const current = existed ? await readText(abs, ctx.signal) : { text: '', utf8: true };
    if (!current.utf8) return { output: notUtf8(abs), isError: true };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content);
    ctx.readFiles.set(abs, (await fs.stat(abs)).mtimeMs);
    const lines = input.content.split('\n').length;
    return {
      output: `${existed ? 'Updated' : 'Created'} ${abs} (${lines} lines)`,
      summary: `${existed ? 'Wrote' : 'Created'} ${lines} lines`,
      diff: makeDiff(displayPath(ctx, abs), current.text, input.content),
    };
  },
};

export const EditTool: Tool<EditInput> = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be ' +
    'unique unless replace_all is true. Read the file first. Do not include the line-number prefix from Read output.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path of the file to edit' },
      old_string: { type: 'string', description: 'Exact text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  readOnly: false,
  label: i => i.file_path,
  async run(input, ctx) {
    // Checked before the create path below, so a bad call cannot create a file or its directories.
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
      return { output: BAD_EDIT_ARGS, isError: true };
    }
    const abs = resolvePath(ctx, input.file_path);
    if (!(await exists(abs))) {
      if (input.old_string === '') {
        return WriteTool.run({ file_path: abs, content: input.new_string }, ctx);
      }
      return { output: `File does not exist: ${abs}`, isError: true };
    }
    if (!ctx.readFiles.has(abs)) return { output: `Read ${abs} before editing it.`, isError: true };
    const mtime = (await fs.stat(abs)).mtimeMs;
    if (mtime > (ctx.readFiles.get(abs) ?? 0) + 1) {
      return { output: `${abs} changed on disk since it was read. Read it again.`, isError: true };
    }
    const { text: before, utf8 } = await readText(abs, ctx.signal);
    if (!utf8) return { output: notUtf8(abs), isError: true };
    const edit = applyEdit(before, input, abs);
    if ('error' in edit) return { output: edit.error, isError: true };
    await fs.writeFile(abs, edit.after);
    ctx.readFiles.set(abs, (await fs.stat(abs)).mtimeMs);
    const replacements = edit.count > 1 ? `${edit.count} replacements` : '1 replacement';
    const diff = makeDiff(displayPath(ctx, abs), before, edit.after);
    const lines = diff?.split('\n') ?? [];
    const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    return {
      output: `Edited ${abs} (${replacements})`,
      summary: diff ? `Added ${added} lines, removed ${removed} lines` : `Made ${replacements} (diff too large to show)`,
      diff,
    };
  },
};

export const LSTool: Tool<{ path?: string }> = {
  name: 'LS',
  description: 'List files and directories in a directory (non-recursive). Directories end with "/".',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory to list (default: cwd)' } },
  },
  readOnly: true,
  label: i => i.path ?? '.',
  async run(input, ctx) {
    const abs = resolvePath(ctx, input.path);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch((e: Error) => e);
    if (entries instanceof Error) return { output: entries.message, isError: true };
    const names = entries
      .map(e => (e.isDirectory() ? e.name + '/' : e.name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
    return { output: `${abs}\n` + names.map(n => `  ${n}`).join('\n'), summary: `Listed ${names.length} entries` };
  },
};
