import { promptMessages, parseToolReply, validateCalls, textContent, toolId } from './toolProtocol.js';

// Handles split UTF-8, CRLF, multi-line SSE frames and an unterminated last frame.
export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (done && buffer) { lines.push(buffer); buffer = ''; }
      if (done) lines.push('');
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (!line) {
          if (data.length) {
            const event = data.join('\n'); data = [];
            if (event === '[DONE]') return;
            yield JSON.parse(event);
          }
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function complete({ messages, tools = [], toolChoice = 'auto', options, signal, onText, onUsage, fetchImpl = fetch }) {
  const native = process.env.TOOL_CALL_MODE === 'native';
  const payload = { messages: native ? messages : promptMessages(messages, tools, toolChoice),
    modelId: options.modelId, thinking: options.thinking, deepSearch: options.deepSearch, stream: true };
  if (native && tools.length) Object.assign(payload, { tools, tool_choice: toolChoice });
  let content = '', finishReason = 'stop', reportedUsage;
  const calls = new Map();
  const estimatedInput = Math.ceil(JSON.stringify(payload).length / 4);
  try {
  const timeout = AbortSignal.timeout(Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000);
  const response = await fetchImpl(process.env.UPSTREAM_URL || 'https://freemodels-chat.freemodels.workers.dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://freemodels.pro', Referer: 'https://freemodels.pro/' },
    body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  let responseBytes = 0;
  const consume = event => {
    if (event.usage && Number.isFinite(event.usage.prompt_tokens) && Number.isFinite(event.usage.completion_tokens)
      && event.usage.prompt_tokens >= 0 && event.usage.completion_tokens >= 0) reportedUsage = event.usage;
    responseBytes += Buffer.byteLength(JSON.stringify(event));
    if (responseBytes > 4 * 1024 * 1024) throw new Error('Upstream response exceeded 4 MiB');
    if (event.error) throw new Error(event.error.message || JSON.stringify(event.error));
    const choice = event.choices?.[0];
    const delta = choice?.delta || choice?.message;
    const text = textContent(delta?.content ?? event.content ?? event.delta?.text ?? '');
    if (text) { content += text; if (!tools.length) onText?.(text); }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    for (const [position, part] of (delta?.tool_calls || event.tool_calls || []).entries()) {
      const index = part.index ?? position;
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(index, call);
    }
  };
  if (response.headers.get('content-type')?.includes('application/json')) consume(await response.json());
  else for await (const event of readSSE(response.body)) consume(event);
  let toolCalls = [...calls.values()].map(c => ({ ...c, id: c.id || toolId() }));
  if (!toolCalls.length && tools.length && toolChoice !== 'none') {
    const parsed = parseToolReply(content, tools);
    if (parsed) { content = parsed.content; toolCalls = parsed.tool_calls; }
  }
  if (toolCalls.length && ['length', 'content_filter'].includes(finishReason)) throw new Error('Incomplete tool response; no tools were executed');
  validateCalls(toolCalls, tools, toolChoice);
  if (!content && !toolCalls.length) throw new Error('Upstream returned an empty response');
  return { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : finishReason };
  } finally {
    onUsage?.({ inputTokens: reportedUsage?.prompt_tokens ?? estimatedInput,
      outputTokens: reportedUsage?.completion_tokens ?? Math.ceil((content.length + [...calls.values()].reduce((n, c) => n + c.function.arguments.length + c.function.name.length, 0)) / 4),
      estimated: !reportedUsage });
  }
}
