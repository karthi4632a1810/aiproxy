import { randomUUID } from 'node:crypto';
import { addLogEntry } from './logger.js';
import { extractOptions } from './proxyOptions.js';
import { normalizeMessages, normalizeTools, normalizeChoice, textContent } from './toolProtocol.js';
import { complete } from './upstream.js';
export { extractOptions, normalizeMessages };
export const normalizeContent = textContent;

export function startSSE(res) {
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
}
export function event(res, type, data) {
  if (!res.destroyed && !res.writableEnded) res.write(`${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

async function handle(req, res, anthropic = false) {
  req.deferUsage = true;
  const start = Date.now();
  const options = extractOptions(req);
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  let heartbeat;
  let messages = [], result, status = 200, failure;
  const id = `${anthropic ? 'msg' : 'chatcmpl'}_${randomUUID()}`;
  const created = Math.floor(start / 1000);
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: options.modelId,
    choices: [{ index: 0, delta, finish_reason }] });
  let textStarted = false;
  const sendText = text => {
    if (!anthropic) return event(res, null, chunk({ content: text }));
    if (!textStarted) {
      event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      textStarted = true;
    }
    event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  };
  try {
    if (req.body?.agent) throw Object.assign(new Error('Use /api/agent/run for server-side workspace execution'), { status: 400 });
    if (req.body?.messages !== undefined && !Array.isArray(req.body.messages)) throw Object.assign(new Error('messages must be an array'), { status: 400 });
    messages = normalizeMessages(req.body || {});
    let tools, toolChoice;
    try { tools = normalizeTools(req.body?.tools); toolChoice = normalizeChoice(req.body?.tool_choice); }
    catch (error) { error.status = 400; throw error; }
    const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
    if (options.stream) {
      startSSE(res);
      heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
      if (anthropic) event(res, 'message_start', { type: 'message_start', message: {
        id, type: 'message', role: 'assistant', content: [], model: options.modelId, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 } } });
      else event(res, null, chunk({ role: 'assistant', content: '' }));
    }
    result = await complete({ messages, tools, toolChoice, options, signal: controller.signal,
      onUsage: req.trackTokens,
      onText: options.stream ? sendText : undefined });
    const { finishReason, ...message } = result;
    const calls = result.tool_calls || [];
    const outputTokens = Math.ceil(JSON.stringify(message).length / 4);
    const stop = calls.length ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn';
    const content = [...(result.content ? [{ type: 'text', text: result.content }] : []), ...calls.map(c => ({
      type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments)
    }))];
    if (options.stream) {
      if (tools.length && result.content) sendText(result.content);
      if (anthropic) {
        if (textStarted) event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        calls.forEach((call, i) => {
          const index = i + (textStarted ? 1 : 0);
          event(res, 'content_block_start', { type: 'content_block_start', index,
            content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} } });
          event(res, 'content_block_delta', { type: 'content_block_delta', index,
            delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
          event(res, 'content_block_stop', { type: 'content_block_stop', index });
        });
        event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        event(res, 'message_stop', { type: 'message_stop' });
      } else {
        if (calls.length) event(res, null, chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) }));
        event(res, null, chunk({}, finishReason));
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } else if (anthropic) res.json({ id, type: 'message', role: 'assistant', model: options.modelId, content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
    else res.json({ id, object: 'chat.completion', created, model: options.modelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
  } catch (error) {
    status = error.status || 502; failure = error.message;
    if (req.usage) Object.assign(req.usage, { status, outcome: 'error' });
    if (!res.destroyed) {
      const payload = { type: 'error', error: { type: 'proxy_error', message: error.message } };
      if (res.headersSent) { event(res, 'error', payload); res.end(); }
      else res.status(status).json(payload);
    }
  } finally {
    req.finishUsage?.();
    clearInterval(heartbeat);
    res.off('close', abort);
    addLogEntry({ endpoint: req.path, model: options.modelId, ...options, messagesCount: messages.length,
      status, durationMs: Date.now() - start, firstSnippet: result?.content?.slice(0, 100), error: failure,
      tokensGenerated: Math.ceil((result?.content?.length || 0) / 4) });
  }
}

export const handleOpenAIChatCompletion = (req, res) => handle(req, res);
export const handleAnthropicMessages = (req, res) => handle(req, res, true);
export const handleDirectPayload = (req, res) => handle(req, res);
