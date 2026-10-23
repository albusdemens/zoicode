/**
 * Unit tests: npx tsx test/run.ts
 * Small and dependency-free on purpose: each test is a named function that throws on failure.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSafeCommand } from '../src/tools/bash.js';
import { EditTool, ReadTool, WriteTool } from '../src/tools/files.js';
import { GrepTool } from '../src/tools/search.js';
import type { ToolContext } from '../src/tools/types.js';
import { htmlToText } from '../src/tools/web.js';
import { validateAll } from '../src/ui/sprites/index.js';

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

function tmpCtx(): ToolContext {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-test-'));
  return { cwd, readFiles: new Map(), state: {} };
}

test('safe commands skip the permission prompt', () => {
  for (const c of ['ls -la', 'git status', 'git diff HEAD~1', 'cat a.txt | head -5', 'grep -rn foo src | wc -l', 'git branch -a', 'find . -name "*.ts"', 'sort file.txt']) {
    assert.equal(isSafeCommand(c), true, c);
  }
});

test('anything that writes, deletes or runs other programs needs permission', () => {
  for (const c of [
    'rm -rf x', 'ls & rm -rf x', 'ls; rm x', 'ls && rm x', 'ls || rm x', 'echo hi > f', 'cat $(which rm)', 'echo `rm x`',
    'env rm -rf x', 'find . -delete', 'find . -exec rm {} ;', 'find . -fprint out', 'sort -o out in', 'sort --output=out in',
    'rg --pre ./evil foo', 'git branch -D main', 'git branch new', 'git remote add x y', 'git push', 'git diff --output=x',
    'git -c core.pager=rm log', 'npm install', 'tree -o out', 'uniq a b', 'xargs rm', 'date -s 2020-01-01',
  ]) {
    assert.equal(isSafeCommand(c), false, c);
  }
});

test('Edit requires a prior Read and a unique match', async () => {
  const ctx = tmpCtx();
  const file = path.join(ctx.cwd, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\ntwo\n');
  let r = await EditTool.run({ file_path: 'a.txt', old_string: 'one', new_string: 'uno' }, ctx);
  assert.equal(r.isError, true, 'edit before read must fail');
  await ReadTool.run({ file_path: 'a.txt' }, ctx);
  r = await EditTool.run({ file_path: 'a.txt', old_string: 'two', new_string: 'dos' }, ctx);
  assert.equal(r.isError, true, 'ambiguous match must fail');
  r = await EditTool.run({ file_path: 'a.txt', old_string: 'two', new_string: 'dos', replace_all: true }, ctx);
  assert.equal(r.isError, undefined);
  r = await EditTool.run({ file_path: 'a.txt', old_string: 'one', new_string: '$& and $1' }, ctx);
  assert.equal(fs.readFileSync(file, 'utf8'), '$& and $1\ndos\ndos\n', 'replacement must be literal');
});

test('Write refuses to clobber an unread file but creates new ones', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'old.txt'), 'keep me');
  assert.equal((await WriteTool.run({ file_path: 'old.txt', content: 'x' }, ctx)).isError, true);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'old.txt'), 'utf8'), 'keep me');
  const r = await WriteTool.run({ file_path: 'new/dir/f.txt', content: 'hi\n' }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(fs.readFileSync(path.join(ctx.cwd, 'new/dir/f.txt'), 'utf8'), 'hi\n');
});

test('Read numbers lines and pages with offset/limit', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'n.txt'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  const r = await ReadTool.run({ file_path: 'n.txt', offset: 3, limit: 2 }, ctx);
  assert.match(r.output, /^ +3\tline 3\n +4\tline 4/);
  assert.match(r.output, /file has 10 lines/);
});

test('Grep finds content and skips binaries', async () => {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.cwd, 'a.ts'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(ctx.cwd, 'b.bin'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  const r = await GrepTool.run({ pattern: 'needle', output_mode: 'content' }, ctx);
  assert.match(r.output, /a\.ts:1:const needle/);
  assert.doesNotMatch(r.output, /b\.bin/);
});

test('htmlToText keeps titles, links and lists', () => {
  const t = htmlToText('<h1>Hi &amp; bye</h1><ul><li><a href=/x>X</a><li><a href="https://y.dev">Y</a></ul><script>evil()</script>');
  assert.match(t, /# Hi & bye/);
  assert.match(t, /- \[X\]\(\/x\)/);
  assert.match(t, /- \[Y\]\(https:\/\/y\.dev\)/);
  assert.doesNotMatch(t, /evil/);
});

test('every sprite sheet is valid', () => {
  for (const [name, errors] of Object.entries(validateAll())) assert.deepEqual(errors, [], name);
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
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
