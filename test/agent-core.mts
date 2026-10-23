/**
 * Agent-loop tests: npx tsx test/agent-core.mts
 * Same style as test/run.mts. A scripted fake LLM drives the real Agent, so nothing goes to the network;
 * the LLM class itself is tested against a local SSE server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent, isSimpleCommand, type AgentEvent, type PermissionAnswer } from '../src/agent.js';
import { runHeadless, type OutputFormat } from '../src/headless.js';
import { LLM, type ChatMessage, type StreamEvent, type Usage } from '../src/llm.js';
import { findTool } from '../src/tools/index.js';

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

/** One scripted model reply (tool calls are [name, arguments]), or an error the request fails with. */
type Reply = { text?: string; calls?: [string, unknown][]; finish?: string; usage?: Usage } | Error;

/** A fake LLM that plays the replies in order (then "Done.") and records every request. */
function fakeLLM(replies: Reply[], contextWindow = 262_144) {
  const requests: ChatMessage[][] = [];
  const llm = {
    config: { apiKey: 'test', baseURL: 'http://127.0.0.1:9/v1', model: 'fake', contextWindow },
    async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(messages));
      const r = replies.shift() ?? { text: 'Done.' };
      if (r instanceof Error) throw r;
      if (r.text) yield { type: 'text', delta: r.text };
      const toolCalls = (r.calls ?? []).map(([name, args], i) => ({
        id: `call_${requests.length}_${i}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      }));
      const finishReason = r.finish ?? (toolCalls.length ? 'tool_calls' : 'stop');
      yield { type: 'done', text: r.text ?? '', reasoning: '', toolCalls, usage: r.usage, finishReason };
    },
  };
  return { llm: llm as unknown as LLM, requests };
}

const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zoicode-agent-')));

async function turn(agent: Agent, prompt: string, signal?: AbortSignal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(prompt, signal)) events.push(ev);
  return events;
}

const toolEnds = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end');

/** What the backend needs to accept a history: every call's arguments are a JSON object, and every call has a result. */
function assertSendable(messages: ChatMessage[]) {
  const answered = new Set(messages.flatMap(m => (m.role === 'tool' ? [m.tool_call_id] : [])));
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) {
      if (!('function' in c)) continue;
      const args = JSON.parse(c.function.arguments);
      assert.ok(args && typeof args === 'object' && !Array.isArray(args), `arguments must be an object: ${c.function.arguments}`);
      assert.ok(answered.has(c.id), `call ${c.id} has no result`);
    }
  }
}

// --- arguments ---------------------------------------------------------------------------------------------------

test('arguments that are not a JSON object are never stored, and the model is told why', async () => {
  const cwd = tmpDir();
  for (const args of ['{"file_path": "a', '"a.txt"', 'null', '5', '[]', 'true', '"{\\"file_path\\":\\"a\\"}"']) {
    const { llm, requests } = fakeLLM([{ calls: [['Read', args]] }]);
    const agent = new Agent({ llm, cwd });
    const [end] = toolEnds(await turn(agent, 'read it'));
    assert.equal(end.result.isError, true, args);
    assert.match(end.result.output, /^Invalid arguments for Read: the arguments (are not valid JSON|must be a JSON object, not)/, args);
    assert.equal(requests.length, 2, `${args}: the error must reach the model`);
    assertSendable(requests[1]);
  }
});

test('a tool call cut off mid-arguments is not run, and a cut-off answer is an error', async () => {
  const cwd = tmpDir();
  const { llm } = fakeLLM([
    { calls: [['Write', '{"file_path": "x.txt", "content": "par']], finish: 'length' },
    { text: 'Step 1: delete the', finish: '' },
  ]);
  const agent = new Agent({ llm, cwd, permissionMode: 'bypass' });
  const events = await turn(agent, 'write x');
  assert.match(toolEnds(events)[0].result.output, /^This tool call was cut off \(it reached the length limit\)/);
  assert.equal(fs.existsSync(path.join(cwd, 'x.txt')), false);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'The reply was cut off (the response ended early).' });
  assertSendable(agent.messages);
});

test('a saved session with broken arguments or an unanswered call is repaired before it is sent', async () => {
  const { llm, requests } = fakeLLM([{ text: 'Hi again.' }]);
  const agent = new Agent({ llm, cwd: tmpDir() });
  agent.messages = [
    { role: 'user', content: 'create hello.py' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'Write', arguments: '{"file_path": "hello.py", "content": "print(' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'Interrupted by user' },
    { role: 'user', content: 'list the files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] },
  ];
  await turn(agent, 'hello?');
  const sent = requests[0].slice(1);
  assertSendable(sent);
  assert.deepEqual(sent[5], { role: 'tool', tool_call_id: 'b', content: 'Not run: the session was interrupted.' });
  assert.deepEqual(sent.at(-1), { role: 'user', content: 'hello?' });
});

test('bad Bash arguments never escape run(), and nobody is asked to approve a call with no command', async () => {
  const cwd = tmpDir();
  let prompts = 0;
  const { llm, requests } = fakeLLM([
    { calls: [['Bash', { cmd: 'ls' }], ['Bash', {}], ['Bash', { command: ['ls'] }], ['Read', { file_path: 123 }], ['LS', {}]] },
  ]);
  const agent = new Agent({ llm, cwd, canUseTool: async () => (prompts++, 'allow') });
  const events = await turn(agent, 'go');
  const ends = toolEnds(events);
  assert.equal(ends.length, 5);
  assert.match(ends[0].result.output, /missing required parameter "command" \(string\); parameters given: "cmd"/);
  assert.match(ends[1].result.output, /missing required parameter "command"/);
  assert.match(ends[2].result.output, /parameter "command" must be a string, not an array/);
  assert.match(ends[3].result.output, /parameter "file_path" must be a string, not a number/);
  assert.equal(ends[4].result.isError, undefined);
  assert.equal(prompts, 0);
  assert.equal(requests.length, 2);
  for (const e of events) if (e.type === 'tool_start') assert.equal(typeof e.label, 'string', 'the UI calls string methods on labels');
  assertSendable(agent.messages);
});

test('a permission prompt that fails becomes an error result, and the other calls still get theirs', async () => {
  const { llm } = fakeLLM([{ calls: [['Bash', { command: 'raon-test-tool x' }], ['LS', {}]] }]);
  const agent = new Agent({ llm, cwd: tmpDir(), canUseTool: async () => { throw new Error('prompt closed'); } });
  const ends = toolEnds(await turn(agent, 'go'));
  assert.equal(ends[0].result.output, 'Error: prompt closed');
  assert.equal(ends[1].result.isError, undefined);
  assertSendable(agent.messages);
});

test('arguments are checked against the tool schema before anything runs', async () => {
  const cwd = tmpDir();
  const file = path.join(cwd, 'notes.txt');
  fs.writeFileSync(file, 'keep\nTODO: remove me\nx1 x2\n');
  const { llm } = fakeLLM([
    { calls: [['Read', { file_path: 'notes.txt' }]] },
    {
      calls: [
        ['Edit', { file_path: 'notes.txt', old_string: 'TODO: remove me\n' }],
        ['Edit', { file_path: 'notes.txt', old_string: 'x', new_string: null, replace_all: true }],
        ['Edit', { file_path: 'notes.txt', old_string: 'x', new_string: 'y', replace_all: 'false' }],
        ['Grep', { pattern: 'x', output_mode: 'lines' }],
        ['Read', { file_path: 'notes.txt', offset: null, limit: null }],
        ['TodoWrite', { todos: '[{"content": "x", "status": "pending"}]' }],
      ],
    },
  ]);
  const agent = new Agent({ llm, cwd, permissionMode: 'acceptEdits' });
  const ends = toolEnds(await turn(agent, 'delete the TODO line'));
  assert.match(ends[1].result.output, /^Invalid arguments for Edit: missing required parameter "new_string" \(string\)/);
  assert.match(ends[2].result.output, /missing required parameter "new_string"/);
  assert.match(ends[3].result.output, /parameter "replace_all" must be a boolean, not a string/);
  assert.match(ends[4].result.output, /parameter "output_mode" must be one of "files_with_matches", "content", "count"/);
  assert.equal(ends[5].result.isError, undefined, 'optional parameters sent as null are left out');
  assert.doesNotMatch(ends[6].result.output, /^Invalid arguments/, 'arrays and objects are left to the tool');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep\nTODO: remove me\nx1 x2\n');
});

// --- permissions ---------------------------------------------------------------------------------------------------

test('isSimpleCommand: chaining, pipes, substitution and redirection outside quotes are not simple', () => {
  for (const c of [
    'git status', 'git commit -m "feat(ui): a; b && c | d > e"', "git log --format='%h $(x) `y`'", 'npm test 2>&1',
    'npm test >/dev/null 2>&1', 'npm test &> /dev/null', 'git commit -m "it\'s \\"done\\""', 'echo \\; \\| \\&',
  ]) {
    assert.equal(isSimpleCommand(c), true, c);
  }
  for (const c of [
    'git status && rm x', 'git status; rm x', 'git status\nrm x', 'git status || rm x', 'git status | sh', 'git status & rm x',
    'git log $(rm x)', 'git log `rm x`', 'git log "$(rm x)"', 'git log "\\\\$(rm x)"', 'git status > x', 'git log < x',
    'git status 2>&1 > x', 'git diff >> x', '(rm x)', 'git log <(rm x)', 'git commit -m "unterminated', "echo $'a\\'b'",
  ]) {
    assert.equal(isSimpleCommand(c), false, c);
  }
});

test('a Bash rule approves simple commands of its program, never anything chained to them', async () => {
  const cwd = tmpDir();
  const agent = new Agent({ llm: fakeLLM([]).llm, cwd });
  const prompted: string[] = [];
  agent.canUseTool = async (_tool, input) => (prompted.push(input.command), 'deny');
  agent.allowRules.add('Bash(raon-test-tool)');
  const auto = ['raon-test-tool add -A', 'raon-test-tool commit -m "feat(ui): a; b && c"', 'raon-test-tool diff 2>&1'];
  const asked = [
    'raon-test-tool status && touch pwned', 'raon-test-tool status; touch pwned', 'raon-test-tool status\ntouch pwned',
    'raon-test-tool $(touch pwned)', 'raon-test-tool `touch pwned`', 'raon-test-tool "$(touch pwned)"', 'raon-test-tool status > pwned',
    'raon-test-tool status | sh', 'FOO=1 raon-test-tool status', 'cd . && raon-test-tool status',
  ];
  for (const command of [...auto, ...asked]) {
    agent.llm = fakeLLM([{ calls: [['Bash', { command }]] }]).llm;
    await turn(agent, 'run it');
  }
  assert.deepEqual(prompted, asked);
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
});

test('"always" stores the rule the prompt was given, and never one for a wrapper like env or xargs', async () => {
  const agent = new Agent({ llm: fakeLLM([]).llm, cwd: tmpDir() });
  const bash = findTool('Bash')!;
  const rules = (command: string) => agent.alwaysRules(bash, { command });
  assert.deepEqual(rules('npm test'), ['Bash(npm)']);
  assert.deepEqual(rules('  cd sub && npm test'), ['Bash(cd)']);
  for (const c of ['env rm -rf x', 'sudo rm x', 'timeout 5 rm x', 'xargs rm', 'bash -c "rm x"', '/usr/bin/env rm x', 'nohup rm x', 'time rm x', 'FOO=1 npm test', '"npm" test', '$CMD x', '']) {
    assert.deepEqual(rules(c), [], c);
  }
  const given: string[][] = [];
  const answers: PermissionAnswer[] = ['always', 'always'];
  agent.canUseTool = async (_tool, _input, r) => (given.push(r), answers.shift() ?? 'deny');
  agent.llm = fakeLLM([{ calls: [['Bash', { command: 'raon-test-tool status && true' }]] }]).llm;
  await turn(agent, 'go');
  agent.llm = fakeLLM([{ calls: [['Bash', { command: 'env FOO=1 raon-test-tool' }]] }]).llm;
  await turn(agent, 'go');
  assert.deepEqual(given, [['Bash(raon-test-tool)'], []]);
  assert.deepEqual([...agent.allowRules], ['Bash(raon-test-tool)']);
});

test('acceptEdits auto-approves Write/Edit inside the project only, following symlinks', async () => {
  const root = tmpDir();
  const cwd = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  const home = path.join(root, 'home');
  for (const d of [cwd, outside, home]) fs.mkdirSync(d);
  fs.symlinkSync(outside, path.join(cwd, 'linkdir'));
  fs.symlinkSync(path.join(outside, 'planted.sh'), path.join(cwd, 'build.sh')); // dangling: a write creates the target
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const inside = ['notes.md', 'src/new.ts', path.join(cwd, 'abs.txt'), '~/../project/tilde.txt'];
    const asked = [path.join(outside, 'a.txt'), '../outside/b.txt', '~/.bashrc', 'linkdir/c.txt', 'build.sh', path.join(root, 'project-evil', 'd.txt')];
    const prompted: string[] = [];
    for (const file_path of [...inside, ...asked]) {
      const { llm } = fakeLLM([{ calls: [['Write', { file_path, content: 'x\n' }]] }]);
      const agent = new Agent({ llm, cwd, permissionMode: 'acceptEdits', canUseTool: async (_t, input) => (prompted.push(input.file_path), 'deny') });
      await turn(agent, 'write it');
    }
    assert.deepEqual(prompted, asked);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.ok(fs.existsSync(path.join(cwd, 'src/new.ts')) && fs.existsSync(path.join(cwd, 'tilde.txt')));
  } finally {
    process.env.HOME = savedHome;
  }
});

test('an "always" Write rule only covers files inside the project', async () => {
  const root = tmpDir();
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const prompted: string[] = [];
  const agent = new Agent({ llm: fakeLLM([]).llm, cwd, canUseTool: async (_t, input) => (prompted.push(input.file_path), 'deny') });
  agent.allowRules.add('Write');
  for (const file_path of ['inside.txt', '../outside.txt']) {
    agent.llm = fakeLLM([{ calls: [['Write', { file_path, content: 'x\n' }]] }]).llm;
    await turn(agent, 'write it');
  }
  assert.deepEqual(prompted, ['../outside.txt']);
  assert.equal(fs.existsSync(path.join(cwd, 'inside.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
});

test('rejecting a tool call stops the turn: the rest of the batch does not run and the model is not called again', async () => {
  const cwd = tmpDir();
  const { llm, requests } = fakeLLM([
    { calls: [['Bash', { command: 'raon-test-tool stash' }], ['Write', { file_path: 'deploy.txt', content: 'x' }]] },
    { text: 'Doing something else instead…' },
  ]);
  const agent = new Agent({ llm, cwd, permissionMode: 'acceptEdits', canUseTool: async () => 'deny' });
  const events = await turn(agent, 'stash, then write deploy.txt');
  const ends = toolEnds(events);
  assert.equal(ends[0].denied, true);
  assert.match(ends[0].result.output, /rejected this tool call and stopped the turn/);
  assert.match(ends[1].result.output, /^Not run: the user rejected an earlier tool call/);
  assert.equal(events.at(-1)?.type, 'interrupted');
  assert.equal(fs.existsSync(path.join(cwd, 'deploy.txt')), false);
  assert.equal(requests.length, 1);
  assertSendable(agent.messages);
});

test('with nobody to ask (headless), a denied call goes back to the model and the turn goes on', async () => {
  const { llm, requests } = fakeLLM([{ calls: [['Bash', { command: 'raon-test-tool x' }]] }, { text: 'I could not run it.' }]);
  const agent = new Agent({ llm, cwd: tmpDir() });
  const events = await turn(agent, 'go');
  assert.equal(toolEnds(events)[0].denied, true);
  assert.equal(requests.length, 2);
  assert.equal(events.at(-1)?.type, 'assistant');
});

test('rejecting a call inside a subagent stops the main agent too', async () => {
  const cwd = tmpDir();
  const { llm, requests } = fakeLLM([
    { calls: [['Task', { description: 'clean up', prompt: 'clean up the build' }], ['Write', { file_path: 'after.txt', content: 'x' }]] },
    { calls: [['Bash', { command: 'raon-test-tool clean' }], ['Write', { file_path: 'sub.txt', content: 'x' }]] }, // the subagent
  ]);
  const agent = new Agent({ llm, cwd, permissionMode: 'acceptEdits', canUseTool: async () => 'deny' });
  const events = await turn(agent, 'go');
  assert.match(toolEnds(events)[0].result.output, /Subagent stopped: the user rejected/);
  assert.equal(events.at(-1)?.type, 'interrupted');
  assert.equal(requests.length, 2);
  assert.equal(fs.existsSync(path.join(cwd, 'sub.txt')), false);
  assert.equal(fs.existsSync(path.join(cwd, 'after.txt')), false);
});

// --- streaming, context, compaction ----------------------------------------------------------------------------

/** A local OpenAI-style SSE server; each request plays the next script of [delay ms, chunk] steps (null = [DONE]). */
async function sseServer(scripts: [number, object | null][][]) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* read the request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delay, chunk] of scripts.shift() ?? []) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (res.destroyed) return;
      res.write(chunk ? `data: ${JSON.stringify(chunk)}\n\n` : 'data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  const llm = new LLM({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1`, model: 'm', contextWindow: 262_144 });
  return { llm, close: () => (server.closeAllConnections(), server.close()) };
}
const chunk = (delta: object, finish: string | null = null) => ({
  id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }],
});

test('Esc while a reply streams interrupts the turn: the text shown is kept, the half-sent tool call is dropped', async () => {
  const server = await sseServer([[
    [0, chunk({ role: 'assistant', content: 'Step 1: delete the build dir.' })],
    [0, chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Write', arguments: '{"file_path": "x.txt", "content": "par' } }] })],
    [3000, chunk({}, 'tool_calls')],
    [0, null],
  ]]);
  try {
    const cwd = tmpDir();
    const agent = new Agent({ llm: server.llm, cwd, permissionMode: 'bypass' });
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    for await (const ev of agent.run('clean up', ac.signal)) {
      events.push(ev);
      if (ev.type === 'text') setTimeout(() => ac.abort(), 100);
    }
    assert.deepEqual(events.slice(-2).map(e => e.type), ['assistant', 'interrupted']);
    assert.deepEqual(agent.messages.slice(1), [{ role: 'assistant', content: 'Step 1: delete the build dir.' }]);
    assert.equal(fs.existsSync(path.join(cwd, 'x.txt')), false);
  } finally {
    server.close();
  }
});

test('a stream that ends without a finish reason has finishReason ""', async () => {
  const server = await sseServer([[[0, chunk({ role: 'assistant', content: 'Half an ans' })]], [[0, chunk({ content: 'Hi' }, 'stop')], [0, null]]]);
  try {
    const reasons: string[] = [];
    for (let i = 0; i < 2; i++) {
      for await (const ev of server.llm.stream([{ role: 'user', content: 'hi' }], [])) if (ev.type === 'done') reasons.push(ev.finishReason);
    }
    assert.deepEqual(reasons, ['', 'stop']);
  } finally {
    server.close();
  }
});

test('one tool result or user message can only add so much to the history', async () => {
  const { llm } = fakeLLM([
    { calls: [['Task', { description: 'dig', prompt: 'report everything' }]] },
    { text: 'r'.repeat(300_000) }, // the subagent's report
  ]);
  const agent = new Agent({ llm, cwd: tmpDir() });
  await turn(agent, 'look ' + 'y'.repeat(500_000));
  const [user, , result] = agent.messages;
  assert.ok(String(user.content).startsWith('look y') && String(user.content).length < 200_100);
  assert.equal(result.role, 'tool');
  assert.ok(String(result.content).length < 100_100);
  assert.match(String(result.content), /characters truncated/);
});

test('a prompt that no longer fits is reported clearly and marks the context as full', async () => {
  const tooLong = Object.assign(new Error("400 The prompt and requested output tokens exceed the model's context length."), { status: 400 });
  const agent = new Agent({ llm: fakeLLM([tooLong]).llm, cwd: tmpDir() });
  const last = (await turn(agent, 'hello?')).at(-1) as Extract<AgentEvent, { type: 'error' }>;
  assert.match(last.message, /^400 The prompt .* no longer fits in the context window: compact it \(\/compact\) or start over \(\/clear\)\.$/);
  assert.ok(agent.contextTokens >= 262_144, 'a check of contextTokens must see a full context');

  // A masked 400 counts too when the history is about as big as the window, but not when it is small.
  const masked = () => Object.assign(new Error('400 The request was rejected.'), { status: 400 });
  const big = new Agent({ llm: fakeLLM([masked()]).llm, cwd: tmpDir() });
  big.messages = [{ role: 'user', content: 'x'.repeat(800_000) }, { role: 'assistant', content: 'ok' }];
  const bigLast = (await turn(big, 'hi')).at(-1) as Extract<AgentEvent, { type: 'error' }>;
  assert.match(bigLast.message, /^400 The request was rejected\. The conversation no longer fits/);
  assert.ok(big.contextTokens >= 262_144);
  const small = new Agent({ llm: fakeLLM([masked()]).llm, cwd: tmpDir() });
  assert.deepEqual((await turn(small, 'hi')).at(-1), { type: 'error', message: '400 The request was rejected.' });
  assert.equal(small.contextTokens, 0);
});

test('estimateContextTokens adds what was appended since the last measured usage', async () => {
  const agent = new Agent({ llm: fakeLLM([{ text: 'hi', usage: { promptTokens: 5000, completionTokens: 100 } }]).llm, cwd: tmpDir() });
  await turn(agent, 'hello');
  const before = agent.estimateContextTokens();
  assert.ok(before >= 5100 && before <= 5102, String(before));
  agent.messages.push({ role: 'tool', tool_call_id: 'x', content: 'z'.repeat(3000) });
  assert.ok(Math.abs(agent.estimateContextTokens() - before - 1000) <= 1);
});

test('compact keeps the conversation when the summary is empty, cut off, interrupted or not a summary', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'Migrate auth to OAuth; keep /login working.' },
    { role: 'assistant', content: 'Done: edited src/auth.ts. Next: tests.' },
  ];
  const cases: [Reply, RegExp][] = [
    [{ text: '' }, /the summary came back empty/],
    [{ text: '## Goals\n- migrate the auth', finish: 'length' }, /the summary was cut off \(it reached the length limit\)/],
    [{ text: 'Goals: migrate', finish: '' }, /the summary was cut off \(the response ended early\)/],
    [{ text: '[tool call] Read {"file_path":"src/auth.ts"}\n[tool result]\nexport const x = 1;' }, /continued the conversation/],
    [{ text: 'Let me look first.\n<tool_call>\n<function=Read>' }, /continued the conversation/],
    [Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), /aborted/],
  ];
  for (const [reply, error] of cases) {
    const agent = new Agent({ llm: fakeLLM([reply]).llm, cwd: tmpDir() });
    agent.messages = structuredClone(history);
    agent.ctx.readFiles.set('/tmp/auth.ts', 1);
    await assert.rejects(agent.compact(), error);
    assert.deepEqual(agent.messages, history);
    assert.equal(agent.ctx.readFiles.size, 1);
  }
});

test('a successful compact replaces the history, fences the transcript and forgets which files were read', async () => {
  const { llm, requests } = fakeLLM([{ text: '\n\nGoals: OAuth. Changed src/auth.ts. Next: tests.' }]);
  const agent = new Agent({ llm, cwd: tmpDir() });
  agent.messages = [{ role: 'user', content: 'x'.repeat(50_000) }, { role: 'assistant', content: 'ok' }];
  agent.ctx.readFiles.set('/tmp/auth.ts', 1);
  assert.equal(await agent.compact(), 'Goals: OAuth. Changed src/auth.ts. Next: tests.');
  assert.equal(agent.messages.length, 2);
  assert.match(String(agent.messages[0].content), /Summary:\n\nGoals: OAuth/);
  assert.equal(agent.ctx.readFiles.size, 0);
  const prompt = String(requests[0][1].content);
  assert.match(prompt, /^<transcript>\n\[user\]\n/);
  assert.match(prompt, /<\/transcript>\n\nThe transcript above is complete/);
  assert.ok(prompt.length < 15_000, 'long messages are shortened in the transcript');
});

// --- headless ------------------------------------------------------------------------------------------------------

async function capture<T>(fn: () => Promise<T>) {
  let stdout = '';
  let stderr = '';
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
}

const fakeAgent = (run: () => AsyncGenerator<AgentEvent>) =>
  ({ run, totalUsage: { promptTokens: 0, completionTokens: 0 }, messages: [] }) as unknown as Agent;

test('headless: an unknown --output-format fails before anything runs', async () => {
  let ran = false;
  const agent = fakeAgent(async function* () { ran = true; });
  const { value, stdout, stderr } = await capture(() => runHeadless(agent, 'make a file', 'stream_json' as OutputFormat, false));
  assert.equal(value, 1);
  assert.equal(ran, false);
  assert.equal(stdout, '');
  assert.match(stderr, /unknown output format "stream_json" \(use text, json, stream-json\)/);
});

test('headless: json output still prints its result line when the run throws', async () => {
  const agent = fakeAgent(async function* () {
    yield { type: 'text', delta: 'hi' };
    throw new Error('boom');
  });
  const { value, stdout, stderr } = await capture(() => runHeadless(agent, 'go', 'json', false));
  assert.equal(value, 1);
  assert.deepEqual(JSON.parse(stdout), { result: '', is_error: true, usage: { promptTokens: 0, completionTokens: 0 }, num_messages: 0 });
  assert.match(stderr, /Error: boom/);
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
