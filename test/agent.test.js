import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from './httpHarness.js';
import { WorkspaceTools } from '../workspaceTools.js';
import { runAgent, createAgentRouter } from '../agent.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiproxy-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new WorkspaceTools(root).init();
}
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const options = { modelId: 'test', thinking: false, deepSearch: false };

test('workspace lifecycle: create, read, exact edit, search, command, delete', async t => {
  const ws = await fixture(t);
  await ws.execute('create_directory', { path: 'src' });
  await ws.execute('write_file', { path: 'src/hello.js', content: 'console.log("hello");\n' });
  assert.match((await ws.execute('read_file', { path: 'src/hello.js' })).content, /hello/);
  await ws.execute('edit_file', { path: 'src/hello.js', old_text: 'hello', new_text: 'world' });
  const run = await ws.execute('execute_command', { command: 'node hello.js', cwd: 'src' });
  assert.equal(run.stdout, 'world\n'); assert.equal(run.exit_code, 0);
  const search = await ws.execute('search_files', { query: 'world' });
  assert.equal(search.matches[0].path, 'src/hello.js');
  assert.equal((await ws.execute('list_files', { recursive: true })).entries.length, 2);
  await assert.rejects(ws.execute('delete_path', { path: 'src' }), /not empty/);
  await ws.execute('delete_path', { path: 'src', recursive: true });
  await assert.rejects(fs.stat(path.join(ws.root, 'src')), { code: 'ENOENT' });
});

test('rejects escape paths, symlinks, root deletion, hardlink writes and invalid arguments', async t => {
  const ws = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiproxy-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret'), 'untouched');
  await fs.symlink(outside, path.join(ws.root, 'link'));
  for (const target of ['../escape', outside, 'link/secret', 'link/new']) {
    await assert.rejects(ws.execute('write_file', { path: target, content: 'bad' }), /outside|Symbolic/);
  }
  await assert.rejects(ws.execute('execute_command', { command: 'pwd', cwd: '..' }), /outside/);
  await assert.rejects(ws.execute('delete_path', { path: '.', recursive: true }), /root/);
  await fs.link(path.join(outside, 'secret'), path.join(ws.root, 'hardlink'));
  await assert.rejects(ws.execute('write_file', { path: 'hardlink', content: 'bad' }), /hard-linked/);
  assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'untouched');
  await assert.rejects(ws.execute('write_file', { path: 'file', content: 2 }), /Invalid argument/);
  await assert.rejects(ws.execute('execute_command', { command: 'pwd', timeout_ms: 999999 }), /Invalid argument/);
  await assert.rejects(ws.execute('made_up', {}), /Unknown/);
});

test('edit failures preserve contents; replacements use literal dollar signs', async t => {
  const ws = await fixture(t);
  await ws.execute('write_file', { path: 'f', content: 'same same' });
  for (const old_text of ['', 'missing', 'same']) await assert.rejects(ws.execute('edit_file', { path: 'f', old_text, new_text: 'new' }));
  assert.equal((await ws.execute('read_file', { path: 'f' })).content, 'same same');
  await ws.execute('edit_file', { path: 'f', old_text: 'same same', new_text: '$& literal' });
  assert.equal((await ws.execute('read_file', { path: 'f' })).content, '$& literal');
});

test('command reports stderr/nonzero exits, times out, caps output and cancels', async t => {
  const ws = await fixture(t);
  const failure = await ws.execute('execute_command', { command: 'printf problem >&2; exit 7' });
  assert.equal(failure.exit_code, 7); assert.equal(failure.stderr, 'problem');
  const timeout = await ws.execute('execute_command', { command: 'sleep 10', timeout_ms: 100 });
  assert.equal(timeout.timed_out, true); assert.equal(timeout.signal, 'SIGKILL');
  const big = await ws.execute('execute_command', { command: 'yes output' });
  assert.equal(big.truncated, true); assert.ok(big.stdout.length <= 65536);
  const controller = new AbortController();
  const running = ws.execute('execute_command', { command: 'sleep 10' }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, { name: 'AbortError' });
});

test('agent executes dependent tools, feeds real results back, and finishes', async t => {
  const ws = await fixture(t); const events = []; let step = 0;
  const result = await runAgent({ workspace: ws, messages: [{ role: 'user', content: 'Write and run a script' }], options,
    emit: (type, data) => events.push({ type, data }),
    completion: async ({ messages }) => {
      step++;
      if (step === 1) return { role: 'assistant', content: null, tool_calls: [
        call('write_file', { path: 'a.js', content: 'console.log(42)' }),
        call('execute_command', { command: 'node a.js' })
      ] };
      assert.equal(messages.at(-1).role, 'tool');
      assert.equal(JSON.parse(messages.at(-1).content).stdout, '42\n');
      return { role: 'assistant', content: 'Created a.js and verified output 42.', finishReason: 'stop' };
    }
  });
  assert.equal(result.status, 'completed'); assert.equal(result.steps, 2);
  assert.equal(events.filter(e => e.type === 'tool_result').length, 2);
  assert.ok(result.messages.some(m => m.role === 'tool'));
});

test('agent feeds failures back and enforces step limit', async t => {
  const ws = await fixture(t);
  const result = await runAgent({ workspace: ws, messages: [], options, maxSteps: 2,
    completion: async ({ messages }) => {
      if (messages.at(-1)?.role === 'tool') assert.equal(JSON.parse(messages.at(-1).content).ok, false);
      return { role: 'assistant', content: null, tool_calls: [call('read_file', { path: 'missing' })] };
    }
  });
  assert.equal(result.status, 'max_steps'); assert.equal(result.steps, 2);
});

function client(router) {
  return (url, options) => request(router, url.replace('/api/agent', ''), options);
}

test('agent HTTP authentication, origin checks, API execution and event stream', async t => {
  const ws = await fixture(t);
  const base = 'http://localhost/api/agent';
  const fetch = client(await createAgentRouter({ root: ws.root, apiKey: 'test-secret',
    completion: async () => ({ role: 'assistant', content: 'All done', finishReason: 'stop' }) }));
  assert.equal((await fetch(base + '/tools')).status, 401);
  assert.equal((await fetch(base + '/session', { method: 'POST' })).status, 403);
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/tools', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const tools = await (await fetch(base + '/tools', { headers })).json();
  assert.equal(tools.tools.length, 8); assert.equal(tools.workspace, ws.root);
  const write = await fetch(base + '/tools/write_file', { method: 'POST', headers, body: JSON.stringify({ path: 'from-api', content: 'ok' }) });
  assert.equal(write.status, 200); assert.equal(await fs.readFile(path.join(ws.root, 'from-api'), 'utf8'), 'ok');
  const result = await fetch(base + '/run', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', stream: false }) });
  assert.equal((await result.json()).status, 'completed');
  const stream = await fetch(base + '/run', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) });
  const text = await stream.text(); assert.match(text, /event: run_start/); assert.match(text, /event: done/);
  assert.equal((await fetch(base + '/run', { method: 'POST', headers, body: '{"prompt":"hi","max_steps":0}' })).status, 400);
});

test('local session rejects DNS rebinding and disabled agents reject all access', async t => {
  const ws = await fixture(t);
  const base = 'http://localhost/api/agent';
  const fetch = client(await createAgentRouter({ root: ws.root }));
  assert.equal((await fetch(base + '/session', { method: 'POST', headers: { Host: 'evil.example' } })).status, 403);
  const session = await (await fetch(base + '/session', { method: 'POST' })).json();
  assert.ok(session.token.length >= 64);
  assert.equal((await fetch(base + '/tools', { headers: { Authorization: `Bearer ${session.token}` } })).status, 200);
  const disabled = client(await createAgentRouter({ root: ws.root, enabled: false }));
  assert.equal((await disabled(base + '/session', { method: 'POST' })).status, 403);
});

test('active workspace runs reject overlapping mutations', async t => {
  const ws = await fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const base = 'http://localhost/api/agent';
  const fetch = client(await createAgentRouter({ root: ws.root, apiKey: 'test', completion: async () => {
    await gate; return { role: 'assistant', content: 'done' };
  } }));
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const running = await fetch(base + '/run', { method: 'POST', headers, body: '{"prompt":"go","stream":true}' });
  try {
    assert.equal((await fetch(base + '/tools/write_file', { method: 'POST', headers, body: '{"path":"x","content":"x"}' })).status, 409);
  } finally { release(); await running.text(); }
});
