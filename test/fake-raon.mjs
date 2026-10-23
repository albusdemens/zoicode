// A stand-in for the Raon API, for driving the UI without a key: `node test/fake-raon.mjs [port]`
// prints the port it listens on. A message containing "make a file" gets a Bash tool call back
// (touch made-N.txt), so the permission prompt shows up; anything else gets a short streamed reply.
import http from 'node:http';

const port = Number(process.argv[2] || 0);
let files = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'raon-test', object: 'model' }] }));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const last = body.messages?.at(-1) ?? {};
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'raon-test', choices, ...extra })}\n\n`);
  if (last.role === 'user' && String(last.content).includes('make a file')) {
    const args = JSON.stringify({ command: `touch made-${++files}.txt`, description: 'Create a file' });
    send([{ index: 0, delta: { role: 'assistant', content: 'Sure, creating it.' }, finish_reason: null }]);
    send([{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${files}`, type: 'function', function: { name: 'Bash', arguments: args } }] }, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
  } else {
    const text = last.role === 'tool' ? 'Done: the file is there.' : `Hello from the fake server. You said: ${String(last.content).slice(0, 40)}`;
    send([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  }
  send([], { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  res.end('data: [DONE]\n\n');
});

server.listen(port, '127.0.0.1', () => console.log(server.address().port));
