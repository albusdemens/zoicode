/**
 * Regression tests for Grep, Glob, WebFetch and TodoWrite: npx tsx test/search-web.mts
 * Same style as test/run.mts: each test is a named function that throws on failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { GlobTool, GrepTool } from '../src/tools/search.js';
import { TodoWriteTool } from '../src/tools/todo.js';
import type { ToolContext } from '../src/tools/types.js';
import { htmlToText, WebFetchTool } from '../src/tools/web.js';

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const dirs: string[] = [];
function tmpCtx(signal?: AbortSignal): ToolContext {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-test-'));
  dirs.push(cwd);
  return { cwd, readFiles: new Map(), state: {}, signal };
}

/** Fails instead of hanging when a tool never returns. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no result after ${ms}ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// --- Grep: big files ---

test('Grep does not load big binary files into memory', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'src.txt'), 'needle here\n');
  fs.writeFileSync(path.join(ctx.cwd, 'model.bin'), '');
  fs.truncateSync(path.join(ctx.cwd, 'model.bin'), 300e6); // sparse zeros
  const before = process.resourceUsage().maxRSS; // KB
  const r = await GrepTool.run({ pattern: 'needle' }, ctx);
  assert.match(r.output, /src\.txt/);
  assert.doesNotMatch(r.output, /model\.bin/, 'binaries are skipped silently');
  assert.ok(process.resourceUsage().maxRSS - before < 150_000, 'the 300 MB binary must not be read into memory');
});

test('Grep searches files over 5 MB, in a directory search and when passed as path', async () => {
  const ctx = tmpCtx();
  const lines = Array.from({ length: 70_000 }, (_, i) => `2026-10-23 INFO request ${i} served`);
  lines[65_000] = '2026-10-23 ERROR database connection refused';
  fs.writeFileSync(path.join(ctx.cwd, 'app.log'), lines.join('\n') + '\n'); // ~2.6 MB
  fs.appendFileSync(path.join(ctx.cwd, 'app.log'), 'padding line\n'.repeat(300_000)); // the file is now 6.4 MB
  for (const input of [{ pattern: 'ERROR', output_mode: 'content' as const }, { pattern: 'ERROR', path: 'app.log', output_mode: 'content' as const }]) {
    const r = await GrepTool.run(input, ctx);
    assert.match(r.output, /app\.log:65001:2026-10-23 ERROR database/, JSON.stringify(input));
  }
});

test('Grep line numbers stay right across read chunks', async () => {
  const ctx = tmpCtx();
  // 100-byte lines, so the 1 MiB chunk boundary falls inside line 10486; put a match (with a 3-byte character) across it.
  const lines = Array.from({ length: 30_000 }, () => 'x'.repeat(99));
  const at = (1 << 20) - 10485 * 100; // offset of the boundary within line 10486
  lines[10485] = 'x'.repeat(at - 4) + 'nee한dle' + 'x'.repeat(99 - at - 6);
  lines[29_999] = 'last needle'; // no trailing newline
  fs.writeFileSync(path.join(ctx.cwd, 'f.txt'), lines.join('\n'));
  const r = await GrepTool.run({ pattern: 'nee한dle|needle', path: 'f.txt', output_mode: 'content' }, ctx);
  assert.deepEqual(r.output.split('\n').map(l => l.split(':')[1]), ['10486', '30000']);
});

test('Grep says which files it skipped for size instead of implying no match', async () => {
  const ctx = tmpCtx();
  const big = path.join(ctx.cwd, 'big.log');
  fs.writeFileSync(big, 'needle\n'.repeat(3000)); // text up front...
  fs.truncateSync(big, 60e6); // ...then a sparse run of zeros: a 60 MB "text" file without a newline
  let r = await GrepTool.run({ pattern: 'needle' }, ctx);
  assert.match(r.output, /^No matches found/);
  assert.match(r.output, /Not fully searched: .*big\.log \(60\.0 MB, over the 50 MB limit/);
  // Passed as path it is searched, up to the endless line of zeros.
  r = await GrepTool.run({ pattern: 'needle', path: 'big.log', output_mode: 'count' }, ctx);
  assert.match(r.output, /big\.log:3000/);
  assert.match(r.output, /searched up to line 3001, which is over 4 MB long/);
});

// --- Grep: runaway regexes ---

const BACKTRACKS = 'a'.repeat(30) + 'b\n'; // /(a+)+$/ needs about 2^30 steps to give up on this line

test('a backtracking regex neither blocks the event loop nor ignores an interrupt', async () => {
  const controller = new AbortController();
  const ctx = tmpCtx(controller.signal);
  fs.writeFileSync(path.join(ctx.cwd, 'slow.txt'), BACKTRACKS);
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 20);
  setTimeout(() => controller.abort(), 300);
  const start = Date.now();
  await assert.rejects(within(5000, GrepTool.run({ pattern: '(a+)+$' }, ctx)), { name: 'AbortError' });
  clearInterval(heartbeat);
  assert.ok(Date.now() - start < 2000, 'the interrupt must stop the regex');
  assert.ok(ticks >= 5, `the event loop must keep running (${ticks} ticks)`);
});

test('a file that keeps the regex busy is skipped and named, and the search goes on', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'slow.txt'), BACKTRACKS);
  fs.writeFileSync(path.join(ctx.cwd, 'ok.txt'), 'aaa\n');
  const r = await within(30_000, GrepTool.run({ pattern: '(a+)+$' }, ctx));
  assert.match(r.output, /ok\.txt/);
  assert.match(r.output, /Not fully searched: .*slow\.txt \(the regex ran for over 5s/);
});

test('a leading .* does not make long lines slow', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'bundle.min.js'), 'var a=function(b){return b};'.repeat(10_000)); // one 280K-char line
  fs.writeFileSync(path.join(ctx.cwd, 'App.tsx'), 'useEffect(() => {}, []);\n');
  const r = await GrepTool.run({ pattern: '.*useEffect.*' }, ctx);
  assert.match(r.output, /App\.tsx/);
  assert.doesNotMatch(r.output, /Not fully searched/, 'the minified file must be searched, not timed out');
});

// --- Glob / Grep: symlinks ---

test('Glob and Grep survive symlink loops and still follow symlinked files', async () => {
  const ctx = tmpCtx();
  fs.mkdirSync(path.join(ctx.cwd, 'src'));
  fs.writeFileSync(path.join(ctx.cwd, 'src/a.ts'), 'const needle = 1;\n');
  fs.symlinkSync('..', path.join(ctx.cwd, 'src/up1')); // two loops: without a guard the walk never ends
  fs.symlinkSync('..', path.join(ctx.cwd, 'src/up2'));
  fs.symlinkSync('src/a.ts', path.join(ctx.cwd, 'link.ts'));
  const glob = await within(10_000, GlobTool.run({ pattern: '**/*.ts' }, ctx));
  assert.deepEqual(glob.output.split('\n').map(p => path.relative(ctx.cwd, p)).sort(), ['link.ts', 'src/a.ts']);
  const grep = await within(10_000, GrepTool.run({ pattern: 'needle' }, ctx));
  assert.deepEqual(grep.output.split('\n').map(p => path.relative(ctx.cwd, p)).sort(), ['link.ts', 'src/a.ts']);
});

test('an interrupted Glob or Grep throws instead of reporting that nothing was found', async () => {
  const ctx = tmpCtx(AbortSignal.abort());
  fs.writeFileSync(path.join(ctx.cwd, 'a.ts'), 'needle\n');
  await assert.rejects(GlobTool.run({ pattern: '**/*.ts' }, ctx), { name: 'AbortError' });
  await assert.rejects(GrepTool.run({ pattern: 'needle' }, ctx), { name: 'AbortError' });
});

// --- WebFetch ---

/** A local server; WebFetch allows plain http for 127.0.0.1 and localhost. */
async function serve(handler: http.RequestListener): Promise<{ base: string; close: () => void }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

/** Writes 64 KiB chunks until the client goes away. */
async function endless(res: http.ServerResponse) {
  const chunk = Buffer.alloc(65536, 'a');
  let open = true;
  res.on('close', () => (open = false));
  while (open) {
    if (res.write(chunk)) await new Promise(resolve => setImmediate(resolve));
    else await new Promise<void>(resolve => {
      const done = () => (res.off('drain', done).off('close', done), resolve());
      res.on('drain', done).on('close', done);
    });
  }
}

test('WebFetch stops reading a response at the size limit', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(6e6, 'a')); // 6 MB of text, a few KB on the wire
  const server = await serve((req, res) => {
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(bomb.length) }).end(bomb);
      return;
    }
    // Bodies that never end: plain text, a zip, and one that declares 200 MB up front.
    const headers: Record<string, Record<string, string>> = { '/zip': { 'content-type': 'application/zip' }, '/declared': { 'content-length': '200000000' } };
    res.writeHead(200, { 'content-type': 'text/plain', ...headers[req.url!] });
    void endless(res);
  });
  try {
    const fetchPath = (p: string) => within(10_000, WebFetchTool.run({ url: server.base + p }, tmpCtx()));
    for (const p of ['/endless', '/declared', '/gzip']) {
      const r = await fetchPath(p);
      assert.equal(r.isError, true, p);
      assert.match(r.output, /^Response too large/, p);
    }
    assert.match((await fetchPath('/zip')).output, /^Unsupported content type: application\/zip/);
  } finally {
    server.close();
  }
});

test('WebFetch follows redirects on the same host only, and checks every hop', async () => {
  let secretHits = 0;
  const server = await serve((req, res) => {
    const to: Record<string, string> = {
      '/old': '/new',
      '/away': `http://localhost:${req.socket.localPort}/secret`,
      '/file': 'file:///etc/passwd',
      '/loop': '/loop',
    };
    if (req.url === '/secret') secretHits++;
    if (to[req.url!]) res.writeHead(302, { location: to[req.url!] }).end();
    else res.writeHead(200, { 'content-type': 'text/plain' }).end(`page ${req.url}`);
  });
  try {
    const fetchPath = (p: string) => WebFetchTool.run({ url: server.base + p }, tmpCtx());
    const moved = await fetchPath('/old');
    assert.match(moved.output, new RegExp(`^URL: ${server.base}/new\\n[\\s\\S]*page /new`));
    const away = await fetchPath('/away');
    assert.notEqual(away.isError, true);
    assert.match(away.output, /redirects to a different host: http:\/\/localhost:\d+\/secret\nIt was not fetched/);
    assert.equal(secretHits, 0, 'the other host must not be contacted');
    const file = await fetchPath('/file');
    assert.equal(file.isError, true);
    assert.match(file.output, /Only http and https URLs are supported/);
    assert.match((await fetchPath('/loop')).output, /^Too many redirects/);
  } finally {
    server.close();
  }
});

test('htmlToText survives numeric entities that are not valid characters', () => {
  const t = htmlToText('<h1>T &#x110000;</h1><p>a &#1114112; b &#99999999999; c &#xD800; d &#0; e &#169; &#x10FFFF; &#abc;</p>');
  assert.equal(t, '# T \ufffd\n\na \ufffd b \ufffd c \ufffd d \ufffd e \u00a9 \u{10FFFF} &#abc;');
});

// --- TodoWrite ---

test('TodoWrite accepts a list sent as a JSON string', async () => {
  const ctx = tmpCtx();
  const todos = [{ content: 'Read the parser', status: 'completed' }, { content: 'Fix it', status: 'in_progress' }];
  assert.equal(TodoWriteTool.label({ todos: JSON.stringify(todos) as never }), '2 items');
  const r = await TodoWriteTool.run({ todos: JSON.stringify(todos) as never }, ctx);
  assert.equal(r.isError, undefined);
  assert.deepEqual(ctx.state.todos, todos);
});

test('TodoWrite rejects a malformed list and keeps the previous one', async () => {
  const prior = [{ content: 'Keep me', status: 'in_progress' }];
  for (const todos of ["[{'content': 'x', 'status': 'pending'}]", undefined, null, { content: 'x', status: 'pending' }, ['a', 'b'], [{ content: 'x', status: 'done' }]]) {
    const ctx = { ...tmpCtx(), state: { todos: prior } };
    const r = await TodoWriteTool.run({ todos: todos as never }, ctx);
    assert.equal(r.isError, true, JSON.stringify(todos));
    assert.equal(ctx.state.todos, prior, JSON.stringify(todos));
    assert.equal(TodoWriteTool.label({ todos: todos as never }), 'invalid list');
  }
  const ctx = { ...tmpCtx(), state: { todos: prior } };
  await TodoWriteTool.run({ todos: [] }, ctx);
  assert.deepEqual(ctx.state.todos, [], 'an explicit [] still clears the list');
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${name}\n  ${(e as Error).message.split('\n').join('\n  ')}`);
    }
  }
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
