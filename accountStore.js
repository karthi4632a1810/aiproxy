import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';

const scrypt = promisify(derive);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = prefix => prefix + randomBytes(32).toString('base64url');
export const fail = (status, message) => Object.assign(new Error(message), { status });
export const publicUser = ({ id, name, email, role, disabled, createdAt }) => ({ id, name, email, role, disabled, createdAt });
export const publicKey = ({ hash, ...key }) => key;
const counters = () => ({ requests: 0, completed: 0, errors: 0, aborted: 0, inputTokens: 0, outputTokens: 0, estimatedRequests: 0, durationMs: 0 });
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw fail(400, 'Password must contain 12–256 characters');
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [, salt, hex] = stored.split(':');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(hash, Buffer.from(hex, 'hex'));
}

// A single-process durable store. Writes are serialized, fsynced and atomically
// renamed; memory is published only after a successful save. No raw credentials.
// When MONGODB_URI or MONGO_URI is set, data is also persisted in MongoDB Atlas.
export class AccountStore {
  constructor(directory, { mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI } = {}) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, 'accounts.json');
    this.mongoUri = mongoUri;
    this.mongoClient = null;
    this.mongoCollection = null;
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });

    if (this.mongoUri) {
      try {
        this.mongoClient = new MongoClient(this.mongoUri, { serverSelectionTimeoutMS: 5000 });
        await this.mongoClient.connect();
        const db = this.mongoClient.db('aiproxy');
        this.mongoCollection = db.collection('accounts_store');
        const doc = await this.mongoCollection.findOne({ _id: 'main' });
        if (doc && doc.data && Array.isArray(doc.data.users)) {
          this.data = doc.data;
        } else {
          // If mongo collection is empty, migrate existing local file or initialize default
          let initial = { version: 1, users: [], keys: [], sessions: [], requests: [], daily: [] };
          try { initial = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch {}
          this.data = initial;
          await this.mongoCollection.updateOne(
            { _id: 'main' },
            { $set: { data: this.data, updatedAt: new Date() } },
            { upsert: true }
          );
        }
        console.log('[AccountStore] Connected to MongoDB Atlas successfully.');
      } catch (err) {
        console.error('[AccountStore] MongoDB connection warning:', err.message, '- falling back to local file.');
        this.mongoCollection = null;
      }
    }

    if (!this.mongoCollection) {
      try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.data = { version: 1, users: [], keys: [], sessions: [], requests: [], daily: [] };
        await this.change(() => {});
      }
    }

    if (this.data.version !== 1 || !['users', 'keys', 'sessions', 'requests', 'daily'].every(k => Array.isArray(this.data[k]))) throw new Error('Invalid account store; restore a valid backup');
    // Do not report an interrupted request as successful after restarting.
    await this.change(data => {
      for (const request of data.requests.filter(r => r.outcome === 'pending')) this.finish(data, request, { outcome: 'aborted', status: 499 });
      data.sessions = data.sessions.filter(s => s.expiresAt > Date.now());
    });
    return this;
  }
  change(operation) {
    const job = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = await operation(next);

      // Persist to MongoDB if connected
      if (this.mongoCollection) {
        try {
          await this.mongoCollection.updateOne(
            { _id: 'main' },
            { $set: { data: next, updatedAt: new Date() } },
            { upsert: true }
          );
        } catch (mErr) {
          console.error('[AccountStore] MongoDB write error:', mErr.message);
        }
      }

      // Also persist to local file as backup
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        const file = await fs.open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await fs.rename(temp, this.file);
      } finally { await fs.rm(temp, { force: true }); }
      this.data = next;
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async addUser({ name, email, password, role = 'member' }, first = false) {
    name = typeof name === 'string' ? name.trim() : '';
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!name || name.length > 80 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a name and valid email address');
    if (!['admin', 'member'].includes(role)) throw fail(400, 'Invalid role');
    const passwordHash = await hashPassword(password);
    return this.change(data => {
      if (first && data.users.length) throw fail(409, 'Initial setup is already complete');
      if (data.users.length >= 1000) throw fail(409, 'User limit reached');
      if (data.users.some(u => u.email === email)) throw fail(409, 'Email is already registered');
      const user = { id: randomUUID(), name, email, role: first ? 'admin' : role, passwordHash, disabled: false, createdAt: new Date().toISOString() };
      data.users.push(user); return publicUser(user);
    });
  }
  async createSession(userId) {
    const token = secret('session_'); const csrf = secret('csrf_');
    await this.change(data => {
      if (!data.users.some(u => u.id === userId && !u.disabled)) throw fail(401, 'Account unavailable');
      data.sessions = data.sessions.filter(s => s.expiresAt > Date.now());
      const owned = data.sessions.filter(s => s.userId === userId);
      if (owned.length >= 10) data.sessions = data.sessions.filter(s => s.hash !== owned[0].hash);
      data.sessions.push({ hash: digest(token), userId, csrf, expiresAt: Date.now() + 12 * 3600000 });
    });
    return { token, csrf };
  }
  async createKey(userId, { name, client = 'Other', agent = false, expiresInDays = null }, actor) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw fail(400, 'Key name must contain 1–80 characters');
    if (!['Cline', 'CLI', 'Other'].includes(client)) throw fail(400, 'Invalid client label');
    if (typeof agent !== 'boolean' || (agent && actor.role !== 'admin')) throw fail(403, 'Only administrators can grant workspace access');
    if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)) throw fail(400, 'Expiry must be 1–365 days or null');
    const token = secret('sk-ap_');
    return this.change(data => {
      const user = data.users.find(u => u.id === userId && !u.disabled);
      if (!user) throw fail(404, 'User not found');
      if (actor.id !== userId && actor.role !== 'admin') throw fail(403, 'Access denied');
      if (agent && user.role !== 'admin') throw fail(403, 'Workspace keys require an administrator owner');
      if (data.keys.filter(k => k.userId === userId).length >= 100) throw fail(409, 'Account key limit reached');
      const key = { id: randomUUID(), userId, name: name.trim(), client, agent, prefix: token.slice(0, 14), hash: digest(token),
        createdAt: new Date().toISOString(), expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null,
        revokedAt: null, lastUsedAt: null, stats: counters() };
      data.keys.push(key); return { key: publicKey(key), token };
    });
  }
  async startRequest(entry) {
    return this.change(data => {
      const request = { ...entry, id: randomUUID(), timestamp: new Date().toISOString(), outcome: 'pending', status: null,
        inputTokens: 0, outputTokens: 0, estimated: false, durationMs: 0 };
      data.requests.push(request);
      const completed = data.requests.filter(r => r.outcome !== 'pending');
      const remove = new Set(completed.slice(0, Math.max(0, data.requests.length - 1000)).map(r => r.id));
      data.requests = data.requests.filter(r => !remove.has(r.id));
      const key = data.keys.find(k => k.id === entry.keyId);
      if (key) { key.stats.requests++; key.lastUsedAt = request.timestamp; }
      let daily = data.daily.find(d => d.day === request.timestamp.slice(0, 10) && d.keyId === request.keyId && d.userId === request.userId);
      if (!daily) { daily = { day: request.timestamp.slice(0, 10), keyId: request.keyId, userId: request.userId, ...counters() }; data.daily.push(daily); }
      daily.requests++;
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      data.daily = data.daily.filter(d => d.day >= cutoff);
      return request.id;
    });
  }
  finish(data, request, result) {
    if (!request || request.outcome !== 'pending') return;
    Object.assign(request, { outcome: result.outcome || 'error', status: result.status || 500,
      durationMs: Math.max(0, result.durationMs || 0), inputTokens: result.inputTokens || 0, outputTokens: result.outputTokens || 0, estimated: !!result.estimated });
    const key = data.keys.find(k => k.id === request.keyId);
    const daily = data.daily.find(d => d.day === request.timestamp.slice(0, 10) && d.keyId === request.keyId && d.userId === request.userId);
    for (const stats of [key?.stats, daily].filter(Boolean)) {
      stats[request.outcome === 'completed' ? 'completed' : request.outcome === 'aborted' ? 'aborted' : 'errors']++;
      stats.inputTokens += request.inputTokens; stats.outputTokens += request.outputTokens;
      stats.durationMs += request.durationMs; if (request.estimated) stats.estimatedRequests++;
    }
  }
  finishRequest(id, result) { return this.change(data => this.finish(data, data.requests.find(r => r.id === id), result)); }
}
