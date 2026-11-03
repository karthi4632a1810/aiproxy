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
    // Results must immediately follow the assistant's calls in native mode.
    for (const result of results) messages.push({ role: 'tool', tool_call_id: result.tool_use_id,
      content: (result.is_error ? 'Tool error: ' : '') + textContent(result.content) });
    if (content || calls.length || !results.length) {
      messages.push({ role: msg.role || 'user', content,
        ...(msg.tool_calls || calls.length ? { tool_calls: msg.tool_calls || calls } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}) });
    }
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
  const toolDefs = tools.length ? JSON.stringify(tools.map(t => t.function)) : '';
  const toolInstruction = tools.length ? `You can call the following tools. Whenever you need to perform an action (e.g. create, edit, read files or run commands), you MUST reply with a JSON object in this format:
{"tool_calls":[{"name":"tool_name","arguments":{"parameter":"value"}}]}
Use actual JSON objects for arguments. Only call listed tools and follow their JSON schemas. Tool results will be supplied in the next message. Never invent tool results or claim actions happened before receiving results. For a final answer, use ordinary text. Tool choice: ${JSON.stringify(choice)}. "none" forbids calls, "required" requires a call, a named function requires that function, "auto" lets you choose.
Tool definitions: ${toolDefs}` : '';

  const systemTexts = [];
  if (toolInstruction) systemTexts.push(toolInstruction);

  const nonSystem = [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      if (msg.content) systemTexts.push(msg.content);
    } else if (msg.role === 'tool') {
      nonSystem.push({ role: 'user', content: `Tool result (${msg.tool_call_id}):\n${msg.content}` });
    } else if (msg.tool_calls?.length) {
      nonSystem.push({
        role: 'assistant',
        content: JSON.stringify({
          content: msg.content || '',
          tool_calls: msg.tool_calls.map(c => ({
            id: c.id,
            name: c.function.name,
            arguments: typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : c.function.arguments
          }))
        })
      });
    } else {
      nonSystem.push({ role: msg.role || 'user', content: msg.content });
    }
  }

  const combinedSystem = systemTexts.join('\n\n');

  if (!nonSystem.length) {
    return combinedSystem ? [{ role: 'user', content: combinedSystem }] : [{ role: 'user', content: 'Hello' }];
  }

  if (combinedSystem) {
    const first = nonSystem[0];
    nonSystem[0] = {
      role: first.role === 'assistant' ? 'user' : first.role,
      content: `${combinedSystem}\n\n${first.content}`
    };
  }

  return nonSystem;
}

export function parseToolReply(content, tools = []) {
  if (!content || typeof content !== 'string') return null;
  const toolNames = new Set(tools.map(t => t.function?.name || t.name).filter(Boolean));

  const normalizeCall = call => {
    if (!call) return null;
    const name = call.function?.name || call.name || call.tool;
    if (!name) return null;
    let args = call.function?.arguments ?? call.arguments ?? call.parameters ?? call.input ?? {};
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args); } catch { args = '{}'; }
    }
    return {
      id: call.id || toolId(),
      type: 'function',
      function: { name, arguments: args }
    };
  };

  // 1. Try finding JSON inside markdown code blocks: ```json ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
        const textBefore = content.slice(0, match.index).trim();
        const textAfter = content.slice(match.index + match[0].length).trim();
        return {
          content: [textBefore, textAfter].filter(Boolean).join('\n\n'),
          tool_calls: parsed.tool_calls.map(normalizeCall).filter(Boolean)
        };
      }
      if (Array.isArray(parsed) && parsed.length && (parsed[0].name || parsed[0].function)) {
        return {
          content: content.slice(0, match.index).trim(),
          tool_calls: parsed.map(normalizeCall).filter(Boolean)
        };
      }
      if (parsed && typeof parsed === 'object' && (parsed.name || parsed.function)) {
        return {
          content: content.slice(0, match.index).trim(),
          tool_calls: [normalizeCall(parsed)].filter(Boolean)
        };
      }
    } catch {}
  }

  // 2. Try parsing embedded {"tool_calls": [...]}
  const toolCallsRegex = /\{\s*"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/;
  const toolMatch = content.match(toolCallsRegex);
  if (toolMatch) {
    let parsed;
    try {
      parsed = JSON.parse(toolMatch[0]);
    } catch {
      throw new Error('Model returned malformed tool JSON; no tools were executed');
    }
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
      const textBefore = content.slice(0, toolMatch.index).trim();
      const textAfter = content.slice(toolMatch.index + toolMatch[0].length).trim();
      return {
        content: [textBefore, textAfter].filter(Boolean).join('\n\n'),
        tool_calls: parsed.tool_calls.map(normalizeCall).filter(Boolean)
      };
    }
  }

  // 3. Try parsing directly if string starts with { or [
  const trimmed = content.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '').trim();
  if (/^\{\s*"tool_calls"\s*:/.test(trimmed) || /^\{\s*"content"\s*:/.test(trimmed) || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (/^\{\s*"tool_calls"\s*:/.test(trimmed) || trimmed.includes('"tool_calls"')) {
        throw new Error('Model returned malformed tool JSON; no tools were executed');
      }
    }
    if (parsed) {
      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
        return {
          content: typeof parsed.content === 'string' ? parsed.content : '',
          tool_calls: parsed.tool_calls.map(normalizeCall).filter(Boolean)
        };
      }
      if (Array.isArray(parsed) && parsed.length && (parsed[0].name || parsed[0].function)) {
        return { content: '', tool_calls: parsed.map(normalizeCall).filter(Boolean) };
      }
      if (typeof parsed === 'object' && (parsed.name || parsed.function)) {
        return { content: '', tool_calls: [normalizeCall(parsed)].filter(Boolean) };
      }
    }
  }

  // 4. Match XML style tool calls if present (e.g. <tool_name>...</tool_name>)
  for (const name of toolNames) {
    const xmlRegex = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g');
    let xmlMatch;
    const calls = [];
    while ((xmlMatch = xmlRegex.exec(content)) !== null) {
      const inner = xmlMatch[1].trim();
      let args = {};
      if (inner.startsWith('{') && inner.endsWith('}')) {
        try { args = JSON.parse(inner); } catch {}
      } else {
        const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
        let tagMatch;
        let foundTags = false;
        while ((tagMatch = tagRegex.exec(inner)) !== null) {
          foundTags = true;
          args[tagMatch[1]] = tagMatch[2].trim();
        }
        if (!foundTags && inner) {
          args = { input: inner };
        }
      }
      calls.push({
        id: toolId(),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) }
      });
    }
    if (calls.length) {
      const prose = content.replace(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`, 'g'), '').trim();
      return { content: prose, tool_calls: calls };
    }
  }

  return null;
}

export function validateCalls(calls, tools, choice) {
  if (calls.length > 16) throw new Error('Too many tool calls in one response');
  if (calls.length && choice === 'none') throw new Error('Model called tools when tool_choice is none');
  const forced = choice?.function?.name;
  if (!calls.length && (choice === 'required' || forced)) throw new Error('Model did not return the required tool call');
  const ids = new Set();
  const aliasMap = {
    'write_file': 'write_to_file',
    'write_to_file': 'write_file',
    'read_file': 'read_from_file',
    'read_from_file': 'read_file',
    'list_files': 'list_dir',
    'list_directory': 'list_files',
    'execute_command': 'run_command',
    'run_command': 'execute_command'
  };
  for (const call of calls) {
    if (!tools.some(t => t.function.name === call.function.name)) {
      const alt = aliasMap[call.function.name];
      if (alt && tools.some(t => t.function.name === alt)) {
        call.function.name = alt;
      }
    }
    if (!tools.some(t => t.function.name === call.function.name)) throw new Error(`Unknown tool: ${call.function.name}`);
    if (forced && call.function.name !== forced) throw new Error(`Model must call ${forced}`);
    if (ids.has(call.id)) throw new Error('Duplicate tool call ID');
    ids.add(call.id);
    const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
  }
}
