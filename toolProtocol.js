import { randomUUID } from 'node:crypto';

export const toolId = () => `call_${randomUUID().replaceAll('-', '')}`;
export const textContent = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : p?.text || '').filter(Boolean).join('\n');
  return content == null ? '' : JSON.stringify(content);
};

// Keep calls and results intact while translating Anthropic blocks to a shared format.
export function normalizeMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textContent(body.system) });
  for (const msg of body.messages || []) {
    if (!msg) continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const calls = blocks.filter(p => p.type === 'tool_use').map(p => ({
      id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) }
    }));
    const results = blocks.filter(p => p.type === 'tool_result');
    const content = textContent(msg.content);
    if (content || calls.length || !results.length) {
      messages.push({ role: msg.role || 'user', content,
        ...(msg.tool_calls || calls.length ? { tool_calls: msg.tool_calls || calls } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}) });
    }
    for (const result of results) messages.push({ role: 'tool', tool_call_id: result.tool_use_id,
      content: (result.is_error ? 'Tool error: ' : '') + textContent(result.content) });
  }
  if (!messages.length) messages.push({ role: 'user', content: textContent(body.prompt) || 'Hello' });
  return messages;
}

export function normalizeTools(tools = []) {
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  return tools.map(tool => {
    const fn = tool.function || { name: tool.name, description: tool.description, parameters: tool.input_schema };
    if (!fn.name || (tool.type && tool.type !== 'function')) throw new Error('Only named function tools are supported');
    return { type: 'function', function: { ...fn, parameters: fn.parameters || { type: 'object', properties: {} } } };
  });
}

export function normalizeChoice(choice) {
  if (!choice || choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return choice;
}

export function promptMessages(messages, tools, choice) {
  const output = messages.map(msg => {
    if (msg.role === 'tool') return { role: 'user', content: `Tool result (${msg.tool_call_id}):\n${msg.content}` };
    if (msg.tool_calls?.length) return { role: 'assistant', content: JSON.stringify({ content: msg.content || '', tool_calls: msg.tool_calls.map(c => ({ id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })) }) };
    return { role: msg.role === 'developer' ? 'system' : msg.role, content: msg.content };
  });
  if (tools.length) output.unshift({ role: 'system', content: `You can call the following tools. To call tools, reply ONLY with a JSON object in this exact format, without markdown or surrounding prose:
{"tool_calls":[{"name":"tool_name","arguments":{"parameter":"value"}}]}
Use actual JSON objects for arguments. Only call listed tools and follow their JSON schemas. Tool results will be supplied in the next message. Never invent tool results or claim actions happened before receiving results. For a final answer, use ordinary text. Tool choice: ${JSON.stringify(choice)}. "none" forbids calls, "required" requires a call, a named function requires that function, "auto" lets you choose.
Tool definitions: ${JSON.stringify(tools.map(t => t.function))}` });
  return output;
}

export function parseToolReply(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  if (!/^\{\s*"tool_calls"\s*:/.test(trimmed) && !/^\{\s*"content"\s*:/.test(trimmed)) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error('Model returned malformed tool JSON; no tools were executed'); }
  if (!Array.isArray(parsed.tool_calls) || !parsed.tool_calls.length) return null;
  return { content: typeof parsed.content === 'string' ? parsed.content : '', tool_calls: parsed.tool_calls.map(call => ({
    id: call.id || toolId(), type: 'function', function: {
      name: call.function?.name || call.name,
      arguments: typeof (call.function?.arguments ?? call.arguments) === 'string'
        ? (call.function?.arguments ?? call.arguments) : JSON.stringify(call.function?.arguments ?? call.arguments ?? {})
    }
  })) };
}

export function validateCalls(calls, tools, choice) {
  if (calls.length > 16) throw new Error('Too many tool calls in one response');
  if (calls.length && choice === 'none') throw new Error('Model called tools when tool_choice is none');
  const forced = choice?.function?.name;
  if (!calls.length && (choice === 'required' || forced)) throw new Error('Model did not return the required tool call');
  const ids = new Set();
  for (const call of calls) {
    if (!tools.some(t => t.function.name === call.function.name)) throw new Error(`Unknown tool: ${call.function.name}`);
    if (forced && call.function.name !== forced) throw new Error(`Model must call ${forced}`);
    if (ids.has(call.id)) throw new Error('Duplicate tool call ID');
    ids.add(call.id);
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  }
}
