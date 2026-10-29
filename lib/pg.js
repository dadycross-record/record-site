'use strict';
/* Minimal PostgreSQL client: SSL, SCRAM-SHA-256 / md5 / cleartext auth, extended-query protocol
   with text parameters, a small pool and transactions. No dependencies. */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function parseUrl(u) {
  const x = new URL(u);
  return {
    host: x.hostname, port: +x.port || 5432,
    user: decodeURIComponent(x.username), password: decodeURIComponent(x.password),
    database: decodeURIComponent(x.pathname.slice(1)) || 'postgres',
    ssl: x.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer',
  };
}

const cstr = s => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
function msg(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const i16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

function toText(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function fromText(oid, s) {
  switch (oid) {
    case 16: return s === 't';
    case 20: case 21: case 23: case 26: return parseInt(s, 10);
    case 700: case 701: case 1700: return Number(s);
    case 114: case 3802: return JSON.parse(s);
    case 1184: case 1114: return new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    default: return s;
  }
}

class PgError extends Error {
  constructor(f) { super(f.M || 'postgres error'); this.code = f.C; this.detail = f.D; this.severity = f.S; }
}

class Conn {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.queue = []; this.cur = null; this.dead = false; this.locked = false; }

  async connect() {
    const cfg = this.cfg;
    let sock = await new Promise((res, rej) => {
      const s = net.connect(cfg.port, cfg.host);
      s.once('connect', () => res(s)); s.once('error', rej);
    });
    sock.setKeepAlive(true, 30000);
    if (cfg.ssl !== 'disable') {
      sock.write(Buffer.concat([i32(8), i32(80877103)]));
      const ans = await new Promise((res, rej) => { sock.once('data', res); sock.once('error', rej); });
      if (ans[0] === 0x53) {
        sock = tls.connect({ socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.ssl === 'verify-full' });
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      } else if (cfg.ssl === 'require' || cfg.ssl === 'verify-full') {
        throw new Error('postgres server does not support SSL');
      }
    }
    this.sock = sock;
    sock.on('data', d => this.onData(d));
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new Error('postgres connection closed')));
    const params = Buffer.concat([cstr('user'), cstr(cfg.user), cstr('database'), cstr(cfg.database), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]);
    const start = Buffer.concat([i32(params.length + 8), i32(196608), params]);
    await new Promise((res, rej) => { this.cur = { kind: 'startup', res, rej }; sock.write(start); });
    this.cur = null;
    this.next();
  }

  fail(e) {
    if (this.dead) return;
    this.dead = true;
    const all = [this.cur, ...this.queue].filter(Boolean);
    this.cur = null; this.queue = [];
    all.forEach(q => q.rej(e));
    try { this.sock && this.sock.destroy(); } catch (_) {}
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.fail(e); return; }
    }
  }

  handle(type, body) {
    const q = this.cur;
    switch (type) {
      case 'R': return this.auth(body);
      case 'E': {
        const f = {}; let i = 0;
        while (i < body.length && body[i] !== 0) { const k = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); f[k] = body.toString('utf8', i + 1, end); i = end + 1; }
        const err = new PgError(f);
        if (q && q.kind === 'startup') { q.rej(err); this.fail(err); return; }
        if (q) q.err = err;
        return;
      }
      case 'T': {
        const n = body.readInt16BE(0); let i = 2; const fields = [];
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, i); const name = body.toString('utf8', i, end); i = end + 1;
          const oid = body.readInt32BE(i + 6); i += 18;
          fields.push({ name, oid });
        }
        if (q) q.fields = fields;
        return;
      }
      case 'D': {
        const n = body.readInt16BE(0); let i = 2; const row = {};
        for (let k = 0; k < n; k++) {
          const len = body.readInt32BE(i); i += 4;
          const f = q.fields[k];
          if (len < 0) row[f.name] = null;
          else { row[f.name] = fromText(f.oid, body.toString('utf8', i, i + len)); i += len; }
        }
        q.rows.push(row);
        return;
      }
      case 'C': { const tag = body.toString('utf8', 0, body.length - 1); const m = tag.match(/(\d+)$/); if (q) q.rowCount = m ? +m[1] : 0; return; }
      case 'Z':
        if (!q) return;
        if (q.kind === 'startup') { q.res(); return; }
        this.cur = null;
        if (q.err) q.rej(q.err); else q.res({ rows: q.rows, rowCount: q.rowCount || 0 });
        this.next();
        return;
      default: return; // S, K, N, 1, 2, 3, n, s, I
    }
  }

  auth(body) {
    const code = body.readInt32BE(0), cfg = this.cfg;
    if (code === 0) return;
    if (code === 3) return this.sock.write(msg('p', cstr(cfg.password)));
    if (code === 5) {
      const md5 = s => crypto.createHash('md5').update(s).digest('hex');
      const salt = body.subarray(4, 8);
      const inner = md5(cfg.password + cfg.user);
      const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      return this.sock.write(msg('p', cstr(outer)));
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('unsupported SASL mechanism');
      this.nonce = crypto.randomBytes(18).toString('base64');
      this.firstBare = `n=*,r=${this.nonce}`;
      const data = Buffer.from('n,,' + this.firstBare);
      return this.sock.write(msg('p', cstr('SCRAM-SHA-256'), i32(data.length), data));
    }
    if (code === 11) {
      const serverFirst = body.toString('utf8', 4);
      const a = Object.fromEntries(serverFirst.split(',').map(p => [p[0], p.slice(2)]));
      if (!a.r.startsWith(this.nonce)) throw new Error('SCRAM nonce mismatch');
      const salted = crypto.pbkdf2Sync(cfg.password, Buffer.from(a.s, 'base64'), +a.i, 32, 'sha256');
      const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
      const clientKey = hmac(salted, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = `c=biws,r=${a.r}`;
      const authMessage = `${this.firstBare},${serverFirst},${finalNoProof}`;
      const sig = hmac(storedKey, authMessage);
      const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
      this.serverSig = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
      return this.sock.write(msg('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)));
    }
    if (code === 12) {
      const v = body.toString('utf8', 4).split(',').find(p => p.startsWith('v='));
      if (!v || v.slice(2) !== this.serverSig) throw new Error('SCRAM server signature mismatch');
      return;
    }
    throw new Error('unsupported postgres auth method ' + code);
  }

  query(text, params = []) {
    if (this.dead) return Promise.reject(new Error('postgres connection closed'));
    return new Promise((res, rej) => { this.queue.push({ kind: 'q', text, params, res, rej, rows: [], fields: [] }); this.next(); });
  }

  next() {
    if (this.cur || !this.queue.length || !this.sock || this.dead) return;
    const q = this.cur = this.queue.shift();
    const vals = q.params.map(toText);
    const bindParams = vals.map(v => { if (v === null) return i32(-1); const b = Buffer.from(v, 'utf8'); return Buffer.concat([i32(b.length), b]); });
    this.sock.write(Buffer.concat([
      msg('P', cstr(''), cstr(q.text), i16(0)),
      msg('B', cstr(''), cstr(''), i16(0), i16(vals.length), ...bindParams, i16(0)),
      msg('D', Buffer.from('P'), cstr('')),
      msg('E', cstr(''), i32(0)),
      msg('S'),
    ]));
  }
}

class Pool {
  /* Each connection serves one caller at a time: a query or a whole transaction checks it out and gives it back.
     Callers beyond `max` wait in a FIFO queue. */
  constructor(url, max = 4) { this.cfg = parseUrl(url); this.max = max; this.idle = []; this.count = 0; this.waiters = []; }
  async acquire() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.count--; }
    if (this.count < this.max) {
      this.count++;
      const c = new Conn(this.cfg);
      try { await c.connect(); return c; } catch (e) { this.count--; this.wake(); throw e; }
    }
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }
  wake() {
    const w = this.waiters.shift(); if (!w) return;
    this.acquire().then(w.res, w.rej);
  }
  release(c) {
    if (c.dead) { this.count--; this.wake(); return; }
    const w = this.waiters.shift();
    if (w) w.res(c); else this.idle.push(c);
  }
  async query(text, params) {
    const c = await this.acquire();
    try { return await c.query(text, params); } finally { this.release(c); }
  }
  async tx(fn) {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const out = await fn((t, p) => c.query(t, p));
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { this.release(c); }
  }
}

module.exports = { Pool, PgError };
