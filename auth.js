import express from 'express';
import { digest, fail, publicUser, publicKey, verifyPassword, hashPassword } from './accountStore.js';
import { extractOptions } from './proxyOptions.js';

const COOKIE = 'aiproxy_session';
const safe = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const local = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname);

export function createSecurity(store, { origin = process.env.APP_ORIGIN, setupToken = process.env.SETUP_TOKEN } = {}) {
  if (origin) origin = new URL(origin).origin;
  const cookieToken = req => (req.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const expectedOrigin = req => origin || `${req.protocol}://${req.get('host')}`;
  const checkOrigin = (req, res, next) => {
    if ((req.get('origin') && req.get('origin') !== expectedOrigin(req)) || req.get('sec-fetch-site') === 'cross-site') return next(fail(403, 'Cross-origin account access denied'));
    next();
  };
  const session = req => {
    const token = cookieToken(req);
    const entry = token && store.data.sessions.find(s => s.hash === digest(token) && s.expiresAt > Date.now());
    const user = entry && store.data.users.find(u => u.id === entry.userId && !u.disabled);
    return user ? { user, session: entry, kind: 'session' } : null;
  };
  const requireAccess = ({ sessionOnly = false, admin = false, agent = false } = {}) => safe(async (req, res, next) => {
    await store.queue;
    const authorization = req.get('authorization'); const alternate = req.get('x-api-key');
    let auth;
    if (!sessionOnly && (authorization || alternate)) {
      const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if ((authorization && !bearer) || (bearer && alternate && bearer !== alternate)) throw fail(401, 'Invalid API credentials');
      const token = bearer || alternate;
      const key = token && store.data.keys.find(k => k.hash === digest(token) && !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now()));
      const user = key && store.data.users.find(u => u.id === key.userId && !u.disabled);
      if (user) auth = { user, key, kind: 'key' };
    } else auth = session(req);
    if (!auth) throw fail(401, 'Log in or supply a valid API key');
    if (auth.kind === 'session') {
      if ((req.get('origin') && req.get('origin') !== expectedOrigin(req)) || req.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Cross-origin session access denied');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-csrf-token') !== auth.session.csrf) throw fail(403, 'Invalid CSRF token; reload and try again');
    }
    if ((admin || agent) && auth.user.role !== 'admin') throw fail(403, 'Administrator access required');
    if (agent && auth.key && !auth.key.agent) throw fail(403, 'This API key does not have workspace access');
    req.auth = auth; next();
  });
  const cookie = (req, res, token, maxAge = 43200) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${expectedOrigin(req).startsWith('https:') ? '; Secure' : ''}`);
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(checkOrigin);
  const attempts = new Map(); let hashing = 0;
  const loginLimit = (req, res, next) => {
    const now = Date.now();
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    if (attempts.size >= 10000 || hashing >= 4) return next(fail(429, 'Too many login attempts; try again later'));
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
    const ids = ['ip:' + (req.ip || req.socket.remoteAddress), 'email:' + email];
    for (const id of ids) {
      const item = attempts.get(id) || { count: 0, until: now + 15 * 60000 };
      item.count++; attempts.set(id, item);
      if (item.count > (id.startsWith('ip:') ? 30 : 10)) { res.set('Retry-After', '900'); return next(fail(429, 'Too many login attempts; try again in 15 minutes')); }
    }
    hashing++; let released = false;
    const release = () => { if (!released) { hashing--; released = true; } };
    res.once('finish', release); res.once('close', release);
    next();
  };
  router.get('/status', (req, res) => res.json({ setupRequired: store.data.users.length === 0, setupTokenRequired: !!setupToken || !local(req) }));
  router.post('/setup', loginLimit, safe(async (req, res) => {
    if (store.data.users.length) throw fail(409, 'Initial setup is already complete');
    if (setupToken ? digest(String(req.body?.setupToken || '')) !== digest(setupToken) : !local(req)) throw fail(403, 'Initial setup requires local access or the configured SETUP_TOKEN');
    const user = await store.addUser(req.body || {}, true);
    const created = await store.createSession(user.id); cookie(req, res, created.token);
    res.status(201).json({ user, csrfToken: created.csrf });
  }));
  // A dummy hash ensures an unknown email takes the same password-derivation path.
  const dummyHash = 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64);
  router.post('/login', loginLimit, safe(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = store.data.users.find(u => u.email === email);
    const valid = await verifyPassword(req.body?.password, user?.passwordHash || dummyHash);
    if (!valid || !user || user.disabled) throw fail(401, 'Invalid email or password');
    const created = await store.createSession(user.id); cookie(req, res, created.token);
    res.json({ user: publicUser(user), csrfToken: created.csrf });
  }));
  router.get('/me', requireAccess({ sessionOnly: true }), (req, res) => res.json({ user: publicUser(req.auth.user), csrfToken: req.auth.session.csrf }));
  router.post('/logout', requireAccess({ sessionOnly: true }), safe(async (req, res) => {
    await store.change(data => { data.sessions = data.sessions.filter(s => s.hash !== req.auth.session.hash); });
    cookie(req, res, '', 0); res.json({ success: true });
  }));
  router.post('/password', requireAccess({ sessionOnly: true }), loginLimit, safe(async (req, res) => {
    if (!await verifyPassword(req.body?.currentPassword, req.auth.user.passwordHash)) throw fail(401, 'Current password is incorrect');
    const passwordHash = await hashPassword(req.body?.password);
    await store.change(data => {
      data.users.find(u => u.id === req.auth.user.id).passwordHash = passwordHash;
      data.sessions = data.sessions.filter(s => s.userId !== req.auth.user.id);
    });
    cookie(req, res, '', 0); res.json({ success: true });
  }));
  const accounts = express.Router();
  accounts.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accounts.use(requireAccess({ sessionOnly: true }));
  const visible = (req, userId) => req.auth.user.role === 'admin' || req.auth.user.id === userId;
  accounts.get('/users', (req, res) => res.json({ users: store.data.users.filter(u => visible(req, u.id)).map(publicUser) }));
  accounts.post('/users', requireAccess({ sessionOnly: true, admin: true }), safe(async (req, res) => res.status(201).json({ user: await store.addUser(req.body || {}) })));
  accounts.patch('/users/:id', requireAccess({ sessionOnly: true, admin: true }), safe(async (req, res) => {
    if (typeof req.body?.disabled !== 'boolean') throw fail(400, 'disabled must be a boolean');
    if (req.params.id === req.auth.user.id) throw fail(400, 'You cannot disable your own account');
    await store.change(data => {
      const user = data.users.find(u => u.id === req.params.id); if (!user) throw fail(404, 'User not found');
      user.disabled = req.body.disabled;
      if (user.disabled) data.sessions = data.sessions.filter(s => s.userId !== user.id);
    });
    res.json({ success: true });
  }));
  accounts.get('/keys', (req, res) => res.json({ keys: store.data.keys.filter(k => visible(req, k.userId)).map(publicKey) }));
  accounts.post('/keys', safe(async (req, res) => res.status(201).json(await store.createKey(req.body?.userId || req.auth.user.id, req.body || {}, req.auth.user))));
  accounts.delete('/keys/:id', safe(async (req, res) => {
    await store.change(data => {
      const key = data.keys.find(k => k.id === req.params.id && visible(req, k.userId));
      if (!key) throw fail(404, 'Key not found');
      key.revokedAt ||= new Date().toISOString();
    });
    res.json({ success: true });
  }));
  accounts.get('/usage', (req, res) => {
    const keyId = req.query.keyId;
    if (keyId && !store.data.keys.some(k => k.id === keyId && visible(req, k.userId))) throw fail(404, 'Key not found');
    const days = Number(req.query.days || 30);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw fail(400, 'days must be between 1 and 90');
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const matches = row => visible(req, row.userId) && (!keyId || row.keyId === keyId);
    const daily = store.data.daily.filter(d => matches(d) && d.day >= since);
    const totals = { requests: 0, completed: 0, errors: 0, aborted: 0, inputTokens: 0, outputTokens: 0, estimatedRequests: 0, durationMs: 0 };
    for (const day of daily) for (const field of Object.keys(totals)) totals[field] += day[field];
    res.json({ totals, daily, requests: store.data.requests.filter(r => matches(r) && r.timestamp.slice(0, 10) >= since).slice(-200).reverse(), days,
      retention: { requestDetails: 1000, dailyDays: 90 } });
  });
  const errorHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: { type: 'authentication_error', message: error.status ? error.message : 'Unable to save or load account data' } });
  };
  router.use(errorHandler); accounts.use(errorHandler);
  return { router, accounts, requireAccess, checkOrigin, errorHandler };
}

export function monitorUsage(store) {
  return safe(async (req, res, next) => {
    const start = Date.now(); const auth = req.auth;
    if (!auth) throw fail(401, 'Authentication required');
    const id = await store.startRequest({ userId: auth.user.id, keyId: auth.key?.id || null,
      endpoint: (req.originalUrl || req.path).split('?')[0], model: extractOptions(req).modelId,
      client: auth.key?.client || 'Dashboard', clientHint: (req.get('x-client-name') || '').slice(0, 100),
      userAgent: (req.get('user-agent') || '').slice(0, 256), ip: req.ip || req.socket.remoteAddress });
    req.usage = { inputTokens: 0, outputTokens: 0, estimated: false };
    req.trackTokens = usage => {
      req.usage.inputTokens += usage.inputTokens; req.usage.outputTokens += usage.outputTokens;
      req.usage.estimated ||= usage.estimated;
    };
    let recorded = false, disconnected = false;
    const finish = closed => {
      disconnected ||= closed && !res.writableEnded;
      if (req.deferUsage) return;
      if (recorded) return; recorded = true;
      const aborted = disconnected;
      const status = aborted ? 499 : req.usage.status || res.statusCode;
      const outcome = aborted ? 'aborted' : req.usage.outcome || (status >= 400 ? 'error' : 'completed');
      store.finishRequest(id, { ...req.usage, status, outcome, durationMs: Date.now() - start }).catch(error => console.error('Usage persistence failed:', error.message));
    };
    res.once('finish', () => finish(false)); res.once('close', () => finish(true));
    req.finishUsage = () => { req.deferUsage = false; finish(false); };
    if (res.destroyed) { finish(true); return; }
    next();
  });
}
