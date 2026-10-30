'use strict';
/* Центр спорта «Рекорд» — сайт и сервер соревнований. Без внешних зависимостей. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Pool } = require('./lib/pg');
const mail = require('./lib/mail');

const PORT = +process.env.PORT || 3000;
/* the owner is matched by a SHA-256 of the email, so the address is not written in this public repository */
const OWNER_HASH = (process.env.OWNER_EMAIL_SHA256 || '6956dbd9292ae3e583a197ee0fed5cad6864272e2d15401c8bddf9bedba5eb61').trim().toLowerCase();
const isOwner = e => !!e && require('crypto').createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex') === OWNER_HASH;
const DEV_LOG_CODES = process.env.MAIL_DEV_LOG === '1';
const PUBLIC = path.join(__dirname, 'public');
const DOC_VERSION = process.env.DOC_VERSION || '2026-10-17';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const db = new Pool(process.env.DATABASE_URL, +process.env.DB_POOL || 10);

/* ---------- helpers ---------- */
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Иркутск, UTC+8
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (n, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => Array.from(crypto.randomBytes(n), b => alphabet[b % alphabet.length]).join('');
const str = (v, max = 200) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);
const isEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const digits = s => String(s || '').replace(/\D/g, '');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => new HttpError(400, m);

const wantsGzip = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
function send(res, status, body, headers = {}) {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...headers };
  if (res.req && wantsGzip(res.req) && Buffer.byteLength(data) > 1024) { data = zlib.gzipSync(data); h['Content-Encoding'] = 'gzip'; }
  res.writeHead(status, h);
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(bad('Неверный формат запроса')); }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const secureCookie = req => (req.headers['x-forwarded-proto'] || '').includes('https');

const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'Слишком много попыток. Попробуйте чуть позже');
  arr.push(now); hits.set(key, arr);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

/* ---------- database ---------- */
const SCHEMA = `
create table if not exists content (id int primary key, data jsonb not null, updated_at timestamptz not null default now(), updated_by text);
create table if not exists users (id bigserial primary key, email text unique not null, created_at timestamptz not null default now(), profile jsonb not null default '{}', kids jsonb not null default '[]');
create table if not exists login_codes (email text primary key, code_hash text not null, expires_at timestamptz not null, attempts int not null default 0, sent_at timestamptz not null default now());
create table if not exists sessions (token_hash text primary key, user_id bigint not null references users(id) on delete cascade, created_at timestamptz not null default now(), expires_at timestamptz not null);
create table if not exists staff (email text primary key, name text not null, role text not null, created_at timestamptz not null default now());
create table if not exists leads (id bigserial primary key, created_at timestamptz not null default now(), name text, phone text, dir text, who text, age text, pref_time text, status text not null default 'new');
create table if not exists teams (id bigserial primary key, event_id text not null, div_id text not null, name text not null, code_hash text not null, created_at timestamptz not null default now(), unique(event_id, div_id, name));
create table if not exists registrations (id text primary key, pub text unique not null, created_at timestamptz not null default now(), user_id bigint references users(id) on delete set null,
  event_id text not null, div_id text not null, who text not null, person jsonb not null, team text, size text, promo text, price int not null default 0, due int not null default 0, paid int not null default 0,
  status text not null, publish boolean not null default false, photo boolean not null default false);
create index if not exists registrations_ev on registrations(event_id, div_id);
create index if not exists registrations_user on registrations(user_id);
create table if not exists scores (id bigserial primary key, reg_id text not null references registrations(id) on delete cascade, workout_id text not null, value jsonb not null, video text,
  state text not null default 'pending', created_at timestamptz not null default now(), reviewed_by text, unique(reg_id, workout_id));
create table if not exists backups (id bigserial primary key, created_at timestamptz not null default now(), kind text not null, size int not null, rows int not null, data bytea not null);
create table if not exists consents (id bigserial primary key, created_at timestamptz not null default now(), subject text not null, kind text not null, version text not null, ip text, ua text, ref text);
`;
const ACTIVE = `('new','paid','refund_requested')`;

async function init() {
  for (let i = 0; ; i++) {
    try { await db.query('select 1'); break; } catch (e) { if (i > 20) throw e; console.log('waiting for database:', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
  const { rows } = await db.query('select 1 from content where id=1');
  if (!rows.length) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    await db.query('insert into content(id, data, updated_by) values (1, $1, $2)', [seed, 'seed']);
    console.log('content seeded');
  }
  await db.query('delete from sessions where expires_at < now()');
  await db.query('delete from login_codes where expires_at < now()');
}

/* ---------- content, teams and live results ---------- */
let cache = null; // {json, etag}
const dirty = () => { cache = null; };

async function rawContent() { return (await db.query('select data from content where id=1')).rows[0].data; }

const displayName = r => r.publish ? `${r.person.first || ''} ${r.person.last || ''}`.trim() : `Участник ${r.pub.slice(0, 4)}`;

async function publicContent() {
  if (cache) return cache;
  const c = await rawContent();
  const EVENTS = c.EVENTS || [];
  const counts = (await db.query(`select event_id, div_id, count(*)::int n, count(distinct team)::int t from registrations where status in ${ACTIVE} group by 1,2`)).rows;
  const teams = (await db.query(`select t.event_id, t.div_id, t.name, (select count(*)::int from registrations r where r.event_id=t.event_id and r.div_id=t.div_id and r.team=t.name and r.status in ${ACTIVE}) m from teams t order by t.created_at`)).rows;
  const TEAMS = {};
  teams.filter(t => t.m > 0).forEach(t => { (TEAMS[`${t.event_id}:${t.div_id}`] ||= []).push({ name: t.name, m: t.m }); });
  EVENTS.forEach(ev => (ev.divisions || []).forEach(d => {
    const k = counts.find(x => x.event_id === ev.id && x.div_id === d.id);
    d.taken = !k ? 0 : d.type === 'team' ? (TEAMS[`${ev.id}:${d.id}`] || []).length : k.n;
  }));
  const RESULTS = await liveResults(EVENTS);
  const json = JSON.stringify({ EVENTS, SITE: c.SITE || {}, TEAMS, RESULTS, today: today() });
  cache = { json, gz: zlib.gzipSync(json), etag: '"' + sha(json).slice(0, 20) + '"' };
  return cache;
}

async function liveResults(EVENTS) {
  const { rows } = await db.query(`select s.workout_id, s.value, r.id reg, r.pub, r.event_id, r.div_id, r.team, r.person, r.publish
    from scores s join registrations r on r.id=s.reg_id where s.state='accepted' and r.status in ${ACTIVE} order by s.created_at`);
  const members = (await db.query(`select pub, event_id, div_id, team, person, publish from registrations where team is not null and status in ${ACTIVE} order by created_at`)).rows;
  const RES = {};
  for (const s of rows) {
    const ev = EVENTS.find(e => e.id === s.event_id); if (!ev) continue;
    const div = (ev.divisions || []).find(d => d.id === s.div_id); const w = (ev.workouts || []).find(x => x.id === s.workout_id);
    if (!div || !w) continue;
    const wl = ev.permanent ? ev.workouts.filter(x => x.month === w.month) : ev.workouts;
    const idx = wl.findIndex(x => x.id === w.id);
    const key = ev.permanent ? `${ev.id}@${w.month}:${div.id}` : `${ev.id}:${div.id}`;
    const map = RES[key] ||= new Map();
    const isTeam = div.type === 'team' && s.team;
    const rk = isTeam ? 'T:' + s.team : 'R:' + s.reg;
    if (!map.has(rk)) {
      if (isTeam) {
        const ms = members.filter(m => m.event_id === s.event_id && m.div_id === s.div_id && m.team === s.team);
        map.set(rk, { n: s.team, a: (ms[0] || s).person.affiliate || '', team: ms.map(displayName), k: ms.map(m => m.pub), r: wl.map(() => null) });
      } else {
        map.set(rk, { n: displayName(s), a: s.person.affiliate || '', k: [s.pub], r: wl.map(() => null) });
      }
    }
    map.get(rk).r[idx] = s.value;
  }
  const out = {};
  for (const k in RES) out[k] = [...RES[k].values()];
  return out;
}

/* ---------- auth ---------- */
async function sessionOf(req) {
  const sid = cookies(req).sid; if (!sid) return null;
  const { rows } = await db.query('select u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now()', [sha(sid)]);
  if (!rows.length) return null;
  const u = rows[0];
  u.role = isOwner(u.email) ? 'owner' : ((await db.query('select role from staff where email=$1', [u.email])).rows[0] || {}).role || 'athlete';
  return u;
}
const need = (u, ...roles) => {
  if (!u) throw new HttpError(401, 'Войдите на сайт');
  if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'Нет доступа');
};

async function logConsent(req, subject, kind, ref) {
  await db.query('insert into consents(subject, kind, version, ip, ua, ref) values ($1,$2,$3,$4,$5,$6)',
    [subject, kind, DOC_VERSION, ipOf(req), str(req.headers['user-agent'], 300), ref || null]);
}

/* ---------- validation of stored person data ---------- */
const GENDERS = ['M', 'F'];
function cleanPerson(p, kid) {
  p = p || {};
  const o = {
    first: str(p.first, 60), last: str(p.last, 60), gender: GENDERS.includes(p.gender) ? p.gender : 'M',
    dob: /^\d{4}-\d{2}-\d{2}$/.test(p.dob || '') ? p.dob : '', affiliate: str(p.affiliate, 80),
  };
  o.print = (str(p.print, 60) || `${o.first} ${o.last}`).toUpperCase();
  if (!kid) Object.assign(o, { phone: str(p.phone, 30), tg: str(p.tg, 40), emName: str(p.emName, 80), emPhone: str(p.emPhone, 30) });
  else o.id = /^kid[a-z0-9]{1,16}$/.test(p.id || '') ? p.id : 'kid' + rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
  return o;
}
function ageOn(dob, date) {
  const [y, m, d] = dob.split('-').map(Number); const [Y, M, D] = date.split('-').map(Number);
  return Y - y - ((M < m || (M === m && D < d)) ? 1 : 0);
}

function promoCheck(PROMOS, used, code, ev, price) {
  const c = str(code, 40).toUpperCase(); if (!c) return { err: 'Введите промокод' };
  const p = (PROMOS || []).find(x => x.code === c);
  if (!p) return { err: 'Такого промокода нет' };
  if (p.event !== 'all' && p.event !== ev.id) return { err: 'Промокод не действует на этот старт' };
  if (p.until && today() > p.until) return { err: 'Срок действия промокода истёк' };
  if (p.limit && (used[c] || 0) >= p.limit) return { err: 'Промокод уже использован максимальное число раз' };
  const off = p.kind === 'pct' ? Math.round(price * p.value / 100) : Math.min(price, p.value);
  return { code: c, off, label: p.kind === 'pct' ? `${p.value}%` : `${p.value} ₽` };
}
async function promoUsed(q = db.query.bind(db)) {
  const { rows } = await q(`select promo, count(*)::int n from registrations where promo is not null and promo<>'' and status in ${ACTIVE} group by 1`);
  return Object.fromEntries(rows.map(r => [r.promo, r.n]));
}

/* ---------- API ---------- */
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, opts });

route('GET', '/api/health', async () => ({ ok: true }));

route('GET', '/api/content', async (req, res) => {
  const c = await publicContent();
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, { ETag: c.etag }); res.end(); return undefined; }
  const gz = wantsGzip(req);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gz ? c.gz : c.json);
  return undefined;
});

route('GET', '/api/session', async (req, res, u) => {
  if (!u) return { user: null, mailReady: mail.configured() || DEV_LOG_CODES };
  const regs = (await db.query('select * from registrations where user_id=$1 order by created_at', [u.id])).rows;
  const scores = (await db.query('select s.reg_id, s.workout_id, s.value, s.video, s.state from scores s join registrations r on r.id=s.reg_id where r.user_id=$1', [u.id])).rows;
  return {
    user: { email: u.email, role: u.role, profile: u.profile, kids: u.kids },
    orders: regs.map(orderOut), scores,
  };
});
const orderOut = r => ({ id: r.id, pub: r.pub, event: r.event_id, div: r.div_id, who: r.who, person: r.person, team: r.team, size: r.size, promo: r.promo,
  price: r.price, due: r.due, paid: r.paid, status: r.status, date: new Date(r.created_at.getTime() + 8 * 3600e3).toISOString().slice(0, 10), publish: r.publish });

route('POST', '/api/auth/code', async (req, res, u, body) => {
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw bad('Проверьте email');
  if (!body.consent) throw bad('Нужно согласие на обработку персональных данных');
  limit('code-ip:' + ipOf(req), 60, 3600e3);
  limit('code-mail:' + email, 1, 55e3);
  limit('code-mail-h:' + email, 6, 3600e3);
  const code = String(crypto.randomInt(100000, 1000000));
  await db.query(`insert into login_codes(email, code_hash, expires_at, attempts, sent_at) values ($1,$2, now()+interval '10 minutes', 0, now())
    on conflict (email) do update set code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=now()`, [email, sha(email + ':' + code)]);
  if (mail.configured()) {
    try {
      await mail.send({ to: email, subject: `Код для входа: ${code}`,
        text: `Ваш код для входа на сайт центра спорта «Рекорд»: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто удалите это письмо.\n\nrecordirk.ru`,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111"><p>Ваш код для входа на сайт центра спорта «Рекорд»:</p><p style="font-size:30px;font-weight:700;letter-spacing:4px">${code}</p><p style="color:#666">Код действует 10 минут. Если вы не запрашивали вход, просто удалите это письмо.</p><p><a href="https://recordirk.ru">recordirk.ru</a></p></div>` });
    } catch (e) { console.error('mail error:', e.message, '|', mail.describe()); throw new HttpError(502, 'Не получилось отправить письмо. Попробуйте ещё раз через минуту'); }
  } else if (DEV_LOG_CODES) {
    console.log(`[dev] login code for ${email.replace(/^(.).*(@.*)$/, '$1***$2')}: ${code}`);
  } else {
    throw new HttpError(503, 'Вход временно недоступен: почта сайта ещё не настроена');
  }
  return { ok: true };
});

route('POST', '/api/auth/verify', async (req, res, u, body) => {
  const email = str(body.email, 254).toLowerCase(), code = digits(body.code).slice(0, 6);
  limit('verify-ip:' + ipOf(req), 300, 3600e3);
  const { rows } = await db.query('select * from login_codes where email=$1 and expires_at>now()', [email]);
  const lc = rows[0];
  if (!lc) throw bad('Код устарел. Запросите новый');
  if (lc.attempts >= 5) throw bad('Слишком много неверных попыток. Запросите новый код');
  if (lc.code_hash !== sha(email + ':' + code)) { await db.query('update login_codes set attempts=attempts+1 where email=$1', [email]); throw bad('Неверный код'); }
  await db.query('delete from login_codes where email=$1', [email]);
  const user = (await db.query('insert into users(email) values ($1) on conflict (email) do update set email=excluded.email returning id, (xmax = 0) as created', [email])).rows[0];
  if (user.created) await logConsent(req, 'user:' + user.id, 'pd', 'account');
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`insert into sessions(token_hash, user_id, expires_at) values ($1,$2, now()+interval '60 days')`, [sha(token), user.id]);
  const cookie = `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 86400}${secureCookie(req) ? '; Secure' : ''}`;
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  return undefined;
});

route('POST', '/api/auth/logout', async (req, res) => {
  const sid = cookies(req).sid; if (sid) await db.query('delete from sessions where token_hash=$1', [sha(sid)]);
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  return undefined;
});

route('PUT', '/api/profile', async (req, res, u, body) => {
  need(u);
  const profile = cleanPerson(body.profile, false);
  const kids = (Array.isArray(body.kids) ? body.kids : []).slice(0, 8).map(k => cleanPerson(k, true)).filter(k => k.first && k.last);
  await db.query('update users set profile=$1, kids=$2 where id=$3', [profile, kids, u.id]);
  return { profile, kids };
});

route('POST', '/api/account/delete', async (req, res, u) => {
  need(u);
  await db.tx(async q => {
    await q(`update registrations set person = jsonb_build_object('first','Удалённый','last','участник','affiliate', person->>'affiliate'), publish=false, user_id=null where user_id=$1`, [u.id]);
    await q('delete from users where id=$1', [u.id]);
  });
  dirty();
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  return undefined;
});

route('POST', '/api/lead', async (req, res, u, body) => {
  limit('lead-ip:' + ipOf(req), 20, 3600e3);
  const name = str(body.name, 80), phone = str(body.phone, 30);
  if (!name) throw bad('Как к вам обращаться?');
  if (digits(phone).length < 10) throw bad('Нужен телефон, чтобы мы перезвонили');
  if (!body.consent) throw bad('Нужно согласие, иначе мы не сможем вам позвонить');
  const { rows } = await db.query('insert into leads(name, phone, dir, who, age, pref_time) values ($1,$2,$3,$4,$5,$6) returning id',
    [name, phone, str(body.dir, 80), str(body.who, 40), str(body.age, 20), str(body.time, 40)]);
  await logConsent(req, 'lead:' + rows[0].id, 'pd', 'trial');
  return { ok: true };
});

route('POST', '/api/promo', async (req, res, u, body) => {
  limit('promo-ip:' + ipOf(req), 30, 3600e3);
  const c = await rawContent();
  const ev = (c.EVENTS || []).find(e => e.id === body.event); if (!ev) throw bad('Старт не найден');
  const div = ev.divisions.find(d => d.id === body.div); if (!div) throw bad('Категория не найдена');
  const r = promoCheck(c.PROMOS, await promoUsed(), body.code, ev, div.price || 0);
  if (r.err) throw bad(r.err);
  return r;
});

route('POST', '/api/register', async (req, res, u, body) => {
  need(u);
  limit('reg-user:' + u.id, 20, 3600e3);
  const c = await rawContent();
  const ev = (c.EVENTS || []).find(e => e.id === body.event);
  if (!ev || ev.status === 'draft') throw bad('Старт не найден');
  if (!['open', 'live'].includes(ev.status) || (ev.regTo && today() > ev.regTo)) throw bad('Регистрация на этот старт закрыта');
  const div = (ev.divisions || []).find(d => d.id === body.div); if (!div) throw bad('Категория не найдена');
  const who = body.who === 'me' ? 'me' : str(body.who, 30);
  const person = who === 'me' ? u.profile : (u.kids || []).find(k => k.id === who);
  if (!person || !person.first || !person.last || !person.dob) throw bad('Заполните анкету участника: имя, фамилию и дату рождения');
  if (!u.profile.phone) throw bad('Укажите телефон в анкете');
  const age = ev.ageMode === 'year' ? (+String(ev.date).slice(0, 4) - +person.dob.slice(0, 4)) : ageOn(person.dob, ev.date || today());
  const cons = body.consents || {};
  if (!cons.rules) throw bad('Нужно принять условия участия');
  if (!cons.pd) throw bad('Нужно согласие на обработку персональных данных');
  if (age < 18 && !cons.parent) throw bad('Нужно согласие законного представителя');
  const size = ['XS', 'S', 'M', 'L', 'XL', 'XXL'].includes(body.size) ? body.size : null;
  const snap = { ...cleanPerson(person, who !== 'me'), phone: u.profile.phone, emName: u.profile.emName || '', emPhone: u.profile.emPhone || '', affiliate: str(body.affiliate, 80) || person.affiliate || '' };
  if (who !== 'me') snap.parent = `${u.profile.first || ''} ${u.profile.last || ''}`.trim();
  const out = await db.tx(async q => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`${ev.id}:${div.id}`]);
    const dup = await q(`select 1 from registrations where user_id=$1 and who=$2 and event_id=$3 and status in ${ACTIVE}`, [u.id, who, ev.id]);
    if (dup.rows.length) throw bad('Этот участник уже зарегистрирован на старт');
    let team = null;
    if (div.type === 'team') {
      const t = body.team || {};
      const name = str(t.name, 20).toUpperCase(), code = digits(t.code);
      if (!name) throw bad('Укажите команду');
      if (code.length < 4 || code.length > 6) throw bad('Код команды — от 4 до 6 цифр');
      const ex = (await q('select * from teams where event_id=$1 and div_id=$2 and name=$3', [ev.id, div.id, name])).rows[0];
      const members = ex ? (await q(`select count(*)::int n from registrations where event_id=$1 and div_id=$2 and team=$3 and status in ${ACTIVE}`, [ev.id, div.id, name])).rows[0].n : 0;
      if (t.mode === 'create') {
        if (ex && members > 0) throw bad('Команда с таким названием уже есть');
        const nTeams = (await q(`select count(distinct team)::int n from registrations where event_id=$1 and div_id=$2 and status in ${ACTIVE}`, [ev.id, div.id])).rows[0].n;
        if (div.limit && nTeams >= div.limit) throw bad('Лимит команд в категории набран');
        const h = sha(`${ev.id}:${div.id}:${name}:${code}`);
        if (ex) await q('update teams set code_hash=$1 where id=$2', [h, ex.id]);
        else await q('insert into teams(event_id, div_id, name, code_hash) values ($1,$2,$3,$4)', [ev.id, div.id, name, h]);
      } else {
        limit('team-join:' + u.id, 10, 3600e3);
        if (!ex || members === 0) throw bad('Такой команды нет');
        if (ex.code_hash !== sha(`${ev.id}:${div.id}:${name}:${code}`)) throw bad('Неверный код команды. Уточните его у капитана');
        if (members >= (div.size || 1)) throw bad('В команде уже полный состав');
      }
      team = name;
    } else {
      const n = (await q(`select count(*)::int n from registrations where event_id=$1 and div_id=$2 and status in ${ACTIVE}`, [ev.id, div.id])).rows[0].n;
      if (div.limit && n >= div.limit) throw bad('Места в категории закончились');
    }
    const price = +div.price || 0;
    let promo = null, off = 0;
    if (str(body.promo, 40)) {
      const r = promoCheck(c.PROMOS, await promoUsed(q), body.promo, ev, price);
      if (r.err) throw bad(r.err);
      promo = r.code; off = r.off;
    }
    const due = Math.max(0, price - off);
    const id = `RC-${today().slice(5, 7)}${today().slice(8)}-${rnd(5)}`;
    const pub = rnd(10);
    await q(`insert into registrations(id, pub, user_id, event_id, div_id, who, person, team, size, promo, price, due, paid, status, publish, photo)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15)`,
      [id, pub, u.id, ev.id, div.id, who, snap, team, size, promo, price, due, due === 0 ? 'paid' : 'new', !!cons.publish, !!cons.photo]);
    return (await q('select * from registrations where id=$1', [id])).rows[0];
  });
  const subj = 'user:' + u.id;
  await logConsent(req, subj, 'rules', out.id);
  await logConsent(req, subj, 'pd', out.id);
  if (age < 18) await logConsent(req, subj, 'parent', out.id);
  if (cons.publish) await logConsent(req, subj, 'publish', out.id);
  if (cons.photo) await logConsent(req, subj, 'photo', out.id);
  dirty();
  return { order: orderOut(out) };
});

route('POST', '/api/refund', async (req, res, u, body) => {
  need(u);
  const r = await db.query(`update registrations set status='refund_requested' where id=$1 and user_id=$2 and status in ('new','paid') returning *`, [str(body.id, 40), u.id]);
  if (!r.rows.length) throw bad('Заказ не найден');
  dirty();
  return { order: orderOut(r.rows[0]) };
});

route('POST', '/api/publish', async (req, res, u, body) => {
  need(u);
  const r = await db.query('update registrations set publish=$1 where id=$2 and user_id=$3 returning *', [!!body.publish, str(body.id, 40), u.id]);
  if (!r.rows.length) throw bad('Заказ не найден');
  if (body.publish) await logConsent(req, 'user:' + u.id, 'publish', r.rows[0].id);
  else await logConsent(req, 'user:' + u.id, 'publish-revoked', r.rows[0].id);
  dirty();
  return { order: orderOut(r.rows[0]) };
});

function checkValue(type, v) {
  if (type === 'time') {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 86400) return v;
    if (v && typeof v === 'object' && Number.isInteger(v.cap) && v.cap >= 0 && v.cap < 100000) return { cap: v.cap };
  } else if (typeof v === 'number' && isFinite(v) && v > 0 && v < 100000) return Math.round(v * 100) / 100;
  throw bad('Неверный результат');
}

route('POST', '/api/score', async (req, res, u, body) => {
  need(u);
  limit('score-user:' + u.id, 40, 3600e3);
  const reg = (await db.query('select * from registrations where id=$1 and user_id=$2', [str(body.reg, 40), u.id])).rows[0];
  if (!reg) throw bad('Регистрация не найдена');
  if (reg.status !== 'paid') throw bad('Результат можно сдать после подтверждения оплаты');
  const ev = ((await rawContent()).EVENTS || []).find(e => e.id === reg.event_id);
  if (!ev || ev.format !== 'online' || ev.status !== 'live') throw bad('Сейчас сдача результатов на этот старт закрыта');
  const w = (ev.workouts || []).find(x => x.id === body.workout); if (!w) throw bad('Задание не найдено');
  if (ev.permanent && (ev.months || []).some(m => m.id === w.month && m.done)) throw bad('Итоги этого месяца уже подведены');
  if (!ev.permanent && ev.submitTo && today() > ev.submitTo) throw bad('Окно сдачи результатов закрыто');
  const value = checkValue(w.type, body.value);
  const video = str(body.video, 400);
  if (!/^https?:\/\/\S+\.\S+/.test(video)) throw bad('Нужна ссылка на видео');
  await db.query(`insert into scores(reg_id, workout_id, value, video, state) values ($1,$2,$3,$4,'pending')
    on conflict (reg_id, workout_id) do update set value=excluded.value, video=excluded.video, state='pending', created_at=now(), reviewed_by=null`,
    [reg.id, w.id, JSON.stringify(value), video]);
  dirty();
  return { ok: true, score: { reg_id: reg.id, workout_id: w.id, value, video, state: 'pending' } };
});

/* ---------- organizer panel ---------- */
route('GET', '/api/admin/state', async (req, res, u) => {
  need(u, 'owner', 'admin', 'judge');
  const pending = (await db.query(`select s.id, s.workout_id, s.value, s.video, s.state, s.created_at, r.id reg, r.event_id, r.div_id, r.person, r.team
    from scores s join registrations r on r.id=s.reg_id where s.state='pending' order by s.created_at`)).rows
    .map(s => ({ id: s.id, workout: s.workout_id, value: s.value, video: s.video, reg: s.reg, event: s.event_id, div: s.div_id, team: s.team, name: `${s.person.last || ''} ${s.person.first || ''}`.trim() }));
  if (u.role === 'judge') return { role: u.role, PENDING: pending };
  const c = await rawContent();
  const used = await promoUsed();
  const staff = (await db.query('select email, name, role from staff order by created_at')).rows;
  const leads = (await db.query('select * from leads order by created_at desc')).rows;
  const regs = (await db.query('select r.*, u.email from registrations r left join users u on u.id=r.user_id order by r.created_at')).rows;
  return {
    role: u.role,
    PROMOS: (c.PROMOS || []).map(p => ({ ...p, used: used[p.code] || 0 })),
    ACCESS: [{ email: u.role === 'owner' ? u.email : '', name: 'Владелец', role: 'owner' }, ...staff],
    CLUB_LEADS: leads.map(l => ({ id: l.id, date: new Date(l.created_at.getTime() + 8 * 3600e3).toISOString().slice(0, 10), name: l.name, phone: l.phone, dir: l.dir, who: l.who, age: l.age, time: l.pref_time, status: l.status })),
    REGS: regs.map(r => ({ ...orderOut(r), email: r.email || '' })),
    PENDING: pending,
    SCORES: (await db.query('select id, reg_id, workout_id, value, state from scores')).rows.map(scoreOut),
  };
});
const scoreOut = s => ({ id: s.id, reg: s.reg_id, workout: s.workout_id, value: s.value, state: s.state });

route('POST', '/api/admin/score', async (req, res, u, body) => {
  need(u, 'owner', 'admin', 'judge');
  const reg = (await db.query('select * from registrations where id=$1', [str(body.reg, 40)])).rows[0];
  if (!reg) throw bad('Регистрация не найдена');
  if (reg.status !== 'paid') throw bad('Результат можно внести после оплаты');
  const ev = ((await rawContent()).EVENTS || []).find(e => e.id === reg.event_id);
  const w = ev && (ev.workouts || []).find(x => x.id === body.workout); if (!w) throw bad('Задание не найдено');
  const value = checkValue(w.type, body.value);
  const r = await db.query(`insert into scores(reg_id, workout_id, value, video, state, reviewed_by) values ($1,$2,$3,null,'accepted',$4)
    on conflict (reg_id, workout_id) do update set value=excluded.value, state='accepted', reviewed_by=excluded.reviewed_by returning id, reg_id, workout_id, value, state`,
    [reg.id, w.id, JSON.stringify(value), u.email]);
  dirty();
  return { score: scoreOut(r.rows[0]) };
});

route('PUT', '/api/admin/content', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  if (!Array.isArray(body.EVENTS) || typeof body.SITE !== 'object' || !Array.isArray(body.PROMOS)) throw bad('Неверные данные');
  const PROMOS = body.PROMOS.map(p => ({ code: str(p.code, 40).toUpperCase(), kind: p.kind === 'rub' ? 'rub' : 'pct', value: Math.max(0, +p.value || 0), event: str(p.event, 40) || 'all',
    limit: Math.max(0, parseInt(p.limit, 10) || 0), until: /^\d{4}-\d{2}-\d{2}$/.test(p.until || '') ? p.until : '', note: str(p.note, 120) })).filter(p => p.code);
  const EVENTS = body.EVENTS.map(e => ({ ...e, divisions: (e.divisions || []).map(d => ({ ...d, taken: 0 })) }));
  await db.query('update content set data=$1, updated_at=now(), updated_by=$2 where id=1', [{ EVENTS, SITE: body.SITE, PROMOS }, u.email]);
  dirty();
  return { ok: true };
});

route('POST', '/api/admin/staff', async (req, res, u, body) => {
  need(u, 'owner');
  const email = str(body.email, 254).toLowerCase(), name = str(body.name, 80), role = body.role === 'judge' ? 'judge' : 'admin';
  if (!name) throw bad('Укажите имя');
  if (!isEmail(email)) throw bad('Нужен email, под которым человек входит на сайт');
  if (isOwner(email)) throw bad('Это владелец');
  await db.query('insert into staff(email, name, role) values ($1,$2,$3) on conflict (email) do update set name=excluded.name, role=excluded.role', [email, name, role]);
  return { ok: true };
});
route('DELETE', '/api/admin/staff/:email', async (req, res, u, body, p) => {
  need(u, 'owner');
  await db.query('delete from staff where email=$1', [decodeURIComponent(p.email).toLowerCase()]);
  return { ok: true };
});

route('PATCH', '/api/admin/leads/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  await db.query('update leads set status=$1 where id=$2', [body.status === 'done' ? 'done' : 'new', +p.id || 0]);
  return { ok: true };
});
route('DELETE', '/api/admin/leads/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  await db.query('delete from leads where id=$1', [+p.id || 0]);
  return { ok: true };
});

route('POST', '/api/admin/regs/paid', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => str(x, 40)).filter(Boolean).slice(0, 1000);
  if (!ids.length) throw bad('Не выбраны заявки');
  const r = await db.query(`update registrations set status='paid', paid=due where status='new' and id in (select jsonb_array_elements_text($1::jsonb)) returning *`, [JSON.stringify(ids)]);
  dirty();
  return { orders: r.rows.map(orderOut) };
});
route('PATCH', '/api/admin/regs/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  const st = ['new', 'paid', 'refund_requested', 'refunded', 'cancelled'].includes(body.status) ? body.status : null;
  if (!st) throw bad('Неверный статус');
  const r = await db.query(`update registrations set status=$1, paid = case when $1='paid' then due else paid end where id=$2 returning *`, [st, decodeURIComponent(p.id)]);
  if (!r.rows.length) throw bad('Регистрация не найдена');
  dirty();
  return { order: orderOut(r.rows[0]) };
});

route('PATCH', '/api/admin/scores/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin', 'judge');
  const st = body.state === 'accepted' ? 'accepted' : 'rejected';
  await db.query('update scores set state=$1, reviewed_by=$2 where id=$3', [st, u.email, +p.id || 0]);
  dirty();
  return { ok: true };
});

/* ---------- backups: a daily snapshot of every table, kept 14 days; the owner downloads them ---------- */
const BACKUP_TABLES = ['content', 'users', 'staff', 'leads', 'teams', 'registrations', 'scores', 'consents'];
async function makeBackup(kind) {
  const tables = {}; let rows = 0;
  for (const t of BACKUP_TABLES) { tables[t] = (await db.query(`select * from ${t}`)).rows; rows += tables[t].length; }
  const data = zlib.gzipSync(JSON.stringify({ app: 'record-site', version: 1, created: new Date().toISOString(), tables }));
  const r = await db.query('insert into backups(kind, size, rows, data) values ($1,$2,$3,$4) returning id, created_at', [kind, data.length, rows, data]);
  await db.query(`delete from backups where created_at < now() - interval '14 days'`);
  return r.rows[0];
}
async function dailyBackup() {
  try {
    const { rows } = await db.query(`select 1 from backups where created_at > now() - interval '23 hours'`);
    if (!rows.length) { const b = await makeBackup('daily'); console.log('backup created', b.id); }
  } catch (e) { console.error('backup failed:', e.message); }
}
const backupOut = b => ({ id: b.id, created: b.created_at, kind: b.kind, size: b.size, rows: b.rows });

route('GET', '/api/admin/backups', async (req, res, u) => {
  need(u, 'owner');
  return { backups: (await db.query('select id, created_at, kind, size, rows from backups order by created_at desc')).rows.map(backupOut) };
});
route('POST', '/api/admin/backups', async (req, res, u) => {
  need(u, 'owner');
  limit('backup:' + u.id, 10, 3600e3);
  const b = await makeBackup('manual');
  return { backup: backupOut((await db.query('select id, created_at, kind, size, rows from backups where id=$1', [b.id])).rows[0]) };
});
route('GET', '/api/admin/backups/:id', async (req, res, u, body, p) => {
  need(u, 'owner');
  const b = (await db.query('select id, created_at, data from backups where id=$1', [+p.id || 0])).rows[0];
  if (!b) throw new HttpError(404, 'Копия не найдена');
  const raw = typeof b.data === 'string' ? Buffer.from(b.data.replace(/^\\x/, ''), 'hex') : b.data;
  const stamp = new Date(b.created_at.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="record-backup-${stamp}.json.gz"`, 'Cache-Control': 'no-store' });
  res.end(raw);
  return undefined;
});

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.xml': 'application/xml' };
const fileCache = new Map();
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/docs' || rel === '/docs/') rel = '/docs/index.html';
  if (/^\/docs\/[a-z-]+$/.test(rel)) rel += '.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  let entry = fileCache.get(file);
  if (!entry) {
    try { const st = fs.statSync(file); if (!st.isFile()) return false; const data = fs.readFileSync(file); entry = { data, gz: /\.(html|css|js|json|svg|txt|xml)$/.test(file) ? zlib.gzipSync(data, { level: 9 }) : null, etag: '"' + st.size.toString(36) + '-' + st.mtimeMs.toString(36) + '"' }; fileCache.set(file, entry); }
    catch (_) { return false; }
  }
  const ext = path.extname(file);
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', ETag: entry.etag,
    'Cache-Control': rel.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : rel.startsWith('/img/') ? 'public, max-age=86400' : 'no-cache' };
  if (entry.gz) headers.Vary = 'Accept-Encoding';
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return true; }
  const gz = entry.gz && wantsGzip(req);
  if (gz) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : gz ? entry.gz : entry.data);
  return true;
}

const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const r = routes.find(r => r.method === req.method && r.re.test(pathname));
      if (!r) throw new HttpError(404, 'Не найдено');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Запрос с чужого сайта');
        if (!/^application\/json/.test(req.headers['content-type'] || '') && req.method !== 'DELETE') throw bad('Нужен JSON');
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, pathname === '/api/admin/content' ? 40 * 1048576 : 64 * 1024) : {};
      const u = await sessionOf(req);
      const out = await r.fn(req, res, u, body, pathname.match(r.re).groups || {});
      if (out !== undefined) send(res, 200, out);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
    if (serveStatic(req, res, pathname)) return;
    if (!path.extname(pathname)) { serveStatic(req, res, '/index.html'); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(req.method, pathname, e.stack || e.message);
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Ошибка сервера. Попробуйте ещё раз' });
  }
});

init().then(() => {
  server.listen(PORT, () => console.log(`listening on ${PORT}`, '|', mail.describe()));
  setTimeout(dailyBackup, 60e3).unref();
  setInterval(dailyBackup, 3600e3).unref();
}).catch(e => { console.error('startup failed:', e); process.exit(1); });
