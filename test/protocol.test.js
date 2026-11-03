import test from 'node:test';
import assert from 'node:assert/strict';
import { request as inject } from './httpHarness.js';
import { normalizeMessages, normalizeTools, normalizeChoice, parseToolReply } from '../toolProtocol.js';
import { complete, readSSE } from '../upstream.js';
import { handleOpenAIChatCompletion, handleAnthropicMessages, handleDirectPayload } from '../proxyHandler.js';

const tools = normalizeTools([{ name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
const options = { modelId: 'test', thinking: false, deepSearch: false };
const args = { messages: [{ role: 'user', content: 'Read README.md' }], tools, options };
function response(events, json = false) {
  return new Response(json ? JSON.stringify(events) : events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
    { headers: { 'Content-Type': json ? 'application/json' : 'text/event-stream' } });
}

test('Anthropic and OpenAI history preserve call IDs and tool results', () => {
  const messages = normalizeMessages({ system: 'Instructions', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'data' }] }] }
  ] });
  assert.equal(messages[1].tool_calls[0].id, 'call_1');
  assert.equal(messages[2].tool_call_id, 'call_1'); assert.equal(messages[2].content, 'data');
  assert.deepEqual(normalizeMessages({ messages }), messages);
  assert.equal(normalizeChoice({ type: 'any' }), 'required');
});

test('SSE parser handles UTF-8 byte splits, CRLF and missing final newline', async () => {
  const bytes = new TextEncoder().encode('data: {"content":"हैलो"}\r\n\r\ndata: {"content":"last"}');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = []; for await (const event of readSSE(body)) events.push(event);
  assert.deepEqual(events.map(e => e.content), ['हैलो', 'last']);
});

test('text-only worker receives tool schemas and results in a supported message payload', async () => {
  const previous = process.env.TOOL_CALL_MODE; process.env.TOOL_CALL_MODE = 'prompt';
  try {
    const reply = await complete({ ...args, fetchImpl: async (url, init) => {
      const payload = JSON.parse(init.body);
      assert.match(payload.messages[0].content, /read_file/); assert.equal(payload.tools, undefined);
      return response([{ content: '{"tool_calls":[{"name":"read_file","arguments":{"path":"README.md"}}]}' }]);
    } });
    assert.equal(reply.finishReason, 'tool_calls'); assert.equal(reply.tool_calls[0].function.name, 'read_file');
    assert.ok(reply.tool_calls[0].id);
  } finally { if (previous === undefined) delete process.env.TOOL_CALL_MODE; else process.env.TOOL_CALL_MODE = previous; }
});

test('native calls accumulate fragmented arguments and preserve metadata', async () => {
  const previous = process.env.TOOL_CALL_MODE; process.env.TOOL_CALL_MODE = 'native';
  try {
    const reply = await complete({ ...args, fetchImpl: async (url, init) => {
      assert.equal(JSON.parse(init.body).tools[0].function.name, 'read_file');
      return response([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }
      ]);
    } });
    assert.equal(reply.tool_calls[0].id, 'call_1');
    assert.deepEqual(JSON.parse(reply.tool_calls[0].function.arguments), { path: 'README.md' });
  } finally { if (previous === undefined) delete process.env.TOOL_CALL_MODE; else process.env.TOOL_CALL_MODE = previous; }
});

test('unknown, malformed, truncated and forced-tool violations fail before execution', async () => {
  for (const output of [
    '{"tool_calls":[{"name":"unknown","arguments":{}}]}',
    '{"tool_calls":[{"name":"read_file","arguments":"broken"}]}',
    '{"tool_calls":[',
  ]) await assert.rejects(complete({ ...args, fetchImpl: async () => response([{ content: output }]) }));
  await assert.rejects(complete({ ...args, toolChoice: 'required', fetchImpl: async () => response([{ content: 'no tool' }]) }), /required/);
  await assert.rejects(complete({ ...args, fetchImpl: async () => response([{ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'length' }] }]) }), /Incomplete/);
  assert.equal(parseToolReply('Here is JSON: {"tool_calls":[]}'), null);
});

test('plain text JSON responses and upstream errors are handled', async () => {
  const reply = await complete({ ...args, tools: [], fetchImpl: async () => response({ choices: [{ message: { content: 'hello' } }] }, true) });
  assert.equal(reply.content, 'hello');
  await assert.rejects(complete({ ...args, fetchImpl: async () => new Response('bad', { status: 503 }) }), /503/);
  await assert.rejects(complete({ ...args, fetchImpl: async () => response([{ error: { message: 'provider error' } }]) }), /provider error/);
});

test('HTTP compatibility: OpenAI and Anthropic tool calls, batch and stream, tool-result roundtrip', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const last = JSON.parse(init.body).messages.at(-1);
    const content = last.content.startsWith('Tool result') ? 'File received.' : '{"tool_calls":[{"name":"read_file","arguments":{"path":"README.md"}}]}';
    return response([{ content }]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const handlers = { '/v1/chat/completions': handleOpenAIChatCompletion, '/v1/messages': handleAnthropicMessages, '/api/chat': handleDirectPayload };
  const post = (endpoint, body) => inject(handlers[endpoint], 'http://localhost' + endpoint, { method: 'POST', body });
  const request = { messages: args.messages, tools, stream: false };
  const data = await (await post('/v1/chat/completions', request)).json();
  assert.equal(data.choices[0].finish_reason, 'tool_calls');
  const assistant = data.choices[0].message;
  const followup = await (await post('/v1/chat/completions', { ...request, messages: [...args.messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: '# README contents' }] })).json();
  assert.equal(followup.choices[0].message.content, 'File received.');
  const nativeStream = await (await post('/v1/chat/completions', { ...request, stream: true })).text();
  assert.match(nativeStream, /"tool_calls":\[\{"index":0/); assert.match(nativeStream, /"finish_reason":"tool_calls"/);
  const anthropicTools = [{ name: 'read_file', input_schema: tools[0].function.parameters }];
  const anthropic = await (await post('/v1/messages', { ...request, tools: anthropicTools })).json();
  assert.equal(anthropic.stop_reason, 'tool_use'); assert.equal(anthropic.content[0].name, 'read_file');
  const stream = await (await post('/v1/messages', { ...request, tools: anthropicTools, stream: true })).text();
  assert.match(stream, /event: content_block_start/); assert.match(stream, /input_json_delta/); assert.match(stream, /"stop_reason":"tool_use"/);
  const direct = await (await post('/api/chat', { ...request, modelId: 'test' })).json();
  assert.equal(direct.choices[0].finish_reason, 'tool_calls');
});
