// Tokens and conversation history stay in memory and are cleared on reload.
function initPlayground() {
  const form = document.getElementById('chatForm');
  const input = document.getElementById('promptInput');
  const display = document.getElementById('chatDisplay');
  const send = document.getElementById('sendBtn');
  const stop = document.getElementById('stopBtn');
  const clear = document.getElementById('clearChatBtn');
  const agentToggle = document.getElementById('toggleAgent');
  const keyInput = document.getElementById('agentKey');
  const workspaceLabel = document.getElementById('agentWorkspace');
  const histories = { agent: [], chat: [] };
  let token = '', controller;

  async function connectAgent() {
    token = keyInput.value.trim();
    if (!token) {
      const response = await fetch('/api/agent/session', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Agent connection failed');
      token = data.token;
    }
    const response = await fetch('/api/agent/tools', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Agent connection failed');
    workspaceLabel.textContent = `Workspace: ${data.workspace}`;
  }
  connectAgent().catch(error => { workspaceLabel.textContent = error.message; });
  keyInput.addEventListener('change', () => connectAgent().catch(error => { token = ''; workspaceLabel.textContent = error.message; }));
  stop.addEventListener('click', () => controller?.abort());
  clear.addEventListener('click', () => {
    histories.agent = []; histories.chat = [];
    display.replaceChildren();
  });
  document.querySelectorAll('.prompt-chip').forEach(chip => chip.addEventListener('click', () => {
    input.value = chip.dataset.prompt; input.focus();
  }));
  function bubble(text, className) {
    const element = document.createElement('div');
    element.className = `chat-bubble ${className}`; element.textContent = text;
    display.appendChild(element); return element;
  }
  function toolActivity(name, result) {
    const details = document.createElement('details'); details.className = 'tool-activity';
    const title = document.createElement('summary');
    title.textContent = `${result?.ok === false ? 'Failed' : 'Result'}: ${name}`;
    const output = document.createElement('pre'); output.textContent = JSON.stringify(result, null, 2);
    details.append(title, output); display.appendChild(details);
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = input.value.trim(); if (!prompt || controller) return;
    const isAgent = agentToggle.checked;
    const mode = isAgent ? 'agent' : 'chat';
    const stream = document.getElementById('toggleStream').checked;
    display.querySelector('.chat-placeholder')?.remove();
    bubble(prompt, 'chat-user');
    const assistant = bubble('Working…', 'chat-assistant');
    histories[mode].push({ role: 'user', content: prompt });
    input.value = ''; input.disabled = true; send.disabled = true; clear.disabled = true;
    agentToggle.disabled = true; keyInput.disabled = true; stop.disabled = false;
    controller = new AbortController();
    let accumulated = '', completed = false;
    const progress = (type, data) => {
      if (data.error || type === 'error') throw new Error(data.error?.message || 'Request failed');
      if (type === 'step') assistant.textContent = `Working — step ${data.step}…`;
      if (type === 'tool_start') assistant.textContent = `Running ${data.name}…`;
      if (type === 'tool_result') toolActivity(data.name, data.result);
      if (type === 'assistant') { accumulated = data.content; renderFormattedText(assistant, accumulated); }
      if (type === 'done') {
        completed = true;
        histories.agent.push(...data.messages);
        accumulated = data.message.content || '';
        renderFormattedText(assistant, accumulated);
      }
      if (!isAgent && data.choices) {
        const choice = data.choices[0];
        accumulated += choice.delta?.content || '';
        if (choice.finish_reason) completed = true;
        renderFormattedText(assistant, accumulated, !completed);
      }
      display.scrollTop = display.scrollHeight;
    };
    try {
      if (isAgent && !token) await connectAgent();
      const response = await fetch(isAgent ? '/api/agent/run' : '/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(isAgent ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ messages: histories[mode], model: document.getElementById('modelSelect').value,
          thinking: document.getElementById('toggleThinking').checked,
          deepSearch: document.getElementById('toggleDeepSearch').checked, stream })
      });
      if (!response.ok) {
        const data = await response.json(); throw new Error(data.error?.message || `HTTP ${response.status}`);
      }
      if (!stream) {
        const data = await response.json();
        if (isAgent) {
          for (const msg of data.messages || []) if (msg.role === 'tool') toolActivity(msg.tool_call_id, JSON.parse(msg.content));
          progress('done', data);
        } else { accumulated = data.choices[0].message.content || ''; completed = true; }
      } else {
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        let buffer = '';
        const frame = raw => {
          const lines = raw.split('\n');
          const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data && data !== '[DONE]') progress(type, JSON.parse(data));
        };
        try {
          while (true) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) { frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
            if (done) { if (buffer.trim()) frame(buffer); break; }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      if (!completed) throw new Error('Connection ended before completion');
      if (!isAgent) histories.chat.push({ role: 'assistant', content: accumulated });
      renderFormattedText(assistant, accumulated);
      display.appendChild(assistant);
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Stopped. Completed changes remain in the workspace.' : error.message;
      assistant.textContent = message;
      // A failed run may have modified files: tell the next turn to inspect current state.
      histories[mode].push({ role: 'assistant', content: `The previous run did not finish: ${message}. Inspect current workspace state before continuing.` });
      if (!isAgent) histories.chat.pop();
    } finally {
      controller = null; input.disabled = false; send.disabled = false; clear.disabled = false;
      agentToggle.disabled = false; keyInput.disabled = false; stop.disabled = true;
      input.focus(); display.scrollTop = display.scrollHeight; fetchLogs();
    }
  });
}
