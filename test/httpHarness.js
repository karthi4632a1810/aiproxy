import { EventEmitter } from 'node:events';

// Exercise the real Express router/middleware and handler stack without a TCP
// listener. Response bodies use Web Streams so cancellation is tested as well.
export function request(handler, url, { method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    normalized.host ||= parsed.host;
    const req = { method, url: parsed.pathname + parsed.search, originalUrl: parsed.pathname + parsed.search, path: parsed.pathname,
      protocol: parsed.protocol.slice(0, -1), hostname: normalized.host.split(':')[0], headers: normalized,
      query: Object.fromEntries(parsed.searchParams), body: typeof body === 'string' ? JSON.parse(body) : body,
      socket: { remoteAddress }, get(name) { return normalized[name.toLowerCase()]; } };
    const res = new EventEmitter();
    let output;
    const stream = new ReadableStream({ start(controller) { output = controller; }, cancel() { res.destroyed = true; res.emit('close'); } });
    res.statusCode = 200; res.headersSent = false; res.destroyed = false; res.writableEnded = false;
    const responseHeaders = new Headers();
    res.set = values => { for (const [k, v] of Object.entries(values)) responseHeaders.set(k, v); return res; };
    res.setHeader = (k, v) => responseHeaders.set(k, v);
    // Express supports both set(name, value) and set(object).
    const setObject = res.set;
    res.set = (name, value) => typeof name === 'string' ? (responseHeaders.set(name, value), res) : setObject(name);
    res.status = code => { res.statusCode = code; return res; };
    res.flushHeaders = () => {
      if (!res.headersSent) { res.headersSent = true; resolve(new Response(stream, { status: res.statusCode, headers: responseHeaders })); }
    };
    res.write = data => { res.flushHeaders(); if (!res.destroyed) output.enqueue(new TextEncoder().encode(data)); return true; };
    res.end = data => {
      if (res.writableEnded || res.destroyed) return;
      if (data) res.write(data); else res.flushHeaders();
      res.writableEnded = true; output.close(); res.emit('finish'); res.emit('close');
    };
    res.json = data => { responseHeaders.set('content-type', 'application/json'); res.end(JSON.stringify(data)); return res; };
    try {
      const result = handler(req, res, error => {
        if (error) reject(error); else if (!res.writableEnded) res.status(404).json({ error: { message: 'Not found' } });
      });
      result?.catch(reject);
    } catch (error) { reject(error); }
  });
}
