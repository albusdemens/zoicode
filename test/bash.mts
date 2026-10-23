/**
 * Bash tool tests: npx tsx test/bash.mts
 * Same shape as test/run.mts: each test is a named function that throws on failure.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BashTool, isSafeCommand, splitCommand } from '../src/tools/bash.js';
import { type ToolContext, truncate } from '../src/tools/types.js';

// The tool makes its private temp dir under os.tmpdir() on first use; give it one this test can inspect.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-bash-test-'));
process.env.TMPDIR = tmpRoot;

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

function tmpCtx(): ToolContext {
  return { cwd: fs.mkdtempSync(path.join(tmpRoot, 'proj-')), readFiles: new Map(), state: {} };
}
const run = (command: string, extra: Record<string, unknown> = {}, ctx = tmpCtx()) => BashTool.run({ command, ...extra }, ctx);

/** False once the process is gone or is a zombie waiting to be reaped (Linux). */
function alive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] !== 'Z';
  } catch {
    return false;
  }
}
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => setTimeout(r, 50));
  return !alive(pid);
}

test('splitCommand removes quotes and marks wildcards', () => {
  assert.deepEqual(splitCommand(`ls -la 'a b' "c" d''e && cat x | wc -l; ls *.ts`), [
    { words: ['ls', '-la', 'a b', 'c', 'de'], globbed: false },
    { words: ['cat', 'x'], globbed: false },
    { words: ['wc', '-l'], globbed: false },
    { words: ['ls', '*.ts'], globbed: true },
  ]);
  for (const c of ['echo $HOME', 'echo `id`', 'echo \\x', 'cat <f', 'ls &', "echo 'open"]) assert.equal(splitCommand(c), null, c);
});

test('quoted, escaped, abbreviated and bundled flags still need permission', () => {
  for (const c of [
    "find ./src '-delete'", 'find ./src "-delete"', "find . -de''lete", 'find . -del""ete', "find . -'delete'",
    'find . \\-delete', "find . $'-delete'", 'find .${IFS}-delete', 'find ./brace {-delete,}',
    "find . -maxdepth 0 '-exec' bash payload.sh '{}' '+'", "find . '-exec' touch PWNED '{}' +",
    "sort '-o' out in", 'sort --o=out in.txt', 'sort --outp=out in', 'sort -uo ~/.bashrc evil', 'sort -oevil.sh in',
    'sort -rno out in', "sort -o'out' in", "rg '--pre=./evil' foo", "rg '--pre' prog pat .", 'rg --pr=./evil foo',
    "git diff '--output=src/a.ts'", "git log '--output=/path' HEAD", 'git log -p --outpu=x', "git diff '--ext-diff'",
    'git diff --ext', "file '-C' -m m", 'date --se 2020-01-01',
  ]) {
    assert.equal(isSafeCommand(c), false, c);
  }
});

test('flags that run programs or set the clock need permission', () => {
  for (const c of [
    'sort -S1k --compress-program=./evil.sh big', 'sort --compress-program ./evil.sh -S1k big', 'sort --compress-prog=./evil big',
    'rg --hostname-bin=./evil --hyperlink-format=default foo', 'file --compile -m magic',
    'date 010100002030', 'date -u 0101000030', 'date -us 2020-01-01',
  ]) {
    assert.equal(isSafeCommand(c), false, c);
  }
});

test('shell syntax the check cannot see through needs permission', () => {
  for (const c of [
    'ls "$HOME"', 'echo "`rm x`"', 'grep "a\\|b" f', 'cat <in.txt', 'ls 2>&1', 'ls >/dev/null', '(rm x)', 'ls # x',
    "ls #'\nrm x\n'", '! ls', 'FOO=1 ls', 'ls "unclosed', "ls 'unclosed", 'ls ; rm x',
    // Background jobs outlive the call.
    'ls &', 'cat a & cat b', 'ls |& wc',
    // A wildcard can expand to a file named like a flag, so flag-sensitive programs need plain words.
    'sort *', 'find * -name x', 'git diff *', 'file *', 'date *',
    '__proto__ x', 'constructor x', 'toString', '', '   ', ';',
  ]) {
    assert.equal(isSafeCommand(c), false, JSON.stringify(c));
  }
});

test('ordinary read-only commands still skip the prompt', () => {
  for (const c of [
    'ls -la ~/projects', 'ls *.ts', 'cat src/*.ts | wc -l', 'grep -rn "TODO" src', "grep -n 'a\\|b' f", 'grep -rn "foo$" src',
    "echo 'a > b; rm -rf /'", 'find . -name "*.ts" -type f', "find src -newer package.json -printf '%p\\n'", "find . '(' -name a ')'",
    'sort -n -k2 file.txt', 'sort -t, -k2 f', 'sort -S1k --batch-size=2 big', 'sort -u f;', 'rg -n "foo|bar" src',
    "rg -g '*.ts' --pre-glob '*.gz' foo", 'git log --oneline -5', 'git diff --stat --no-ext-diff',
    "git log -p --output-indicator-new=+ -- 'src/*.ts'", 'git status && git diff', 'git branch --show-current',
    'date', 'date +%Y-%m-%d', "date -u '+%F %T'", 'date -d yesterday +%F', "date --date '2 days ago'", 'date -Iseconds',
    'file -b --mime-type package.json', 'stat -c %s package.json', 'head -n 5 a | tail -n 2',
  ]) {
    assert.equal(isSafeCommand(c), true, c);
  }
});

test('a missing or non-string command is an error result, never a throw', async () => {
  for (const bad of [undefined, null, 123, ['ls'], { cmd: 'ls' }]) {
    assert.equal(isSafeCommand(bad as any), false);
    assert.equal(BashTool.isSafe?.({ command: bad } as any), false);
    assert.equal(BashTool.label({ command: bad } as any), '');
  }
  assert.equal(BashTool.isSafe?.(null as any), false);
  assert.equal(BashTool.label(null as any), '');
  const ctx = tmpCtx();
  for (const input of [{}, { cmd: 'ls' }, { command: 42 }, { command: '  ' }, null]) {
    const r = await BashTool.run(input as any, ctx);
    assert.equal(r.isError, true, JSON.stringify(input));
    assert.match(r.output, /"command"/);
  }
  const nul = await run('echo a\0b');
  assert.equal(nul.isError, true);
  assert.match(nul.output, /^Error: /);
});

test('a non-numeric timeout falls back to the default', async () => {
  const r = await run('sleep 0.2; echo ok', { timeout: 'soon' });
  assert.equal(r.output, 'ok\n\nExit code 0');
  assert.equal(r.isError, false);
});

test('runaway output is stopped instead of crashing the process', async () => {
  const t0 = Date.now();
  const r = await run('cat /dev/zero');
  assert.equal(r.isError, true);
  assert.match(r.output, /\n\nCommand stopped after printing more than \d+M characters$/);
  assert.ok(r.output.length < 30_200, `output length ${r.output.length}`);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
});

test('large output is truncated like truncate() and its lines are counted while streaming', async () => {
  for (const c of [
    'seq 1 300000',
    "seq 1 5000; printf '\\n%.0s' $(seq 1 20000)", // a trailing blank run longer than the kept tail
    "seq 1 3000; printf '\\n%.0s' $(seq 1 40000); seq 1 3000",
    "printf '   \\n\\n  '",
    'exec 2>&1; echo out; echo err >&2; exit 3',
  ]) {
    const full = spawnSync('bash', ['-c', c], { encoding: 'utf8', maxBuffer: 1e9 });
    const all = (full.stdout + full.stderr).trimEnd();
    const lines = all ? all.split('\n').length : 0;
    const r = await run(c);
    assert.equal(r.output, `${truncate(all) || '(no output)'}\n\nExit code ${full.status}`, c);
    assert.equal(r.summary, `${lines} line${lines === 1 ? '' : 's'} of output${full.status ? ` · exit ${full.status}` : ''}`, c);
  }
});

test('multi-byte characters split across reads stay intact', async () => {
  let r = await run("printf '\\xea'; sleep 0.2; printf '\\xb0\\x80\\xeb\\x82\\x98\\n'");
  assert.equal(r.output, '가나\n\nExit code 0');
  r = await run("printf '\\xea'; sleep 0.2; printf 'ERR\\n' >&2; sleep 0.2; printf '\\xb0\\x80\\n'");
  assert.equal(r.output, 'ERR\n가\n\nExit code 0');
});

test('a background job does not hold the call open', async () => {
  const t0 = Date.now();
  const r = await run('sleep 30 & echo $!', { timeout: 10_000 });
  const pid = Number(r.output.split('\n')[0]);
  try {
    assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0}ms`);
    assert.equal(r.isError, false);
    assert.match(r.output, /Background processes are still running/);
    assert.match(r.output, /\n\nExit code 0$/);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('timeouts and interrupts also kill processes that left the process group', async () => {
  if (process.platform === 'linux') {
    // coreutils timeout moves to a group of its own; setsid starts a new session but keeps the output pipe.
    for (const c of ['timeout 30 sleep 30 & echo $!; wait', 'setsid sleep 30 & echo $!; wait']) {
      const t0 = Date.now();
      const r = await run(c, { timeout: 1000 });
      const pid = Number(r.output.split('\n')[0]);
      assert.match(r.output, /\n\nCommand timed out after 1000ms$/, c);
      assert.ok(Date.now() - t0 < 5_000, `${c} took ${Date.now() - t0}ms`);
      assert.ok(await gone(pid), `${c}: pid ${pid} survived`);
    }
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const r = await BashTool.run({ command: 'sleep 30' }, { ...tmpCtx(), signal: ac.signal });
  assert.equal(r.output, '(no output)\n\nCommand interrupted by user');
  assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0}ms`);
});

test('the working directory carries over through a private temp file only', async () => {
  const ctx = tmpCtx();
  fs.mkdirSync(path.join(ctx.cwd, 'sub'));
  const sub = fs.realpathSync(path.join(ctx.cwd, 'sub'));
  await BashTool.run({ command: 'cd sub' }, ctx);
  assert.equal(ctx.state.bashCwd, sub);
  // A file at the old predictable path is never read, even when a command ends before reporting its directory.
  const planted = path.join(os.tmpdir(), `zoicode-cwd-${process.pid}`);
  fs.writeFileSync(planted, `${os.homedir()}\n`);
  try {
    await BashTool.run({ command: 'exit 3' }, ctx);
    await BashTool.run({ command: 'sleep 5', timeout: 200 }, ctx);
    assert.equal(ctx.state.bashCwd, sub);
  } finally {
    fs.rmSync(planted, { force: true });
  }
  assert.equal((await BashTool.run({ command: 'pwd' }, ctx)).output, `${sub}\n\nExit code 0`);
  // Between calls the private 0700 dir is empty.
  const dirs = fs.readdirSync(tmpRoot).filter(d => d.startsWith('zoicode-bash-'));
  assert.equal(dirs.length, 1);
  assert.equal(fs.statSync(path.join(tmpRoot, dirs[0])).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(tmpRoot, dirs[0])), []);
});

test('a saved directory that is not a directory falls back to the project; a missing project is an error', async () => {
  const ctx = tmpCtx();
  ctx.state.bashCwd = path.join(ctx.cwd, 'file.txt');
  fs.writeFileSync(ctx.state.bashCwd as string, '');
  assert.equal((await BashTool.run({ command: 'pwd' }, ctx)).output, `${fs.realpathSync(ctx.cwd)}\n\nExit code 0`);
  const r = await BashTool.run({ command: 'pwd' }, { ...tmpCtx(), cwd: path.join(tmpRoot, 'missing') });
  assert.equal(r.isError, true);
  assert.match(r.output, /^Error: .*ENOENT/);
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
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
