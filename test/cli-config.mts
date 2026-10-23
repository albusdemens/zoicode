/**
 * CLI and config tests: npx tsx test/cli-config.mts
 * The CLI runs from source against a local fake Raon server, with scratch HOME and project dirs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-cli-')));
const freshDir = () => fs.mkdtempSync(path.join(tmp, 'd'));
// config.ts reads the home directory once, when it is imported: point it at a scratch one first.
process.env.HOME = freshDir();
const { CONFIG_DIR, DEFAULT_CONTEXT_WINDOW, loadConfig, parseContextWindow, parseDotEnvLine } = await import('../src/config.js');
const { listSessions, newSession, resolveSession, saveSession } = await import('../src/sessions.js');
const { saveCredentials } = await import('../src/setup.js');

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** Runs fn with some environment variables set (undefined deletes them), then puts them back. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

// Fake Raon: /models only accepts known keys; chat answers "big" with BIG and anything else with "ok".
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} `.padEnd(99, '.')).join('\n'); // ~300 KB
const requests: { auth?: string; messages: { role: string; content: string }[] }[] = [];
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url?.endsWith('/models')) {
    const ok = ['Bearer good-key', 'Bearer test-key'].includes(req.headers.authorization ?? '');
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { object: 'list', data: [{ id: 'raon-test', object: 'model' }] } : { error: { message: 'Invalid API key' } }));
    return;
  }
  const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ auth: req.headers.authorization, messages });
  const text = messages.at(-1)?.content === 'big' ? BIG : `ok (saw ${messages.length} messages)`;
  const send = (choices: object[], extra = {}) =>
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'raon-test', choices, ...extra })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (let i = 0; i < text.length; i += 4096) send([{ index: 0, delta: { content: text.slice(i, i + 4096) }, finish_reason: null }]);
  send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  send([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const lastUserText = () => requests.at(-1)!.messages.filter(m => m.role === 'user').at(-1)!.content;

const cliEnv: Record<string, string | undefined> = {
  ...process.env,
  NODE: process.execPath,
  TSX: import.meta.resolve('tsx'),
  CLI: path.join(root, 'src', 'cli.tsx'),
  TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'),
  FORCE_COLOR: '0',
  // Real variables win over the checkout's .env, so the CLI only ever talks to the fake server.
  RAON_API_KEY: 'test-key',
  RAON_BASE_URL: baseURL,
  RAON_MODEL: 'raon-test',
  RAON_CONTEXT_WINDOW: undefined,
};

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a sh script in which `raon` is the CLI. Each run gets a fresh HOME and project dir unless
 * given. stdin is /dev/null, or a socket (as from any Node.js parent) fed with `input` or left open.
 */
function run(script: string, opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string; openStdin?: boolean } = {}): Promise<Run> {
  const child = spawn('sh', ['-c', `raon() { "$NODE" --import "$TSX" "$CLI" "$@"; }\n${script}`], {
    cwd: opts.cwd ?? freshDir(),
    env: { ...cliEnv, HOME: freshDir(), ...opts.env },
    stdio: [opts.input !== undefined || opts.openStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true, // its own process group, so a hung run can be killed whole
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', d => (stdout += d));
  child.stderr!.setEncoding('utf8').on('data', d => (stderr += d));
  if (opts.input !== undefined) child.stdin!.end(opts.input);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.kill(-child.pid!, 'SIGKILL');
      reject(new Error(`timed out: ${script}\n${stderr}`));
    }, 30_000);
    child.on('close', code => {
      clearTimeout(timer);
      child.stdin?.destroy();
      resolve({ code, stdout, stderr });
    });
  });
}

test('.env lines: values are trimmed and unquoted, comments and `export` are dropped', () => {
  const cases: [string, [string, string] | undefined][] = [
    ['RAON_BASE_URL=https://h/v1   ', ['RAON_BASE_URL', 'https://h/v1']],
    ['RAON_API_KEY="sk-1" ', ['RAON_API_KEY', 'sk-1']],
    ["RAON_API_KEY='sk-1'\r", ['RAON_API_KEY', 'sk-1']],
    ['RAON_MODEL = raon-x   # the small one', ['RAON_MODEL', 'raon-x']],
    ['RAON_MODEL="raon # x" # comment', ['RAON_MODEL', 'raon # x']],
    ['export RAON_API_KEY=sk-2', ['RAON_API_KEY', 'sk-2']],
    ['RAON_BASE_URL=https://h/v1#frag', ['RAON_BASE_URL', 'https://h/v1#frag']],
    ['RAON_BASE_URL=', ['RAON_BASE_URL', '']],
    ['# a comment', undefined],
    ['', undefined],
  ];
  for (const [line, want] of cases) assert.deepEqual(parseDotEnvLine(line), want, JSON.stringify(line));
});

test('an empty RAON_BASE_URL or RAON_MODEL means the default, never the SDK fallback (api.openai.com)', () => {
  for (const blank of ['', '   ']) {
    const c = withEnv({ RAON_API_KEY: 'k', RAON_BASE_URL: blank, RAON_MODEL: blank, RAON_CONTEXT_WINDOW: undefined }, () => loadConfig());
    assert.equal(c.baseURL, 'https://raon-api.krafton.ai/v1');
    assert.equal(c.model, 'raon-1-mini-preview');
  }
  const own = withEnv({ RAON_API_KEY: ' k ', RAON_BASE_URL: ' http://localhost:8000/v1 ', RAON_MODEL: undefined, RAON_CONTEXT_WINDOW: undefined }, () =>
    loadConfig({ model: '' }),
  );
  assert.deepEqual([own.apiKey, own.baseURL, own.model], ['k', 'http://localhost:8000/v1', 'raon-1-mini-preview']);
  for (const bad of ['raon-api.krafton.ai/v1', 'ftp://h/v1']) {
    assert.throws(() => withEnv({ RAON_API_KEY: 'k', RAON_BASE_URL: bad }, () => loadConfig()), /RAON_BASE_URL must be an http\(s\) URL/, bad);
  }
  assert.throws(() => withEnv({ RAON_API_KEY: '  ' }, () => loadConfig()), /RAON_API_KEY is not set/);
});

test('RAON_CONTEXT_WINDOW: blank means the default, anything but a token count is an error', () => {
  for (const raw of [undefined, '', '  ']) assert.equal(parseContextWindow(raw), DEFAULT_CONTEXT_WINDOW);
  assert.equal(parseContextWindow('131072'), 131072);
  assert.equal(parseContextWindow(' 128k '), 131072);
  assert.equal(parseContextWindow('32K'), 32768);
  for (const raw of ['0', '-1', '128', 'abc', '262,144', '1e5', '0x20000', '131072 # note', '128kb']) {
    assert.throws(() => parseContextWindow(raw), /RAON_CONTEXT_WINDOW must be a token count/, raw);
  }
  assert.equal(withEnv({ RAON_API_KEY: 'k', RAON_CONTEXT_WINDOW: '' }, () => loadConfig()).contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test('blank .env lines and empty exports hide nothing, and envSource says where a value came from', async () => {
  // An install layout of its own: <install>/src/config.ts reads <install>/.env, then ~/.zoicode/.env.
  const install = freshDir();
  const home = freshDir();
  fs.mkdirSync(path.join(install, 'src'));
  fs.copyFileSync(path.join(root, 'src', 'config.ts'), path.join(install, 'src', 'config.ts'));
  fs.writeFileSync(path.join(install, '.env'), 'RAON_BASE_URL=\nRAON_API_KEY=install-key\nRAON_MODEL = "m-install"  # pinned\n');
  fs.mkdirSync(path.join(home, '.zoicode'));
  fs.writeFileSync(path.join(home, '.zoicode', '.env'), 'RAON_BASE_URL=http://home.example/v1   \nRAON_API_KEY=home-key\nRAON_CONTEXT_WINDOW=128k\n');
  fs.writeFileSync(
    path.join(install, 'probe.mts'),
    "import { envSource, loadConfig } from './src/config.ts';\n" +
      "console.log(JSON.stringify({ ...loadConfig(), keyFrom: envSource('RAON_API_KEY'), urlFrom: envSource('RAON_BASE_URL') }));\n",
  );
  const probe = async (env: Record<string, string>) => {
    const r = await run('"$NODE" --import "$TSX" probe.mts', {
      cwd: install,
      env: { HOME: home, RAON_API_KEY: undefined, RAON_BASE_URL: undefined, RAON_MODEL: undefined, RAON_CONTEXT_WINDOW: '', ...env },
    });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(await probe({}), {
    apiKey: 'install-key', // the install's .env is read first
    baseURL: 'http://home.example/v1', // its blank line doesn't block the home value
    model: 'm-install',
    contextWindow: 131072, // the exported empty RAON_CONTEXT_WINDOW doesn't block it either
    keyFrom: path.join(install, '.env'),
    urlFrom: path.join(home, '.zoicode', '.env'),
  });
  const shell = await probe({ RAON_API_KEY: 'shell-key' });
  assert.deepEqual([shell.apiKey, shell.keyFrom], ['shell-key', 'environment']);
  assert.equal((await probe({ RAON_API_KEY: '' })).apiKey, 'install-key');
});

test('saveCredentials replaces the old line for a key, however it was written', () => {
  const file = path.join(CONFIG_DIR, '.env');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, 'export RAON_API_KEY=old\nRAON_MODEL=raon-x\nRAON_API_KEY = older\n');
  assert.equal(saveCredentials({ RAON_API_KEY: 'new' }), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RAON_MODEL=raon-x\nRAON_API_KEY=new\n');
});

test('resolveSession: -c is the latest, -r <id> finds one, an unknown id is undefined', async () => {
  const cwd = freshDir();
  assert.equal(resolveSession(cwd, true)?.messages.length, 0, 'nothing saved yet: a new session');
  assert.equal(resolveSession(cwd, false, 'abc'), undefined);
  const older = newSession(cwd);
  older.messages = [{ role: 'user', content: 'older' }];
  saveSession(older);
  await new Promise(r => setTimeout(r, 10));
  const newer = newSession(cwd);
  newer.messages = [{ role: 'user', content: 'newer' }];
  saveSession(newer);
  assert.equal(resolveSession(cwd, true)?.id, newer.id);
  assert.equal(resolveSession(cwd, false, older.id)?.id, older.id);
  assert.equal(resolveSession(cwd, true, older.id)?.id, newer.id, '-c wins over -r');
  for (const resume of [undefined, true]) {
    const s = resolveSession(cwd, false, resume);
    assert.ok(s && !s.messages.length && s.id !== older.id && s.id !== newer.id, String(resume));
  }
});

test('an unknown --permission-mode or --output-format stops the CLI before anything runs', async () => {
  for (const [args, allowed] of [
    ['-p hi --permission-mode bypassPermissions', 'default, acceptEdits, plan, bypass'],
    ['--permission-mode acceptedits', 'default, acceptEdits, plan, bypass'],
    ['-p hi --output-format jsonl', 'text, json, stream-json'],
  ]) {
    const before = requests.length;
    const r = await run(`raon ${args}`);
    assert.equal(r.code, 1, args);
    assert.ok(r.stderr.includes(`Allowed choices are ${allowed}.`), r.stderr);
    assert.equal(requests.length, before, `${args}: nothing may reach the server`);
  }
  const ok = await run('raon -p hi --permission-mode plan --output-format json');
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(JSON.parse(ok.stdout).result, /^ok/);
});

test('-p output reaches a slow pipe reader in full (no cut at 64 KiB)', async () => {
  const cwd = freshDir();
  let r = await run('raon -p big --output-format json | (sleep 1; cat) > out.json', { cwd });
  assert.equal(r.code, 0, r.stderr);
  const json = fs.readFileSync(path.join(cwd, 'out.json'), 'utf8');
  assert.ok(JSON.parse(json).result === BIG, `json: got ${json.length} bytes`);
  r = await run('raon -p big | (sleep 1; cat) > out.txt', { cwd });
  assert.equal(r.code, 0, r.stderr);
  const text = fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8');
  assert.ok(text === BIG + '\n', `text: got ${text.length} of ${BIG.length + 1} bytes`);
});

test('a reader that quits early (| head) ends the run quietly with status 0', async () => {
  for (const format of ['json', 'text']) {
    const cwd = freshDir();
    const r = await run(`{ raon -p big --output-format ${format} 2>err.txt; echo $? > status.txt; } | head -c 10 > /dev/null`, { cwd });
    assert.equal(r.code, 0);
    const err = fs.readFileSync(path.join(cwd, 'err.txt'), 'utf8');
    assert.equal(fs.readFileSync(path.join(cwd, 'status.txt'), 'utf8').trim(), '0', `${format}: ${err}`);
    assert.doesNotMatch(err, /EPIPE|Error/, format);
  }
});

test('piped and redirected stdin keep multi-byte characters that straddle a chunk boundary', async () => {
  const cwd = freshDir();
  const korean = '햯햰햱햲햳'.repeat(16_800); // 252,000 bytes: byte 65,536 falls inside a character
  fs.writeFileSync(path.join(cwd, 'ko.txt'), korean);
  for (const script of ['cat ko.txt | raon -p 요약해줘', 'raon -p 요약해줘 < ko.txt']) {
    const r = await run(script, { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(lastUserText() === `요약해줘\n\n${korean}`, `${script}: the prompt arrived altered`);
  }
});

test('stdin from a Node.js parent (a socket) is read; one left open is dropped after a warning', async () => {
  const diff = 'diff --git a/x b/x\n+hello\n';
  let r = await run('raon -p "write a commit message for this diff"', { input: diff });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastUserText(), `write a commit message for this diff\n\n${diff}`);
  r = await run('raon -p hi', { openStdin: true });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no stdin data received in 3s/);
  assert.equal(lastUserText(), 'hi');
});

test('-p runs are saved, and -c / -r <id> continue them', async () => {
  const cwd = freshDir();
  const env = { HOME: process.env.HOME }; // the same HOME as this process, so listSessions sees them
  assert.equal((await run('raon -p "add the /health endpoint"', { cwd, env })).code, 0);
  const [saved] = listSessions(cwd);
  assert.equal(saved?.messages.length, 2);
  let r = await run('raon -p -c "now write tests for it"', { cwd, env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(requests.at(-1)!.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  r = await run(`raon -p -r ${saved.id} "and docs"`, { cwd, env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(requests.at(-1)!.messages.length, 6);
  assert.equal(listSessions(cwd).length, 1, 'continuing must not fork the session');

  const before = requests.length;
  r = await run('raon -p -r "what should we do next"', { cwd, env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No session matching "what should we do next"/);
  r = await run('raon -p hi -r', { cwd, env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--resume needs a session id with --print/);
  assert.equal(requests.length, before, 'failed lookups must not run anything');
});

test('--setup without a terminal reads the key from stdin, checks it and saves it', async () => {
  const home = freshDir();
  let r = await run('echo good-key | raon --setup', { env: { HOME: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(home, '.zoicode', '.env'), 'utf8'), /^RAON_API_KEY=good-key$/m);
  // The test exports RAON_API_KEY, which would win over the saved key next time: setup must say so.
  assert.match(r.stdout, /Your environment also sets RAON_API_KEY/);

  r = await run('echo bad-key | raon --setup');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ .*Invalid API key/);
  r = await run('raon --setup < /dev/null');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No API key given/);
  r = await run('echo good-key | raon --setup -p hi');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok \(saw 2 messages\)/);
  assert.equal(requests.at(-1)!.auth, 'Bearer good-key');
});

test('a key that works but cannot be saved is used for the run, not rejected', async () => {
  const home = freshDir();
  fs.writeFileSync(path.join(home, '.zoicode'), 'a file, so the config dir cannot be created (even as root)');
  const r = await run('echo good-key | raon --setup -p hi', { env: { HOME: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /The key works but could not be saved/);
  assert.equal(requests.at(-1)!.auth, 'Bearer good-key');
});

test('a bad RAON_CONTEXT_WINDOW or RAON_BASE_URL stops the CLI with a clear message', async () => {
  const before = requests.length;
  let r = await run('raon -p hi', { env: { RAON_CONTEXT_WINDOW: '128' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RAON_CONTEXT_WINDOW must be a token count such as 131072 or 128k, got "128"/);
  r = await run('raon -p hi', { env: { RAON_BASE_URL: 'raon-api.krafton.ai/v1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /RAON_BASE_URL must be an http\(s\) URL/);
  assert.equal(requests.length, before);
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
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
