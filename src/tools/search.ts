import fsCb from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { glob, type FileSystemAdapter } from 'tinyglobby';
import { type Tool, resolvePath, truncate } from './types.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/__pycache__/**'];

/**
 * File walks follow symlinks, so a symlinked file is searched like any other. A symlinked directory
 * that leads back to one of the directories above it (`src/up -> ..`) would repeat the tree forever,
 * so this fs adapter fails to resolve such a link (the loop check `find -L` makes, by dev:ino), and
 * the walk skips it.
 */
function loopGuard(): FileSystemAdapter {
  const ids = new Map<string, Promise<string | undefined>>(); // directory path -> dev:ino
  const idOf = (p: string) => {
    let id = ids.get(p);
    // An ino of 0 means the filesystem has no inode numbers, so there is nothing to compare.
    if (!id) ids.set(p, (id = fs.stat(p).then(st => (st.ino ? `${st.dev}:${st.ino}` : undefined), () => undefined)));
    return id;
  };
  async function loops(link: string, target: string): Promise<boolean> {
    const st = await fs.stat(target).catch(() => null);
    if (!st?.isDirectory() || !st.ino) return false;
    const id = `${st.dev}:${st.ino}`;
    for (let dir = path.dirname(link), up = path.dirname(dir); ; dir = up, up = path.dirname(dir)) {
      if ((await idOf(dir)) === id) return true;
      if (up === dir) return false;
    }
  }
  function realpath(link: string, cb: (err: NodeJS.ErrnoException | null, resolved: string) => void) {
    fsCb.realpath(link, (err, resolved) => {
      if (err) return cb(err, resolved);
      loops(link, resolved).then(loop =>
        cb(loop ? Object.assign(new Error(`symlink loop at ${link}`), { code: 'ELOOP' }) : null, resolved),
      );
    });
  }
  return { realpath: realpath as FileSystemAdapter['realpath'] };
}

/** Files under cwd matching pattern, as absolute paths. Stops early (with what it found) when interrupted. */
function walk(pattern: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  return glob(pattern, {
    cwd, ignore: IGNORE, dot: true, absolute: true, onlyFiles: true, expandDirectories: false, signal, fs: loopGuard(),
  });
}

export const GlobTool: Tool<{ pattern: string; path?: string }> = {
  name: 'Glob',
  description:
    'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns paths sorted by modification ' +
    'time, newest first. Ignores node_modules, .git and build output.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  readOnly: true,
  label: i => i.pattern + (i.path ? ` in ${i.path}` : ''),
  async run(input, ctx) {
    const cwd = resolvePath(ctx, input.path);
    const paths = await walk(input.pattern, cwd, ctx.signal);
    ctx.signal?.throwIfAborted();
    const mtimes = await Promise.all(paths.map(p => fs.stat(p).then(st => st.mtimeMs, () => 0)));
    const entries = paths.map((path, i) => ({ path, mtime: mtimes[i] })).sort((a, b) => b.mtime - a.mtime);
    const files = entries.slice(0, 200).map(e => e.path);
    if (!files.length) return { output: 'No files found', summary: 'Found 0 files' };
    const more = entries.length > files.length ? `\n(${entries.length - files.length} more not shown)` : '';
    return { output: files.join('\n') + more, summary: `Found ${entries.length} file${entries.length === 1 ? '' : 's'}` };
  },
};

/** Directory searches skip text files bigger than this (and say so); a file passed as `path` is always searched. */
const WALK_MAX_BYTES = 50_000_000;
/** Files are read in chunks of this size, so memory stays flat however big a file is. */
const CHUNK_BYTES = 1 << 20;
/** A file is searched up to a line this long, so a file without newlines can't grow one string without bound. */
const MAX_LINE = 4 << 20;
/** A file is skipped when the regex spends this long on one chunk of it: the pattern is backtracking. */
const SLOW_MS = 5_000;
/** The whole search stops after this and returns what it found so far. */
const BUDGET_MS = 60_000;

/**
 * The regex runs in a worker thread. A model-written pattern can backtrack for minutes on one long minified line,
 * and on the main thread that freezes the UI and swallows Esc; a worker can be terminated mid-match.
 */
const MATCHER_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', ({ text, first }) => {
  const lines = text.split('\\n');
  if (lines[lines.length - 1] === '') lines.pop(); // text ends with a newline
  const hits = [];
  for (let i = 0; i < lines.length && !(first && hits.length); i++) if (re.test(lines[i])) hits.push([i, lines[i].slice(0, 500)]);
  parentPort.postMessage({ hits, lines: lines.length });
});`;

interface Matches {
  /** Index within the text and the (shortened) line, for each matching line. */
  hits: [number, string][];
  /** How many lines the text had. */
  lines: number;
}

class SlowPattern extends Error {}

function lineMatcher(pattern: string, flags: string) {
  let worker: Worker | undefined;
  // Errors are handled per match below; this listener only keeps a late one from crashing the process.
  const spawn = () => new Worker(MATCHER_WORKER, { eval: true, workerData: { pattern, flags }, execArgv: [] }).on('error', () => {});
  const close = () => {
    void worker?.terminate();
    worker = undefined;
  };
  /** Tests each line of text (whole lines only), stopping at the first match with `first`. */
  const match = (text: string, first: boolean, signal?: AbortSignal) =>
    new Promise<Matches>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const w = (worker ??= spawn());
      const settle = (err: unknown, matches?: Matches) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        w.off('message', onMatches).off('error', settle);
        if (matches) return resolve(matches);
        close(); // it may still be stuck in the regex
        reject(err);
      };
      const onMatches = (matches: Matches) => settle(null, matches);
      const onAbort = () => settle(signal!.reason);
      const timer = setTimeout(() => settle(new SlowPattern()), SLOW_MS);
      w.on('message', onMatches).on('error', settle);
      signal?.addEventListener('abort', onAbort);
      w.postMessage({ text, first });
    });
  return { match, close };
}

interface ScanOptions {
  matcher: ReturnType<typeof lineMatcher>;
  /** Read buffer, shared by all files of one search. */
  buf: Buffer;
  /** Part of a directory search (rather than a file passed as `path`), so the size limit applies. */
  inWalk: boolean;
  /** Stop at the first matching line. */
  first: boolean;
  signal: AbortSignal;
}

/**
 * Streams one file through the matcher. Binary files are skipped silently; if anything else keeps the file from
 * being searched in full, the reason is returned, so the result can say so instead of implying there is no match.
 */
async function scanFile(file: string, o: ScanOptions, onMatch: (lineNo: number, line: string) => void): Promise<string | undefined> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(file, 'r');
  } catch (e) {
    return problemOf(e);
  }
  try {
    const decoder = new StringDecoder('utf8');
    let text = ''; // read but not matched yet
    let lineNo = 0;
    for (let pos = 0; ; ) {
      o.signal.throwIfAborted();
      const { bytesRead } = await fh.read(o.buf, 0, o.buf.length, pos);
      if (pos === 0) {
        if (o.buf.subarray(0, Math.min(bytesRead, 8000)).includes(0)) return undefined; // binary
        const size = o.inWalk && bytesRead === o.buf.length ? (await fh.stat()).size : 0; // only a full first read can be big
        if (size > WALK_MAX_BYTES) {
          return `${(size / 1e6).toFixed(1)} MB, over the ${WALK_MAX_BYTES / 1e6} MB limit for directory searches; pass it as path to search it`;
        }
      }
      pos += bytesRead;
      const eof = bytesRead === 0;
      text += eof ? decoder.end() : decoder.write(o.buf.subarray(0, bytesRead));
      if (!eof && text.length < o.buf.length) continue; // so a small file is matched in one go
      // Match the whole lines; an unfinished last line waits for the next chunk, unless it is far too long.
      let end = eof ? text.length : text.lastIndexOf('\n') + 1;
      const cut = text.length - end > MAX_LINE;
      if (cut) end = text.length;
      if (end) {
        const { hits, lines } = await o.matcher.match(text.slice(0, end), o.first, o.signal);
        for (const [i, line] of hits) onMatch(lineNo + i + 1, line);
        lineNo += lines;
        if (o.first && hits.length) return undefined;
        text = text.slice(end);
      }
      if (cut) return `searched up to line ${lineNo}, which is over ${MAX_LINE >> 20} MB long`;
      if (eof) return undefined;
    }
  } catch (e) {
    if (e instanceof SlowPattern) return `the regex ran for over ${SLOW_MS / 1000}s on its lines; try a simpler pattern`;
    if (o.signal.aborted) throw e;
    return problemOf(e);
  } finally {
    await fh.close();
  }
}

function problemOf(e: unknown): string | undefined {
  const { code, syscall, message } = e as NodeJS.ErrnoException;
  if (code === 'ENOENT') return undefined; // a dangling symlink, or deleted since the listing
  return syscall ? `could not read it: ${code}` : `could not search it: ${message}`;
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: 'files_with_matches' | 'content' | 'count';
}

export const GrepTool: Tool<GrepInput> = {
  name: 'Grep',
  description:
    'Search file contents with a JavaScript regular expression. output_mode "files_with_matches" (default) ' +
    'lists matching files, "content" shows matching lines with line numbers, "count" shows match counts. ' +
    'Filter files with glob, e.g. "*.ts" or "**/*.{js,jsx}". Directory searches skip binary files and text ' +
    `files over ${WALK_MAX_BYTES / 1e6} MB; pass a file as path to search it whatever its size.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: cwd)' },
      glob: { type: 'string', description: 'Glob filter for files' },
      case_insensitive: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'] },
    },
    required: ['pattern'],
  },
  readOnly: true,
  label: i => `"${i.pattern}"` + (i.path ? ` in ${i.path}` : '') + (i.glob ? ` (${i.glob})` : ''),
  async run(input, ctx) {
    const flags = input.case_insensitive ? 'i' : '';
    try {
      new RegExp(input.pattern, flags);
    } catch (e) {
      return { output: `Invalid regex: ${(e as Error).message}`, isError: true };
    }
    const root = resolvePath(ctx, input.path);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) return { output: `Path does not exist: ${root}`, isError: true };
    const filePattern = input.glob ? (input.glob.includes('/') ? input.glob : `**/${input.glob}`) : '**/*';
    const budget = AbortSignal.timeout(BUDGET_MS);
    const signal = AbortSignal.any([budget, ...(ctx.signal ? [ctx.signal] : [])]);

    const mode = input.output_mode ?? 'files_with_matches';
    const out: string[] = [];
    const notSearched: string[] = [];
    let matchedFiles = 0;
    let matchedLines = 0;
    let stopped = false;
    // A leading `.*` can't change whether a line matches, but it makes every test quadratic in the line length.
    const matcher = lineMatcher(input.pattern.replace(/^(?:\.\*\??)+/, ''), flags);
    const scan: ScanOptions = {
      matcher, buf: Buffer.allocUnsafe(CHUNK_BYTES), inWalk: !stat.isFile(), first: mode === 'files_with_matches', signal,
    };
    try {
      const files = stat.isFile()
        ? [root]
        : await walk(filePattern, root, signal);
      signal.throwIfAborted(); // an interrupted walk ends early, perhaps with nothing listed; scanFile checks per chunk
      for (const file of files) {
        let count = 0;
        const problem = await scanFile(file, scan, (lineNo, line) => {
          count++;
          if (mode === 'content' && matchedLines + count <= 500) out.push(`${file}:${lineNo}:${line.slice(0, 500)}`);
        });
        if (problem) notSearched.push(`${file} (${problem})`);
        if (!count) continue;
        matchedFiles++;
        matchedLines += count;
        if (mode === 'files_with_matches') out.push(file);
        if (mode === 'count') out.push(`${file}:${count}`);
      }
    } catch (e) {
      if (ctx.signal?.aborted || !budget.aborted) throw e;
      stopped = true;
    } finally {
      matcher.close();
    }

    let note = '';
    if (stopped) note += `\n\n(Search stopped after ${BUDGET_MS / 1000}s, so results are incomplete. Narrow it down with path or glob.)`;
    if (notSearched.length) {
      const more = notSearched.length > 10 ? `, and ${notSearched.length - 10} more` : '';
      note += `\n\n(Not fully searched: ${notSearched.slice(0, 10).join(', ')}${more}.)`;
    }
    if (!matchedFiles) return { output: 'No matches found' + note, summary: 'No matches' };
    return {
      output: truncate(out.join('\n'), 20000) + note,
      summary: mode === 'content' ? `Found ${matchedLines} lines` : `Found ${matchedFiles} file${matchedFiles === 1 ? '' : 's'}`,
    };
  },
};
