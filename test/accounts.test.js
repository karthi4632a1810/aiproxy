import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { AccountStore, verifyPassword } from '../accountStore.js';
import { createSecurity } from '../auth.js';
import { createApp } from '../server.js';
import { request } from './httpHarness.js';

const password = 'a strong test password 123';
async function fixture(t, production = false, securityOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiproxy-accounts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new AccountStore(directory).init();
  let handler;
  if (production) {
    const app = await createApp({ accountStore: store, agentCompletion: async ({ onUsage }) => {
      onUsage?.({ inputTokens: 10, outputTokens: 5, estimated: true }); return { role: 'assistant', content: 'Done' };
    } });
    handler = app.router;
  } else {
    const security = createSecurity(store, securityOptions); const router = express.Router();
    router.use('/api/auth', security.router); router.use('/api/account', security.accounts);
    handler = router;
  }
  const send = (url, options) => request(handler, 'http://localhost' + url, options);
  const auth = async (endpoint, body) => {
    const response = await send('/api/auth/' + endpoint, { method: 'POST', body });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return { user: data.user, headers: { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken } };
  };
  const admin = await auth('setup', { name: 'Owner', email: 'owner@example.com', password, setupToken: securityOptions.setupToken });
  return { store, send, admin, auth, directory };
}
const post = (headers, body) => ({ method: 'POST', headers, body });

test('first setup, hashed passwords, cookie flags, login/logout and persistent sessions', async t => {
  const { store, send, admin, directory } = await fixture(t);
  assert.equal(admin.user.role, 'admin'); assert.equal(admin.user.passwordHash, undefined);
  assert.equal(store.data.users[0].passwordHash.includes(password), false);
  assert.equal(await verifyPassword(password, store.data.users[0].passwordHash), true);
  assert.equal((await send('/api/auth/setup', post({}, { name: 'Other', email: 'x@example.com', password }))).status, 409);
  assert.equal((await send('/api/auth/login', post({}, { email: 'owner@example.com', password: 'wrong' }))).status, 401);
  const login = await send('/api/auth/login', post({}, { email: 'OWNER@example.com', password }));
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await send('/api/auth/me', { headers: admin.headers })).status, 200);
  const disk = await fs.readFile(store.file, 'utf8'); assert.ok(!disk.includes(admin.headers.Cookie.split('=')[1]));
  const reloaded = await new AccountStore(directory).init(); assert.equal(reloaded.data.users.length, 1); assert.equal(reloaded.data.sessions.length, 2);
  assert.equal((await send('/api/auth/logout', post({ Cookie: admin.headers.Cookie }, {}))).status, 403);
  assert.equal((await send('/api/auth/logout', post(admin.headers, {}))).status, 200);
  assert.equal((await send('/api/auth/me', { headers: admin.headers })).status, 401);
});

test('setup rejects remote takeover and remote setup needs the configured token', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aiproxy-setup-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new AccountStore(directory).init();
  const security = createSecurity(store, { setupToken: 'test-bootstrap' });
  const body = { name: 'Owner', email: 'owner@example.com', password };
  const send = options => request(security.router, 'http://localhost/setup', options);
  assert.equal((await send({ ...post({}, body), remoteAddress: '192.0.2.1' })).status, 403);
  assert.equal((await send(post({ Origin: 'https://evil.example' }, { ...body, setupToken: 'test-bootstrap' }))).status, 403);
  assert.equal((await send({ ...post({}, { ...body, setupToken: 'test-bootstrap' }), remoteAddress: '192.0.2.1' })).status, 201);
});

test('users own their keys; admin can issue keys for members; secrets appear once; revoke and disable', async t => {
  const { store, send, admin, auth } = await fixture(t, true);
  const response = await send('/api/account/users', post(admin.headers, { name: 'Alice', email: 'alice@example.com', password }));
  const alice = (await response.json()).user; assert.equal(response.status, 201);
  const member = await auth('login', { email: alice.email, password });
  const privateKey = await (await send('/api/account/keys', post(admin.headers, { name: 'Admin private' }))).json();
  const created = await send('/api/account/keys', post(admin.headers, { userId: alice.id, name: 'Alice Cline', client: 'Cline' }));
  const first = await created.json(); assert.equal(created.status, 201); assert.match(first.token, /^sk-ap_/);
  const own = await (await send('/api/account/keys', post(member.headers, { name: 'Alice CLI', client: 'CLI' }))).json();
  assert.notEqual(first.token, own.token);
  const listed = await (await send('/api/account/keys', { headers: member.headers })).json();
  assert.equal(listed.keys.length, 2); assert.equal(listed.keys[0].hash, undefined); assert.equal(listed.keys[0].token, undefined);
  assert.equal((await send('/api/account/usage?keyId=' + privateKey.key.id, { headers: member.headers })).status, 404);
  assert.equal((await send('/api/account/keys/' + privateKey.key.id, { method: 'DELETE', headers: member.headers })).status, 404);
  const visibleUsers = await (await send('/api/account/users', { headers: member.headers })).json();
  assert.deepEqual(visibleUsers.users.map(u => u.id), [alice.id]);
  assert.ok(!(await fs.readFile(store.file, 'utf8')).includes(first.token));
  assert.equal((await send('/api/account/keys', post(member.headers, { userId: admin.user.id, name: 'stolen' }))).status, 403);
  assert.equal((await send('/api/account/users', post(member.headers, { name: 'Another', email: 'x@example.com', password }))).status, 403);
  assert.equal((await send('/api/account/keys', post(member.headers, { name: 'shell', agent: true }))).status, 403);
  const keyHeaders = { Authorization: `Bearer ${first.token}` };
  assert.equal((await send('/v1/models', { headers: keyHeaders })).status, 200);
  assert.equal((await send('/api/account/keys', { headers: keyHeaders })).status, 401);
  assert.equal((await send('/api/agent/tools', { headers: keyHeaders })).status, 403);
  assert.equal((await send('/api/logs', { headers: member.headers })).status, 403);
  await send(`/api/account/keys/${first.key.id}`, { method: 'DELETE', headers: member.headers });
  assert.equal((await send('/v1/models', { headers: keyHeaders })).status, 401);
  await send(`/api/account/users/${alice.id}`, { method: 'PATCH', headers: admin.headers, body: { disabled: true } });
  assert.equal((await send('/v1/models', { headers: { 'x-api-key': own.token } })).status, 401);
  assert.equal((await send('/api/auth/me', { headers: member.headers })).status, 401);
});

test('all inference aliases enforce keys; usage records provider tokens, estimates, streaming failures and owner filters', async t => {
  const { store, send, admin, directory } = await fixture(t, true);
  const key1 = await (await send('/api/account/keys', post(admin.headers, { name: 'Cline laptop', client: 'Cline' }))).json();
  const key2 = await (await send('/api/account/keys', post(admin.headers, { name: 'CLI server', client: 'CLI' }))).json();
  const original = globalThis.fetch; let mode = 'success';
  globalThis.fetch = async () => mode === 'failure' ? new Response('provider unavailable', { status: 503 }) : new Response(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }], ...(mode === 'reported' ? { usage: { prompt_tokens: 12, completion_tokens: 3 } } : {}) }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
  t.after(() => { globalThis.fetch = original; });
  const aliases = ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/messages', '/api/chat', '/payload', '/'];
  for (const url of aliases) assert.equal((await send(url, post({}, { messages: [{ role: 'user', content: 'hello' }], stream: false }))).status, 401);
  for (const [index, url] of aliases.entries()) {
    mode = index === 0 ? 'reported' : index === 1 ? 'failure' : 'success';
    const headers = index % 2 ? { 'x-api-key': key2.token } : { Authorization: `Bearer ${key1.token}` };
    headers['user-agent'] = 'test-cli/1'; headers['x-client-name'] = 'Cline workstation';
    const response = await send(url, post(headers, { messages: [{ role: 'user', content: 'hello' }], stream: index === 1 }));
    const text = await response.text(); if (index === 1) assert.match(text, /upstream|Upstream/);
    await store.queue;
  }
  const tracked = await (await send('/api/account/usage', { headers: admin.headers })).json();
  assert.equal(tracked.totals.requests, 7); assert.equal(tracked.totals.errors, 1); assert.equal(tracked.totals.completed, 6);
  const reported = tracked.requests.find(r => r.endpoint === '/v1/chat/completions');
  assert.equal(reported.inputTokens, 12); assert.equal(reported.outputTokens, 3); assert.equal(reported.estimated, false);
  assert.equal(tracked.requests.find(r => r.endpoint === '/chat/completions').status, 502);
  assert.equal(tracked.requests[0].ip, '127.0.0.1'); assert.equal(tracked.requests[0].clientHint, 'Cline workstation');
  const only = await (await send('/api/account/usage?keyId=' + key1.key.id, { headers: admin.headers })).json();
  assert.equal(only.totals.requests, 4); assert.ok(only.requests.every(r => r.keyId === key1.key.id));
  const disk = await new AccountStore(directory).init(); assert.equal(disk.data.keys[0].stats.requests, 4);
  assert.equal((await send('/v1/models', { headers: { Authorization: 'Bearer sk-proxy' } })).status, 401);
});

test('session CSRF, HTTPS cookies, password changes and expired keys', async t => {
  const { store, send, admin } = await fixture(t, false, { origin: 'https://proxy.example.com' });
  const headers = { ...admin.headers, Origin: 'https://proxy.example.com' };
  assert.equal((await send('/api/account/keys', post({ Cookie: headers.Cookie }, { name: 'x' }))).status, 403);
  assert.equal((await send('/api/account/keys', post({ ...headers, Origin: 'https://evil.example' }, { name: 'x' }))).status, 403);
  const login = await send('/api/auth/login', post({ Origin: headers.Origin }, { email: admin.user.email, password }));
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  const key = await store.createKey(admin.user.id, { name: 'expires' }, admin.user);
  await store.change(data => { data.keys[0].expiresAt = new Date(0).toISOString(); });
  const security = createSecurity(store);
  const guard = express.Router(); guard.get('/models', security.requireAccess(), (req, res) => res.json({ ok: true })); guard.use(security.errorHandler);
  assert.equal((await request(guard, 'http://localhost/models', { headers: { Authorization: `Bearer ${key.token}` } })).status, 401);
  const changed = await send('/api/auth/password', post(headers, { currentPassword: password, password: 'changed password 123456' }));
  assert.equal(changed.status, 200); assert.equal(store.data.sessions.length, 0);
  assert.equal((await send('/api/auth/login', post({}, { email: admin.user.email, password }))).status, 401);
});

test('workspace access requires an administrator session or explicitly scoped key; usage includes agent calls', async t => {
  const { store, send, admin } = await fixture(t, true);
  const normal = await (await send('/api/account/keys', post(admin.headers, { name: 'proxy' }))).json();
  const scoped = await (await send('/api/account/keys', post(admin.headers, { name: 'workspace', agent: true }))).json();
  assert.equal((await send('/api/agent/tools', { headers: { Authorization: `Bearer ${normal.token}` } })).status, 403);
  const headers = { Authorization: `Bearer ${scoped.token}` };
  assert.equal((await send('/api/agent/tools', { headers })).status, 200);
  assert.equal((await send('/api/agent/session', post({}, {}))).status, 401);
  const response = await send('/api/agent/run', post(headers, { prompt: 'hello', stream: false }));
  assert.equal((await response.json()).status, 'completed'); await store.queue;
  const usage = store.data.keys.find(k => k.id === scoped.key.id).stats;
  assert.equal(usage.requests, 1); assert.equal(usage.inputTokens, 10); assert.equal(usage.outputTokens, 5);
});

test('serialized usage updates keep concurrent requests and recover interrupted requests', async t => {
  const { store, admin, directory } = await fixture(t);
  const created = await store.createKey(admin.user.id, { name: 'parallel' }, admin.user);
  const ids = await Promise.all(Array.from({ length: 20 }, () => store.startRequest({ userId: admin.user.id, keyId: created.key.id, endpoint: '/test' })));
  await Promise.all(ids.slice(0, 19).map(id => store.finishRequest(id, { outcome: 'completed', status: 200, inputTokens: 2, outputTokens: 1 })));
  const reloaded = await new AccountStore(directory).init();
  const stats = reloaded.data.keys[0].stats;
  assert.equal(stats.requests, 20); assert.equal(stats.completed, 19); assert.equal(stats.aborted, 1); assert.equal(stats.outputTokens, 19);
});

test('disconnects abort the upstream and persist one stopped request with estimated usage', async t => {
  const { store, send, admin } = await fixture(t, true);
  const key = await (await send('/api/account/keys', post(admin.headers, { name: 'cancel test' }))).json();
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    const stop = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  t.after(() => { globalThis.fetch = original; });
  const response = await send('/v1/chat/completions', post({ Authorization: `Bearer ${key.token}` }, { messages: [{ role: 'user', content: 'hi' }], stream: true }));
  await response.body.cancel();
  await new Promise(resolve => setTimeout(resolve, 20)); await store.queue;
  assert.equal(aborted, true);
  const usage = store.data.keys[0].stats;
  assert.equal(usage.requests, 1); assert.equal(usage.aborted, 1); assert.equal(usage.completed, 0);
  assert.ok(usage.inputTokens > 0); assert.equal(store.data.requests[0].status, 499);
});

test('login throttles repeated failed attempts and expired sessions cannot manage keys', async t => {
  const { store, send, admin } = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const response = await send('/api/auth/login', post({}, { email: 'nobody@example.com', password: 'incorrect' }));
    assert.equal(response.status, 401);
  }
  const blocked = await send('/api/auth/login', post({}, { email: 'nobody@example.com', password: 'incorrect' }));
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '900');
  await store.change(data => { data.sessions[0].expiresAt = Date.now() - 1; });
  assert.equal((await send('/api/account/keys', { headers: admin.headers })).status, 401);
});
