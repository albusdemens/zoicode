/**
 * Regression tests for the file tools: npx tsx test/files.mts
 * Same style as run.mts: each test is a named function that throws on failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdit, EditTool, ReadTool, WriteTool } from '../src/tools/files.js';
import { isInsideDir, resolvePath, type ToolContext } from '../src/tools/types.js';

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-files-'));
  tmpDirs.push(dir);
  return dir;
}

function tmpCtx(): ToolContext {
  return { cwd: tmpDir(), readFiles: new Map(), state: {} };
}

/** Creates a file in the project and reads it with the Read tool, as the model does before editing. */
async function seed(ctx: ToolContext, name: string, content: string | Buffer) {
  fs.writeFileSync(path.join(ctx.cwd, name), content);
  return ReadTool.run({ file_path: name }, ctx);
}

test('Edit and Write refuse files that are not UTF-8 and leave their bytes alone', async () => {
  const ctx = tmpCtx();
  const files = {
    'latin1.c': Buffer.concat([Buffer.from('/* caf'), Buffer.from([0xe9]), Buffer.from(' 2009 */\nint x=1;\n')]),
    'cp949.c': Buffer.concat([Buffer.from('// '), Buffer.from('bec8b3e7c7cfbcbcbfe4', 'hex'), Buffer.from('\nint x=1;\n')]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    assert.match((await seed(ctx, name, bytes)).output, /not valid UTF-8/, `Read warns about ${name}`);
    const edit = await EditTool.run({ file_path: name, old_string: 'int x=1;', new_string: 'int x=2;' }, ctx);
    assert.equal(edit.isError, true, `Edit ${name}`);
    const write = await WriteTool.run({ file_path: name, content: 'int x=2;\n' }, ctx);
    assert.equal(write.isError, true, `Write ${name}`);
    assert.deepEqual(fs.readFileSync(path.join(ctx.cwd, name)), bytes, `${name} is unchanged`);
  }
});

test('Edit keeps UTF-8 text and a BOM intact', async () => {
  const ctx = tmpCtx();
  const read = await seed(ctx, 'bom.c', Buffer.from('﻿// 안녕하세요 café\nint x=1;\n'));
  assert.doesNotMatch(read.output, /not valid UTF-8/);
  const r = await EditTool.run({ file_path: 'bom.c', old_string: 'int x=1;', new_string: 'int x=2;' }, ctx);
  assert.equal(r.isError, undefined);
  assert.deepEqual(fs.readFileSync(path.join(ctx.cwd, 'bom.c')), Buffer.from('﻿// 안녕하세요 café\nint x=2;\n'));
});

test('a huge rewrite skips the diff instead of blocking the event loop', async () => {
  const ctx = tmpCtx();
  const gen = (tag: string) =>
    Array.from({ length: 10_000 }, (_, i) => `  "key_${i}": "${tag}_${(i * 2654435761) % 1000003}",`).join('\n') + '\n';
  await seed(ctx, 'big.json', gen('old'));
  let start = Date.now();
  const w = await WriteTool.run({ file_path: 'big.json', content: gen('new') }, ctx);
  assert.ok(Date.now() - start < 3000, `Write took ${Date.now() - start}ms`); // ~17s with an unbounded diff
  assert.equal(w.isError, undefined);
  assert.equal(w.diff, undefined);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'big.json'), 'utf8'), gen('new'));

  start = Date.now();
  const e = await EditTool.run({ file_path: 'big.json', old_string: '"key_', new_string: '"KEY_', replace_all: true }, ctx);
  assert.ok(Date.now() - start < 3000, `Edit took ${Date.now() - start}ms`);
  assert.equal(e.isError, undefined);
  assert.equal(e.diff, undefined);
  assert.equal(e.summary, 'Made 10000 replacements (diff too large to show)');
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'big.json'), 'utf8'), gen('new').replaceAll('"key_', '"KEY_'));
});

test('a small edit in a large file still gets its diff', async () => {
  const ctx = tmpCtx();
  await seed(ctx, 'huge.txt', Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const r = await EditTool.run({ file_path: 'huge.txt', old_string: 'line 25000\n', new_string: 'line 25000 changed\n' }, ctx);
  assert.equal(r.summary, 'Added 1 lines, removed 1 lines');
  assert.match(r.diff ?? '', /^\+line 25000 changed$/m);
});

test('Edit rejects an empty old_string on a file that has content', async () => {
  const ctx = tmpCtx();
  await seed(ctx, 'a.ts', 'const x = "café";\n');
  for (const replace_all of [false, true]) {
    const r = await EditTool.run({ file_path: 'a.ts', old_string: '', new_string: 'HEADER\n', replace_all }, ctx);
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.output, /set replace_all/, 'must not steer the model into replace_all');
  }
  await seed(ctx, 'ab.ts', 'ab'); // '' used to match exactly once here and silently prepend
  assert.equal((await EditTool.run({ file_path: 'ab.ts', old_string: '', new_string: 'X' }, ctx)).isError, true);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'a.ts'), 'utf8'), 'const x = "café";\n');
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'ab.ts'), 'utf8'), 'ab');

  // An empty old_string still creates a new file or fills an empty one.
  await seed(ctx, 'empty.ts', '');
  assert.equal((await EditTool.run({ file_path: 'empty.ts', old_string: '', new_string: 'filled\n' }, ctx)).isError, undefined);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'empty.ts'), 'utf8'), 'filled\n');
  assert.equal((await EditTool.run({ file_path: 'new.ts', old_string: '', new_string: 'created\n' }, ctx)).isError, undefined);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'new.ts'), 'utf8'), 'created\n');
});

test('Edit and Write reject missing or non-string text instead of writing "undefined"', async () => {
  const ctx = tmpCtx();
  const original = 'keep();\nlog();\nkeep2();\nlog();\n';
  await seed(ctx, 'f.js', original);
  const bad: any[] = [
    { old_string: 'keep2();\n' },
    { old_string: 'log();\n', replace_all: true },
    { old_string: 'keep2();\n', new_string: null },
    { old_string: 'log();\n', new_string: null, replace_all: true },
    { new_string: 'x' },
  ];
  for (const input of bad) {
    const r = await EditTool.run({ file_path: 'f.js', ...input }, ctx);
    assert.equal(r.isError, true, JSON.stringify(input));
  }
  assert.equal((await WriteTool.run({ file_path: 'f.js' } as any, ctx)).isError, true);
  assert.equal((await WriteTool.run({ file_path: 'f.js', content: ['a'] } as any, ctx)).isError, true);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'f.js'), 'utf8'), original);

  // Nothing is created for a new file either, not even its directories.
  assert.equal((await EditTool.run({ file_path: 'deep/new.js', old_string: '' } as any, ctx)).isError, true);
  assert.equal((await WriteTool.run({ file_path: 'deeper/new.js' } as any, ctx)).isError, true);
  assert.deepEqual(fs.readdirSync(ctx.cwd).sort(), ['f.js']);
});

test('replace_all sent as a string means what the model meant', async () => {
  const ctx = tmpCtx();
  await seed(ctx, 'b.js', 'x();\nx();\n');
  let r = await EditTool.run({ file_path: 'b.js', old_string: 'x();', new_string: 'y();', replace_all: 'false' } as any, ctx);
  assert.equal(r.isError, true, '"false" must not replace every match');
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'b.js'), 'utf8'), 'x();\nx();\n');
  r = await EditTool.run({ file_path: 'b.js', old_string: 'x();', new_string: 'y();', replace_all: 'true' } as any, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'b.js'), 'utf8'), 'y();\ny();\n');
});

test('applyEdit is the same edit Edit makes, for the approval preview', () => {
  assert.deepEqual(applyEdit('a b a', { old_string: 'a', new_string: '$&', replace_all: true }), { after: '$& b $&', count: 2 });
  assert.deepEqual(applyEdit('one two', { old_string: 'two', new_string: '$1' }), { after: 'one $1', count: 1 });
  assert.deepEqual(applyEdit('', { old_string: '', new_string: 'x' }), { after: 'x', count: 1 });
  assert.ok('error' in applyEdit('abc', { old_string: '', new_string: 'x' }));
  assert.ok('error' in applyEdit('abc', { old_string: 'b' } as any));
  assert.ok('error' in applyEdit('a a', { old_string: 'a', new_string: 'b' }));
});

test('paths starting with ~ resolve to the home directory', async () => {
  const ctx = tmpCtx();
  const home = tmpDir();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(resolvePath(ctx, '~'), home);
    assert.equal(resolvePath(ctx, '~/.bashrc'), path.join(home, '.bashrc'));
    assert.equal(resolvePath({ cwd: ctx.cwd }, '~/a/../b'), path.join(home, 'b'), 'a plain cwd works too');
    assert.equal(resolvePath(ctx, '~user/x'), path.join(ctx.cwd, '~user', 'x'), 'only ~ and ~/ are expanded');
    assert.equal(resolvePath(ctx, 'src/a.ts'), path.join(ctx.cwd, 'src', 'a.ts'));

    // The tools act on the real file, so the read-first rule covers ~ paths too.
    fs.writeFileSync(path.join(home, '.bashrc'), 'alias ll="ls -l"\n');
    assert.equal((await WriteTool.run({ file_path: '~/.bashrc', content: 'x\n' }, ctx)).isError, true, 'not read yet');
    await ReadTool.run({ file_path: path.join(home, '.bashrc') }, ctx);
    assert.equal((await EditTool.run({ file_path: '~/.bashrc', old_string: 'll', new_string: 'la' }, ctx)).isError, undefined);
    assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), 'alias la="ls -l"\n');
    assert.equal(fs.existsSync(path.join(ctx.cwd, '~')), false);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test('isInsideDir follows symlinks that lead out of the project', () => {
  const root = tmpDir();
  const proj = path.join(root, 'proj');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'existing.txt'), 'x');
  fs.symlinkSync(path.join(outside, 'existing.txt'), path.join(proj, 'notes.md'));
  fs.symlinkSync(path.join(outside, 'planted.sh'), path.join(proj, 'build.sh')); // dangling: a write creates it outside
  fs.symlinkSync(path.join(outside, 'deep'), path.join(proj, 'linkdir'));
  fs.symlinkSync('../escape.txt', path.join(outside, 'deep', 'up')); // relative to the link's real directory
  fs.symlinkSync('src', path.join(proj, 'srclink'));
  fs.symlinkSync('loop2', path.join(proj, 'loop1'));
  fs.symlinkSync('loop1', path.join(proj, 'loop2'));
  const inside = (p: string) => isInsideDir(proj, resolvePath({ cwd: proj }, p));

  assert.equal(inside('src/a.ts'), true);
  assert.equal(inside('new/dir/file.ts'), true);
  assert.equal(inside('srclink/a.ts'), true);
  assert.equal(inside('.'), true);
  assert.equal(inside('../outside/existing.txt'), false);
  assert.equal(inside(path.join(root, 'proj-evil', 'x')), false, 'a sibling that shares the prefix');
  assert.equal(inside('notes.md'), false);
  assert.equal(inside('build.sh'), false);
  assert.equal(inside('linkdir/new.txt'), false);
  assert.equal(inside('linkdir/up'), false, 'lexically this would be proj/escape.txt');
  assert.equal(typeof inside('loop1'), 'boolean', 'a symlink loop terminates');

  // The project itself may be reached through a symlink.
  const projLink = path.join(root, 'projlink');
  fs.symlinkSync(proj, projLink);
  assert.equal(isInsideDir(projLink, path.join(projLink, 'src', 'a.ts')), true);
  assert.equal(isInsideDir(proj, path.join(projLink, 'src', 'a.ts')), true);
});

test('Write and Edit do not create files through a dangling symlink', async () => {
  const ctx = tmpCtx();
  const outside = tmpDir();
  fs.symlinkSync(path.join(outside, 'planted.sh'), path.join(ctx.cwd, 'build.sh'));
  assert.equal((await WriteTool.run({ file_path: 'build.sh', content: 'echo planted\n' }, ctx)).isError, true);
  assert.equal((await EditTool.run({ file_path: 'build.sh', old_string: '', new_string: 'echo planted\n' }, ctx)).isError, true);
  assert.match((await ReadTool.run({ file_path: 'build.sh' }, ctx)).output, /broken symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, 'planted.sh')), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${(e as Error).message.split('\n').join('\n  ')}`);
  }
}
for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
