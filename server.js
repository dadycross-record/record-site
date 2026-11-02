'use strict';
/* Центр спорта «Рекорд» — сайт и сервер соревнований. Без внешних зависимостей. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Pool } = require('./lib/pg');
const mail = require('./lib/mail');
const tg = require('./lib/tg');

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
const unlimit = (...keys) => { for (const k of keys) { const a = hits.get(k); if (a && a.length) a.pop(); } };
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const isPrivateIp = a => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(a);
const ipOf = req => {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!isPrivateIp(chain[i])) return chain[i];
  return chain[0] || req.socket.remoteAddress || '';
};
let xffSeen = 0;
/* per-visitor limit when the real address is known; the hosting proxy currently hides it,
   so without a public address only a site-wide ceiling applies (per-email limits still hold) */
function ipLimit(req, name, perIp, siteWide, windowMs = 3600e3) {
  const ip = ipOf(req);
  if (ip && !isPrivateIp(ip)) limit(name + ':' + ip, perIp, windowMs);
  limit(name + ':all', siteWide, windowMs);
}
function logClientIpShape(req) {
  if (xffSeen >= 3) return; xffSeen++;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const kind = a => isPrivateIp(a) ? 'private' : 'public';
  console.log(`client ip check: xff=${chain.length} [${chain.map(kind).join(', ')}] x-real-ip=${req.headers['x-real-ip'] ? kind(req.headers['x-real-ip']) : 'none'} socket=${kind(req.socket.remoteAddress || '')} -> using ${kind(ipOf(req))}`);
}

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
alter table registrations add column if not exists note text;
alter table registrations add column if not exists updated_by text;
create table if not exists crew (id bigserial primary key, event_id text not null, name text not null, phone text, contact text, role text not null, status text not null default 'request',
  rate int, work jsonb not null default '{}', note text, created_at timestamptz not null default now(), updated_by text);
create index if not exists crew_ev on crew(event_id);
alter table crew add column if not exists user_id bigint references users(id) on delete set null;
alter table crew add column if not exists avail jsonb not null default '[]';
alter table crew add column if not exists source text not null default 'manual';
alter table crew add column if not exists info jsonb not null default '{}';
alter table users add column if not exists avatar text;
alter table registrations add column if not exists waiver text;
alter table teams add column if not exists invite text;
alter table teams add column if not exists captain_reg text;
alter table registrations add column if not exists team_role text;
update registrations set team_role='main' where team is not null and team_role is null;
update teams t set captain_reg = (select r.id from registrations r where r.event_id=t.event_id and r.div_id=t.div_id and r.team=t.name order by r.created_at limit 1) where captain_reg is null;
update teams set invite = substr(md5(random()::text || id::text), 1, 16) where invite is null;
update users set profile = jsonb_set(profile, '{affiliate}', '"RECORD"') where profile->>'affiliate' ilike 'record пивовариха';
update registrations set person = jsonb_set(person, '{affiliate}', '"RECORD"') where person->>'affiliate' ilike 'record пивовариха';
create unique index if not exists crew_user_ev on crew(event_id, user_id) where user_id is not null;
create table if not exists notify_emails (email text primary key, added_by text, created_at timestamptz not null default now());
create table if not exists tg_chats (chat_id text primary key, email text, name text, created_at timestamptz not null default now());
create table if not exists tg_links (code text primary key, email text not null, expires_at timestamptz not null);
create table if not exists crew_rates (event_id text primary key, rates jsonb not null default '{}', shift_hours numeric not null default 8, updated_by text);
create index if not exists registrations_user on registrations(user_id);
create table if not exists kids (id text primary key, first text not null, last text not null, gender text not null default 'M', dob text not null default '', affiliate text not null default '', print text,
  match_key text, created_by bigint, owner_user bigint references users(id) on delete set null, created_at timestamptz not null default now());
create index if not exists kids_key on kids(match_key);
create table if not exists kid_guardians (kid_id text not null references kids(id) on delete cascade, user_id bigint not null references users(id) on delete cascade, created_at timestamptz not null default now(), primary key(kid_id, user_id));
create index if not exists kid_guardians_user on kid_guardians(user_id);
create table if not exists kid_invites (token_hash text primary key, kid_id text not null references kids(id) on delete cascade, from_user bigint, kind text not null, email text, expires_at timestamptz not null, created_at timestamptz not null default now());
alter table registrations add column if not exists penalty text;
alter table registrations add column if not exists athlete_user bigint references users(id) on delete set null;
insert into kids (id, first, last, gender, dob, affiliate, print, created_by, created_at)
  select k->>'id', coalesce(k->>'first',''), coalesce(k->>'last',''), coalesce(k->>'gender','M'), coalesce(k->>'dob',''), coalesce(k->>'affiliate',''), k->>'print', u.id, u.created_at
  from users u, jsonb_array_elements(u.kids) k where jsonb_typeof(u.kids)='array' and coalesce(k->>'id','') <> '' on conflict (id) do nothing;
insert into kid_guardians (kid_id, user_id) select k->>'id', u.id from users u, jsonb_array_elements(u.kids) k
  where jsonb_typeof(u.kids)='array' and k->>'id' in (select id from kids) on conflict do nothing;
update users set kids='[]'::jsonb where kids <> '[]'::jsonb;
update kids set match_key = regexp_replace(translate(lower(trim(last)),'ё','е'),'\\s+',' ','g') || '|' || regexp_replace(translate(lower(trim(first)),'ё','е'),'\\s+',' ','g') || '|' || dob where match_key is null;
create table if not exists scores (id bigserial primary key, reg_id text not null references registrations(id) on delete cascade, workout_id text not null, value jsonb not null, video text,
  state text not null default 'pending', created_at timestamptz not null default now(), reviewed_by text, unique(reg_id, workout_id));
create table if not exists backups (id bigserial primary key, created_at timestamptz not null default now(), kind text not null, size int not null, rows int not null, data bytea not null);
create table if not exists consents (id bigserial primary key, created_at timestamptz not null default now(), subject text not null, kind text not null, version text not null, ip text, ua text, ref text);
`;
const ACTIVE = `('new','paid','refund_requested')`;
const INTEAM = `('new','paid','refund_requested','pending','reserve')`;

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

/* gyms: free text, suggestions = the most common spellings among athletes; typed variants are folded into them */
const BASE_GYMS = ['RECORD', 'CF BAZA'];
const GYM_ALIASES = { recordпивовариха: 'RECORD', рекорд: 'RECORD', рекордпивовариха: 'RECORD', центрспортарекорд: 'RECORD' };
const gymKey = g => String(g || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
let GYMS = BASE_GYMS.slice();
async function loadGyms() {
  const rows = (await db.query(`select trim(profile->>'affiliate') a from users where coalesce(trim(profile->>'affiliate'),'') <> ''
    union all select trim(person->>'affiliate') from registrations where who <> 'me' and coalesce(trim(person->>'affiliate'),'') <> ''`)).rows;
  const groups = new Map();
  for (const { a } of rows) {
    const k = gymKey(a); if (!k || k === 'другойзал') continue;
    const g = groups.get(k) || { n: 0, spell: new Map() }; g.n++; g.spell.set(a, (g.spell.get(a) || 0) + 1); groups.set(k, g);
  }
  const base = new Map(BASE_GYMS.map(b => [gymKey(b), b]));
  const list = [...groups.entries()].filter(([k, g]) => g.n >= 2 && !base.has(k)).sort((x, y) => y[1].n - x[1].n).slice(0, 12)
    .map(([, g]) => [...g.spell.entries()].sort((x, y) => y[1] - x[1])[0][0]);
  GYMS = [...BASE_GYMS, ...list];
  return GYMS;
}
const canonGym = a => { const k = gymKey(a); if (!k) return ''; if (GYM_ALIASES[k]) return GYM_ALIASES[k]; return GYMS.find(g => gymKey(g) === k) || a; };
function evDaysSrv(ev) {
  if (ev.format === 'online' || !ev.date || !ev.dateEnd || ev.dateEnd <= ev.date) return [ev.date].filter(Boolean);
  const out = []; for (let d = new Date(ev.date + 'T00:00:00Z'); out.length < 14; d.setUTCDate(d.getUTCDate() + 1)) { const s = d.toISOString().slice(0, 10); if (s > ev.dateEnd) break; out.push(s); }
  return out;
}
/* team composition by sex: div.g M/F = everyone that sex; div.mix = {m, f} = exact numbers in the main roster */
const sexOf = r => (r.person && r.person.gender) === 'F' ? 'f' : 'm';
function mixRoom(div, mainRows, sex, minus) {
  if (!div.mix) return true;
  const n = mainRows.filter(r => r.id !== minus && sexOf(r) === sex).length;
  return n < (+div.mix[sex] || 0);
}
const SEXW = { m: 'мужчин', f: 'женщин' };
function divDaySet(ev, d) { const days = evDaysSrv(ev); const own = ((d && d.days) || []).filter(x => days.includes(x)); return own.length ? own : days; }
let lastDraftResults = {};
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
  const ALLRES = await liveResults(EVENTS);
  const drafts = new Set(EVENTS.filter(e => e.status === 'draft').map(e => e.id));
  const RESULTS = Object.fromEntries(Object.entries(ALLRES).filter(([k]) => !drafts.has(k.split(/[:@]/)[0])));
  lastDraftResults = Object.fromEntries(Object.entries(ALLRES).filter(([k]) => drafts.has(k.split(/[:@]/)[0])));
  await loadGyms();
  const json = JSON.stringify({ EVENTS, SITE: c.SITE || {}, TEAMS, RESULTS, GYMS, today: today() });
  cache = { json, gz: zlib.gzipSync(json), etag: '"' + sha(json).slice(0, 20) + '"' };
  return cache;
}

const divWorkoutsSrv = (ev, divId) => (ev.workouts || []).filter(w => !w.divs || !w.divs.length || w.divs.includes(divId));
async function liveResults(EVENTS) {
  const { rows } = await db.query(`select s.workout_id, s.value, r.id reg, r.pub, r.event_id, r.div_id, r.team, r.person, r.publish
    from scores s join registrations r on r.id=s.reg_id where s.state='accepted' and r.status in ${ACTIVE} order by s.created_at`);
  const members = (await db.query(`select pub, event_id, div_id, team, person, publish from registrations where team is not null and status in ${ACTIVE} order by created_at`)).rows;
  const RES = {};
  for (const s of rows) {
    const ev = EVENTS.find(e => e.id === s.event_id); if (!ev) continue;
    const div = (ev.divisions || []).find(d => d.id === s.div_id); const w = (ev.workouts || []).find(x => x.id === s.workout_id);
    if (!div || !w) continue;
    const dw = divWorkoutsSrv(ev, div.id), wl = ev.permanent ? dw.filter(x => x.month === w.month) : dw;
    const idx = wl.findIndex(x => x.id === w.id); if (idx < 0) continue;
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
  u.kids = await kidsOf(u.id);
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
const nm = (v, max) => str(v, max).replace(/[<>"`\\]/g, '');
function cleanPerson(p, kid) {
  p = p || {};
  const o = {
    first: nm(p.first, 60), last: nm(p.last, 60), gender: GENDERS.includes(p.gender) ? p.gender : 'M',
    dob: /^\d{4}-\d{2}-\d{2}$/.test(p.dob || '') ? p.dob : '', affiliate: canonGym(nm(p.affiliate, 80)),
  };
  o.print = (nm(p.print, 60) || `${o.first} ${o.last}`).toUpperCase();
  if (!kid) Object.assign(o, { phone: str(p.phone, 30), tg: str(p.tg, 40), emName: nm(p.emName, 80), emPhone: str(p.emPhone, 30) });
  else o.id = /^kid[a-z0-9]{1,16}$/.test(p.id || '') ? p.id : 'kid' + rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
  return o;
}
/* ---------- children: one card per child, shared by up to 3 adults ---------- */
const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').trim().replace(/\s+/g, ' ');
const kidKey = k => `${normName(k.last)}|${normName(k.first)}|${k.dob || ''}`;
const KID_GUARDIANS_MAX = 3;
async function kidsOf(uid, q = (...a) => db.query(...a)) {
  return (await q(`select k.*, (select count(*)::int from kid_guardians g2 where g2.kid_id=k.id) n from kids k join kid_guardians g on g.kid_id=k.id
    where g.user_id=$1 and k.owner_user is null order by g.created_at, k.created_at`, [uid])).rows
    .map(k => ({ id: k.id, first: k.first, last: k.last, gender: k.gender, dob: k.dob, affiliate: k.affiliate, print: k.print || `${k.first} ${k.last}`.toUpperCase(), shared: k.n - 1 }));
}
async function mergeKids(q, keep, drop) {
  if (keep === drop) return;
  await q('insert into kid_guardians (kid_id, user_id, created_at) select $1, user_id, created_at from kid_guardians where kid_id=$2 on conflict do nothing', [keep, drop]);
  await q('update registrations set who=$1 where who=$2', [keep, drop]);
  await q('delete from kids where id=$1', [drop]);
}
const kidDupMsg = k => `${k.first} ${k.last} (${k.dob.split('-').reverse().join('.')}) уже есть на сайте — ребёнка добавил другой взрослый. Попросите его прислать вам приглашение: Профиль → ребёнок → «Пригласить второго взрослого». Тогда ребёнок появится и у вас, без дубля.`;
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
  const orders = await myOrders(u.id);
  const scores = (await db.query('select reg_id, workout_id, value, video, state from scores where reg_id in (select jsonb_array_elements_text($1::jsonb))', [JSON.stringify(orders.map(o => o.id))])).rows;
  return {
    user: { email: u.email, role: u.role, profile: u.profile, kids: u.kids, avatar: u.avatar || '' },
    orders: orders.map(o => ['blocked', 'cancelled'].includes(o.status) ? o : { ...o, note: '' }), scores,
    teams: await myTeams(u.id),
    crew: (await db.query('select id, event_id, role, status, avail from crew where user_id=$1 order by created_at', [u.id])).rows
      .map(c => ({ id: Number(c.id), event: c.event_id, role: c.role, status: c.status, avail: c.avail || [] })),
  };
});
const myOrders = async uid => (await db.query(`select * from registrations where user_id=$1 or athlete_user=$1 or (who <> 'me' and who in (select kid_id from kid_guardians where user_id=$1)) order by created_at`, [uid])).rows
  .map(r => ({ ...orderOut(r), mine: Number(r.user_id) === Number(uid) }));
const orderOut = r => ({ waiver: r.waiver || '', role: r.team_role || null, note: r.note || '', id: r.id, pub: r.pub, event: r.event_id, div: r.div_id, who: r.who, person: r.person, team: r.team, size: r.size, promo: r.promo,
  price: r.price, due: r.due, paid: r.paid, status: r.status, date: new Date(r.created_at.getTime() + 8 * 3600e3).toISOString().slice(0, 10), publish: r.publish });

route('POST', '/api/auth/code', async (req, res, u, body) => {
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw bad('Проверьте email');
  if (!body.consent) throw bad('Нужно согласие на обработку персональных данных');
  ipLimit(req, 'code-ip', 60, 1500);
  limit('code-mail:' + email, 1, 55e3);
  limit('code-mail-h:' + email, 6, 3600e3);
  limit('code-mail-d:' + email, 20, 86400e3);
  const code = String(crypto.randomInt(100000, 1000000));
  await db.query(`insert into login_codes(email, code_hash, expires_at, attempts, sent_at) values ($1,$2, now()+interval '10 minutes', 0, now())
    on conflict (email) do update set code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=now()`, [email, sha(email + ':' + code)]);
  if (mail.configured()) {
    try {
      await mail.send({ to: email, subject: 'Вход на сайт центра спорта «Рекорд»',
        text: `Здравствуйте!\n\nВаш код для входа на сайт центра спорта «Рекорд»: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто не отвечайте на это письмо.\n\nЦентр спорта «Рекорд», Иркутск` });
    } catch (e) {
      console.error('mail error:', e.message, '|', mail.describe());
      unlimit('code-mail:' + email, 'code-mail-h:' + email, 'code-mail-d:' + email);
      throw new HttpError(502, /554|spam/i.test(e.message) ? 'Почтовый сервис не пропустил письмо с кодом. Мы уже знаем и чиним — попробуйте позже или напишите нам' : 'Не получилось отправить письмо. Попробуйте ещё раз через минуту');
    }
  } else if (DEV_LOG_CODES) {
    console.log(`[dev] login code for ${email.replace(/^(.).*(@.*)$/, '$1***$2')}: ${code}`);
  } else {
    throw new HttpError(503, 'Вход временно недоступен: почта сайта ещё не настроена');
  }
  return { ok: true };
});

route('POST', '/api/auth/verify', async (req, res, u, body) => {
  const email = str(body.email, 254).toLowerCase(), code = digits(body.code).slice(0, 6);
  ipLimit(req, 'verify-ip', 300, 6000);
  limit('verify-mail:' + email, 20, 3600e3);
  limit('verify-mail-d:' + email, 60, 86400e3);
  // count the attempt first, atomically: parallel guesses cannot slip past the 5-attempt limit
  const { rows } = await db.query('update login_codes set attempts=attempts+1 where email=$1 and expires_at>now() and attempts<5 returning *', [email]);
  const lc = rows[0];
  if (!lc) {
    const any = (await db.query('select attempts from login_codes where email=$1 and expires_at>now()', [email])).rows[0];
    throw bad(any ? 'Слишком много неверных попыток. Запросите новый код' : 'Код устарел. Запросите новый');
  }
  if (!crypto.timingSafeEqual(Buffer.from(lc.code_hash), Buffer.from(sha(email + ':' + code)))) throw bad('Неверный код');
  if ((await db.query('delete from login_codes where email=$1 and code_hash=$2 returning 1', [email, lc.code_hash])).rows.length === 0) throw bad('Код уже использован. Запросите новый');
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
  const inc = (Array.isArray(body.kids) ? body.kids : []).slice(0, 8).map(k => ({ ...cleanPerson(k, true), id: String((k || {}).id || '') })).filter(k => k.first && k.last);
  const keys = inc.map(kidKey);
  if (new Set(keys).size !== keys.length) throw bad('Один и тот же ребёнок указан дважды');
  await db.tx(async q => {
    await q('select pg_advisory_xact_lock(hashtext($1))', ['kids']);
    const cur = await kidsOf(u.id, q), curIds = new Set(cur.map(k => k.id)), keep = new Set();
    for (const k of inc) {
      const key = kidKey(k);
      let own = curIds.has(k.id) && !keep.has(k.id);
      const clash = (await q('select id from kids where match_key=$1 and owner_user is null and id <> $2', [key, own ? k.id : ''])).rows[0];
      if (clash && !curIds.has(clash.id)) throw bad(kidDupMsg(k));
      if (clash && !own) { k.id = clash.id; own = !keep.has(k.id); if (!own) throw bad('Один и тот же ребёнок указан дважды'); }
      if (own) {
        await q('update kids set first=$2, last=$3, gender=$4, dob=$5, affiliate=$6, print=$7, match_key=$8 where id=$1', [k.id, k.first, k.last, k.gender, k.dob, k.affiliate, k.print, key]);
        keep.add(k.id);
      } else {
        const id = 'kid' + rnd(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
        await q('insert into kids (id, first, last, gender, dob, affiliate, print, match_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, k.first, k.last, k.gender, k.dob, k.affiliate, k.print, key, u.id]);
        await q('insert into kid_guardians (kid_id, user_id) values ($1,$2)', [id, u.id]);
      }
    }
    for (const k of cur) if (!keep.has(k.id)) {
      await q('delete from kid_guardians where kid_id=$1 and user_id=$2', [k.id, u.id]);
      await q(`delete from kids where id=$1 and not exists (select 1 from kid_guardians where kid_id=$1) and not exists (select 1 from registrations where who=$1)`, [k.id]);
    }
    await q('update users set profile=$1 where id=$2', [profile, u.id]);
  });
  return { profile, kids: await kidsOf(u.id) };
});

route('PUT', '/api/profile/avatar', async (req, res, u, body) => {
  need(u);
  limit('avatar:' + u.id, 30, 3600e3);
  let data = body.data == null || body.data === '' ? null : String(body.data);
  if (data && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 250 * 1024)) throw bad('Нужна картинка JPG до 200 КБ');
  await db.query('update users set avatar=$1 where id=$2', [data, u.id]);
  return { avatar: data || '' };
});

/* invite a second adult to a child's card, or hand the card over to the grown-up athlete */
async function myKid(u, id) {
  const k = (await db.query('select k.* from kids k join kid_guardians g on g.kid_id=k.id where g.user_id=$1 and k.id=$2 and k.owner_user is null', [u.id, str(id, 30)])).rows[0];
  if (!k) throw bad('Ребёнок не найден в вашем профиле');
  return k;
}
route('POST', '/api/kids/invite', async (req, res, u, body) => {
  need(u); limit('kid-invite:' + u.id, 20, 3600e3);
  const k = await myKid(u, body.kid);
  const n = (await db.query('select count(*)::int n from kid_guardians where kid_id=$1', [k.id])).rows[0].n;
  if (n >= KID_GUARDIANS_MAX) throw bad(`У ребёнка уже ${n} взрослых с доступом — больше добавить нельзя`);
  const token = rnd(24, 'abcdefghijkmnpqrstuvwxyz23456789');
  await db.query(`delete from kid_invites where expires_at < now()`);
  await db.query(`insert into kid_invites (token_hash, kid_id, from_user, kind, expires_at) values ($1,$2,$3,'guardian', now() + interval '7 days')`, [sha(token), k.id, u.id]);
  return { link: `${SITE_URL()}/#kid=${token}`, days: 7 };
});
route('POST', '/api/kids/transfer', async (req, res, u, body) => {
  need(u); limit('kid-transfer:' + u.id, 10, 3600e3);
  const k = await myKid(u, body.kid);
  if (!k.dob || ageOn(k.dob, today()) < 14) throw bad('Передать профиль можно, когда ребёнку исполнится 14 лет');
  const email = str(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Укажите email, на который ребёнок будет входить на сайт');
  if (email === u.email) throw bad('Нужен собственный email ребёнка, а не ваш');
  const token = rnd(24, 'abcdefghijkmnpqrstuvwxyz23456789');
  await db.query(`delete from kid_invites where kid_id=$1 and kind='transfer'`, [k.id]);
  await db.query(`insert into kid_invites (token_hash, kid_id, from_user, kind, email, expires_at) values ($1,$2,$3,'transfer',$4, now() + interval '14 days')`, [sha(token), k.id, u.id, email]);
  const link = `${SITE_URL()}/#kid=${token}`;
  let mailed = false;
  if (mail.configured()) {
    try {
      await mail.send({ to: email, subject: 'Рекорд: ваш профиль спортсмена', text: [`Здравствуйте, ${k.first}!`, '',
        'Взрослый, который вёл ваш профиль на сайте центра спорта «Рекорд», передаёт его вам — вместе со всей историей стартов и результатов.',
        `Чтобы принять, откройте ссылку и войдите на сайт с этим email (${email}):`, link, '', 'Ссылка действует 14 дней. Если вы не ждали это письмо — просто удалите его.'].join('\n') });
      mailed = true;
    } catch (e) { console.error('mail error:', e.message); }
  }
  return { link, mailed, days: 14 };
});
async function kidInvite(token) {
  const i = (await db.query('select i.*, k.first, k.last, k.dob, k.owner_user, u.profile from kid_invites i join kids k on k.id=i.kid_id left join users u on u.id=i.from_user where i.token_hash=$1 and i.expires_at > now()', [sha(str(token, 60))])).rows[0];
  if (!i || i.owner_user) throw bad('Приглашение устарело или уже использовано — попросите прислать новое');
  return i;
}
route('POST', '/api/kids/invite/info', async (req, res, u, body) => {
  need(u); limit('kid-accept:' + u.id, 30, 3600e3);
  const i = await kidInvite(body.token), p = i.profile || {};
  return { kind: i.kind, kid: `${i.first} ${i.last}`, from: `${p.first || ''} ${(p.last || '').slice(0, 1)}${p.last ? '.' : ''}`.trim(), email: i.kind === 'transfer' ? i.email : '',
    already: i.kind === 'guardian' && !!(await db.query('select 1 from kid_guardians where kid_id=$1 and user_id=$2', [i.kid_id, u.id])).rows[0] };
});
route('POST', '/api/kids/accept', async (req, res, u, body) => {
  need(u); limit('kid-accept:' + u.id, 30, 3600e3);
  const i = await kidInvite(body.token);
  let msg = '';
  await db.tx(async q => {
    await q('select pg_advisory_xact_lock(hashtext($1))', ['kids']);
    if (i.kind === 'guardian') {
      const has = (await q('select 1 from kid_guardians where kid_id=$1 and user_id=$2', [i.kid_id, u.id])).rows[0];
      if (!has) {
        const n = (await q('select count(*)::int n from kid_guardians where kid_id=$1', [i.kid_id])).rows[0].n;
        if (n >= KID_GUARDIANS_MAX) throw bad('У ребёнка уже максимум взрослых с доступом');
        await q('insert into kid_guardians (kid_id, user_id) values ($1,$2)', [i.kid_id, u.id]);
      }
      // the same child already added by this adult separately: merge it into the shared card
      const key = (await q('select match_key from kids where id=$1', [i.kid_id])).rows[0].match_key;
      for (const d of (await q('select k.id from kids k join kid_guardians g on g.kid_id=k.id where g.user_id=$1 and k.match_key=$2 and k.id<>$3', [u.id, key, i.kid_id])).rows) await mergeKids(q, i.kid_id, d.id);
      await q('delete from kid_invites where token_hash=$1', [i.token_hash]);
      msg = `${i.first} ${i.last} теперь в вашем профиле`;
    } else {
      if (u.email !== i.email) throw bad(`Это приглашение для ${i.email.replace(/^(.).*(@.*)$/, '$1***$2')}. Войдите на сайт с этим email`);
      await q('update kids set owner_user=$2 where id=$1', [i.kid_id, u.id]);
      await q('delete from kid_guardians where kid_id=$1', [i.kid_id]);
      await q('delete from kid_invites where kid_id=$1', [i.kid_id]);
      await q('update registrations set athlete_user=$2 where who=$1', [i.kid_id, u.id]);
      const prof = u.profile || {};
      if (!prof.first && !prof.last) {
        const k = (await q('select * from kids where id=$1', [i.kid_id])).rows[0];
        await q('update users set profile = profile || $2::jsonb where id=$1', [u.id, JSON.stringify({ first: k.first, last: k.last, gender: k.gender, dob: k.dob, affiliate: k.affiliate, print: k.print || `${k.first} ${k.last}`.toUpperCase() })]);
      }
      msg = 'Профиль и история выступлений теперь ваши';
    }
  });
  return { ok: true, msg };
});
/* organizers: the same child added by different adults */
route('POST', '/api/admin/kids/merge', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const keep = str(body.keep, 30), drop = str(body.drop, 30);
  await db.tx(async q => {
    const r = (await q('select id, match_key from kids where id in ($1,$2) and owner_user is null', [keep, drop])).rows;
    if (r.length !== 2 || keep === drop) throw bad('Карточки не найдены');
    await mergeKids(q, keep, drop);
  });
  dirty();
  return { dupes: await kidDupes() };
});
async function kidDupes() {
  return (await db.query(`select k.id, k.first, k.last, k.dob, k.match_key, k.created_at,
      (select coalesce(json_agg(u.email order by g.created_at), '[]') from kid_guardians g join users u on u.id=g.user_id where g.kid_id=k.id) adults,
      (select count(*)::int from registrations r where r.who=k.id) regs
    from kids k where k.owner_user is null and k.match_key in (select match_key from kids where owner_user is null group by 1 having count(*) > 1) order by k.match_key, k.created_at`)).rows
    .map(k => ({ id: k.id, name: `${k.last} ${k.first}`, dob: k.dob, key: k.match_key, adults: k.adults, regs: k.regs }));
}
route('POST', '/api/account/delete', async (req, res, u) => {
  need(u);
  await db.tx(async q => {
    await q(`update registrations set person = jsonb_build_object('first','Удалённый','last','участник','affiliate', person->>'affiliate'), publish=false, user_id=null where user_id=$1`, [u.id]);
    const solo = (await q('select kid_id from kid_guardians g where user_id=$1 and (select count(*) from kid_guardians x where x.kid_id=g.kid_id)=1', [u.id])).rows.map(r => r.kid_id);
    await q('delete from users where id=$1', [u.id]);
    if (solo.length) await q(`delete from kids where id in (select jsonb_array_elements_text($1::jsonb))`, [JSON.stringify(solo)]);
  });
  dirty();
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  return undefined;
});

route('POST', '/api/lead', async (req, res, u, body) => {
  ipLimit(req, 'lead-ip', 20, 300);
  limit('lead-phone:' + digits(str(body.phone, 30)), 3, 3600e3);
  const name = nm(body.name, 80), phone = str(body.phone, 30);
  if (!name) throw bad('Как к вам обращаться?');
  if (digits(phone).length < 10) throw bad('Нужен телефон, чтобы мы перезвонили');
  if (!body.consent) throw bad('Нужно согласие, иначе мы не сможем вам позвонить');
  const { rows } = await db.query('insert into leads(name, phone, dir, who, age, pref_time) values ($1,$2,$3,$4,$5,$6) returning id',
    [name, phone, str(body.dir, 80), str(body.who, 40), str(body.age, 20), str(body.time, 40)]);
  await logConsent(req, 'lead:' + rows[0].id, 'pd', 'trial');
  notify(`🏋️ <b>Заявка на пробную</b>\n${tg.esc(str(body.dir, 80))} · ${tg.esc(str(body.who, 40))}\nИмя и телефон — в панели: ${SITE_URL()}/#admin`,
    { title: 'заявка на пробную тренировку', lines: [`Имя: ${name}`, `Телефон: ${phone}`, `Направление: ${str(body.dir, 80)}`, `Кто: ${str(body.who, 40)}${body.age ? `, возраст ${str(body.age, 20)}` : ''}`, `Удобное время: ${str(body.time, 40)}`] });
  return { ok: true };
});

route('POST', '/api/promo', async (req, res, u, body) => {
  ipLimit(req, 'promo-ip', 30, 3000);
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
  if ((div.g === 'M' || div.g === 'F') && (person.gender || 'M') !== div.g) throw bad(div.g === 'M' ? 'Категория только для мужчин' : 'Категория только для женщин');
  if (div.mix && !(+div.mix[(person.gender === 'F') ? 'f' : 'm'] > 0)) throw bad(person.gender === 'F' ? 'В этой категории в составе нет мест для женщин' : 'В этой категории в составе нет мест для мужчин');
  if (div.min && age < div.min) throw bad(`Категория с ${div.min} лет`);
  if (div.max && age > div.max) throw bad(`Категория до ${div.max} лет`);
  const cons = body.consents || {};
  if (!cons.rules) throw bad('Нужно принять условия участия');
  if (!cons.pd) throw bad('Нужно согласие на обработку персональных данных');
  if (age < 18 && !cons.parent) throw bad('Нужно согласие законного представителя');
  const size = ['XS', 'S', 'M', 'L', 'XL', 'XXL'].includes(body.size) ? body.size : null;
  const snap = { ...cleanPerson(person, who !== 'me'), phone: u.profile.phone, emName: u.profile.emName || '', emPhone: u.profile.emPhone || '', affiliate: canonGym(nm(body.affiliate, 80)) || person.affiliate || '' };
  if (who !== 'me') snap.parent = `${u.profile.first || ''} ${u.profile.last || ''}`.trim();
  let out_captain = null;
  const out = await db.tx(async q => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`${ev.id}:${div.id}`]);
    // one registration per day: a second category is allowed only on other days of the start
    const dup = (await q(`select div_id from registrations where who=$2 and (who <> 'me' or user_id=$1) and event_id=$3 and status in ${INTEAM}`, [u.id, who, ev.id])).rows;
    for (const x of dup) {
      if (x.div_id === div.id) throw bad('Этот участник уже записан в эту категорию');
      const od = (ev.divisions || []).find(d => d.id === x.div_id), a = divDaySet(ev, od || {}), b2 = divDaySet(ev, div);
      if (!od || a.some(d => b2.includes(d))) throw bad(`Этот участник уже записан на «${od ? od.name : 'другую категорию'}» в этот день. В один день — одна категория`);
    }
    let team = null, role = null, initial = null, teamRow = null;
    if (div.type === 'team') {
      const t = body.team || {}, size = +div.size || 1;
      if (t.mode === 'create') {
        const name = nm(t.name, 20).toUpperCase();
        if (!name) throw bad('Укажите название команды');
        const ex = (await q('select * from teams where event_id=$1 and div_id=$2 and name=$3', [ev.id, div.id, name])).rows[0];
        const live = ex ? (await q(`select count(*)::int n from registrations where event_id=$1 and div_id=$2 and team=$3 and status in ${INTEAM}`, [ev.id, div.id, name])).rows[0].n : 0;
        if (ex && live > 0) throw bad('Команда с таким названием уже есть');
        const nTeams = (await q(`select count(distinct team)::int n from registrations where event_id=$1 and div_id=$2 and status in ${ACTIVE}`, [ev.id, div.id])).rows[0].n;
        if (div.limit && nTeams >= div.limit) throw bad('Лимит команд в категории набран');
        const invite = rnd(16);
        if (ex) await q('update teams set code_hash=$1, invite=$2, captain_reg=null where id=$3', ['', invite, ex.id]);
        else await q(`insert into teams(event_id, div_id, name, code_hash, invite) values ($1,$2,$3,'',$4)`, [ev.id, div.id, name, invite]);
        teamRow = (await q('select * from teams where event_id=$1 and div_id=$2 and name=$3', [ev.id, div.id, name])).rows[0];
        team = name; role = 'main';
      } else {
        limit('team-join:' + u.id, 20, 3600e3);
        teamRow = t.mode === 'invite'
          ? (await q('select * from teams where invite=$1 and event_id=$2 and div_id=$3', [str(t.invite, 40), ev.id, div.id])).rows[0]
          : (await q('select * from teams where event_id=$1 and div_id=$2 and name=$3', [ev.id, div.id, nm(t.name, 20).toUpperCase()])).rows[0];
        if (!teamRow) throw bad(t.mode === 'invite' ? 'Приглашение устарело — попросите у капитана новую ссылку' : 'Такой команды нет');
        const main = (await q(`select count(*)::int n from registrations where event_id=$1 and div_id=$2 and team=$3 and status in ${ACTIVE}`, [ev.id, div.id, teamRow.name])).rows[0].n;
        if (!main) throw bad('Такой команды нет');
        team = teamRow.name;
        const mainRows = (await teamRoster(q, ev.id, div.id, teamRow.name)).filter(r => ['new', 'paid', 'refund_requested'].includes(r.status));
        const sx = person.gender === 'F' ? 'f' : 'm';
        if (t.mode === 'invite') { if (main < size && mixRoom(div, mainRows, sx)) role = 'main'; else { role = 'reserve'; initial = 'reserve'; } }
        else initial = 'pending';
      }
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
    await q(`insert into registrations(id, pub, user_id, event_id, div_id, who, person, team, team_role, size, promo, price, due, paid, status, publish, photo)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16)`,
      [id, pub, u.id, ev.id, div.id, who, snap, team, role, size, promo, price, due, initial || (due === 0 ? 'paid' : 'new'), !!cons.publish, !!cons.photo]);
    if (teamRow && role === 'main' && body.team && body.team.mode === 'create') await q('update teams set captain_reg=$1 where id=$2', [id, teamRow.id]);
    if (initial === 'pending') out_captain = teamRow.captain_reg;
    return (await q('select * from registrations where id=$1', [id])).rows[0];
  });
  const subj = 'user:' + u.id;
  await logConsent(req, subj, 'rules', out.id);
  await logConsent(req, subj, 'pd', out.id);
  if (age < 18) await logConsent(req, subj, 'parent', out.id);
  if (cons.publish) await logConsent(req, subj, 'publish', out.id);
  if (cons.photo) await logConsent(req, subj, 'photo', out.id);
  dirty();
  notify(`🏁 <b>Новая заявка на старт</b>\n${tg.esc(ev.name)} · ${tg.esc(div.name)}\n${out.due ? `К оплате: ${rub(out.due)}` : 'Бесплатно'} · ${out.id}\n${SITE_URL()}/#admin`,
    { title: 'новая заявка на старт', lines: [`Старт: ${ev.name}`, `Категория: ${div.name}`, `Участник: ${`${snap.last || ''} ${snap.first || ''}`.trim()}${snap.parent ? ` (родитель: ${snap.parent})` : ''}`, ...(out.team ? [`Команда: ${out.team}`] : []), `Телефон: ${snap.phone || ''}`, `Заказ: ${out.id}`, out.due ? `К оплате: ${rub(out.due)} — ждёт отметки об оплате` : 'Взнос: бесплатно'] });
  if (out_captain) mailCaptain(out_captain, `Заявка в команду «${out.team}»`, [`${`${snap.first || ''} ${snap.last || ''}`.trim()} хочет в вашу команду «${out.team}» (${ev.name} · ${div.name}).`, '', `Принять или отклонить: ${SITE_URL()}/#orders → карточка старта → «Команда».`]);
  return { order: orderOut(out) };
});

/* ---------- teams: captain, roster, requests, reserves ---------- */
const shortName = p => `${(p && p.first) || ''} ${((p && p.last) || '').slice(0, 1)}${p && p.last ? '.' : ''}`.trim();
async function teamRoster(q, ev, div, name) {
  return (await q(`select r.id, r.user_id, r.person, r.status, r.team_role, r.due, r.paid, r.created_at from registrations r
    where r.event_id=$1 and r.div_id=$2 and r.team=$3 and r.status in ${INTEAM} order by r.created_at`, [ev, div, name])).rows;
}
async function myTeams(uid) {
  const mine = (await db.query(`select distinct r.event_id, r.div_id, r.team from registrations r where r.user_id=$1 and r.team is not null and r.status in ${INTEAM}`, [uid])).rows;
  const out = [];
  for (const m of mine) {
    const t = (await db.query('select * from teams where event_id=$1 and div_id=$2 and name=$3', [m.event_id, m.div_id, m.team])).rows[0]; if (!t) continue;
    const roster = await teamRoster(db.query.bind(db), m.event_id, m.div_id, m.team);
    const cap = roster.find(r => r.id === t.captain_reg), isCap = !!cap && Number(cap.user_id) === Number(uid);
    out.push({ event: m.event_id, div: m.div_id, name: m.team, captain: isCap, captainReg: t.captain_reg, invite: isCap ? t.invite : null,
      members: roster.filter(r => isCap || r.status !== 'pending' || Number(r.user_id) === Number(uid)).map(r => ({
        reg: r.id, name: isCap || Number(r.user_id) === Number(uid) ? `${r.person.last || ''} ${r.person.first || ''}`.trim() : shortName(r.person),
        role: r.status === 'pending' ? 'pending' : r.status === 'reserve' ? 'reserve' : 'main', paid: r.status === 'paid', g: sexOf(r), cap: r.id === t.captain_reg, me: Number(r.user_id) === Number(uid) })) });
  }
  return out;
}
async function mailCaptain(capReg, subject, lines) {
  try {
    if (!mail.configured() || !capReg) return;
    const r = (await db.query('select u.email from registrations r join users u on u.id=r.user_id where r.id=$1', [capReg])).rows[0];
    if (r && r.email) await mail.send({ to: r.email, subject: 'Рекорд: ' + subject, text: lines.join('\n') });
  } catch (e) { console.error('captain mail failed:', e.message); }
}
async function mailMember(regId, subject, lines) { return mailCaptain(regId, subject, lines); }
// teams of a category for the search screen: short names only, signed-in athletes only
route('GET', '/api/teams', async (req, res, u, body, p, qs) => {
  need(u);
  const url = new URL(req.url, 'http://x'), ev = str(url.searchParams.get('event'), 60), div = str(url.searchParams.get('div'), 60);
  const teams = (await db.query('select * from teams where event_id=$1 and div_id=$2 order by created_at', [ev, div])).rows;
  const out = [];
  for (const t of teams) {
    const roster = await teamRoster(db.query.bind(db), ev, div, t.name);
    const main = roster.filter(r => ['new', 'paid', 'refund_requested'].includes(r.status));
    if (!main.length) continue;
    out.push({ name: t.name, main: main.map(r => ({ n: shortName(r.person), cap: r.id === t.captain_reg, g: sexOf(r) })), reserve: roster.filter(r => r.status === 'reserve').map(r => shortName(r.person)), pending: roster.filter(r => r.status === 'pending').length });
  }
  return { teams: out };
});
route('GET', '/api/invite/:token', async (req, res, u, body, p) => {
  const t = (await db.query('select * from teams where invite=$1', [str(decodeURIComponent(p.token), 40)])).rows[0];
  if (!t) throw bad('Приглашение устарело — попросите у капитана новую ссылку');
  const roster = await teamRoster(db.query.bind(db), t.event_id, t.div_id, t.name);
  const main = roster.filter(r => ['new', 'paid', 'refund_requested'].includes(r.status));
  if (!main.length) throw bad('Команда расформирована');
  return { event: t.event_id, div: t.div_id, name: t.name, main: main.map(r => shortName(r.person)), mainG: main.map(sexOf), reserve: roster.filter(r => r.status === 'reserve').length };
});
route('POST', '/api/team/act', async (req, res, u, body) => {
  need(u);
  limit('team-act:' + u.id, 120, 3600e3);
  const cap = (await db.query('select r.*, t.id tid, t.captain_reg from registrations r join teams t on t.event_id=r.event_id and t.div_id=r.div_id and t.name=r.team where r.id=$1 and r.user_id=$2', [str(body.reg, 40), u.id])).rows[0];
  if (!cap || cap.captain_reg !== cap.id) throw bad('Это может делать только капитан команды');
  const c = await rawContent(); const ev = (c.EVENTS || []).find(e => e.id === cap.event_id); const div = ev && ev.divisions.find(d => d.id === cap.div_id);
  if (!div) throw bad('Категория не найдена');
  const size = +div.size || 1, act = body.action;
  let mailTo = null, mailText = null;
  await db.tx(async q => {
    await q('select pg_advisory_xact_lock(hashtext($1))', [`${cap.event_id}:${cap.div_id}`]);
    const roster = await teamRoster(q, cap.event_id, cap.div_id, cap.team);
    const get = id => roster.find(r => r.id === id);
    const mainCount = () => roster.filter(r => ['new', 'paid', 'refund_requested'].includes(r.status)).length;
    const toMain = async (r, extraPaid) => {
      const paid = (r.paid || 0) + (extraPaid || 0); const st = paid >= r.due ? 'paid' : 'new';
      await q("update registrations set status=$1, team_role='main', paid=$2, updated_by=$3 where id=$4", [st, paid, u.email, r.id]); r.status = st;
    };
    const drop = async (r, fee, why) => {
      if (fee === 'transfer') await q("update registrations set status='cancelled', paid=0, team_role=null, note=$1, updated_by=$2 where id=$3", [why, u.email, r.id]);
      else await q("update registrations set status=$1, team_role=null, note=$2, updated_by=$3 where id=$4", [r.paid > 0 && r.status !== 'reserve' && r.status !== 'pending' ? 'refund_requested' : 'cancelled', why, u.email, r.id]);
      r.status = 'cancelled';
    };
    if (act === 'approve' || act === 'reserve') {
      const r = get(str(body.target, 40)); if (!r || r.status !== 'pending') throw bad('Заявка не найдена');
      if (act === 'approve') { if (mainCount() >= size) throw bad('Основной состав полный — возьмите в запас или сначала замените участника'); if (!mixRoom(div, roster.filter(x => ['new', 'paid', 'refund_requested'].includes(x.status)), sexOf(r))) throw bad(`В основном составе уже все места для ${SEXW[sexOf(r)]} — возьмите в запас`); await toMain(r, 0); }
      else await q("update registrations set status='reserve', team_role='reserve', updated_by=$1 where id=$2", [u.email, r.id]);
      mailTo = r.id; mailText = act === 'approve' ? `Капитан принял вас в основной состав команды «${cap.team}». Оплатите взнос — организатор подтвердит участие.` : `Капитан взял вас в запас команды «${cap.team}». Взнос платить не нужно, пока вы не выйдете в основной состав.`;
    } else if (act === 'reject') {
      const r = get(str(body.target, 40)); if (!r || r.status !== 'pending') throw bad('Заявка не найдена');
      await q("update registrations set status='cancelled', team_role=null, note='Капитан отклонил заявку в команду', updated_by=$1 where id=$2", [u.email, r.id]);
      mailTo = r.id; mailText = `Капитан команды «${cap.team}» отклонил заявку. Можно подать заявку в другую команду или создать свою.`;
    } else if (act === 'promote') {
      const r = get(str(body.target, 40)); if (!r || r.status !== 'reserve') throw bad('Запасной не найден');
      const out = body.replace ? get(str(body.replace, 40)) : null;
      const mainNow = roster.filter(x => ['new', 'paid', 'refund_requested'].includes(x.status));
      if (!mixRoom(div, mainNow, sexOf(r), out && out.id)) throw bad(`По составу категории в основном составе ${div.mix.m} муж. и ${div.mix.f} жен. — ${sexOf(r) === 'f' ? 'женщину' : 'мужчину'} можно поставить только вместо ${sexOf(r) === 'f' ? 'женщины' : 'мужчины'}`);
      if (body.replace) {
        if (!out || !['new', 'paid', 'refund_requested'].includes(out.status)) throw bad('Участник для замены не найден');
        if (out.id === cap.id) throw bad('Капитана заменить нельзя — напишите организатору');
        const fee = body.fee === 'transfer' ? 'transfer' : 'refund', amount = fee === 'transfer' ? (out.paid || 0) : 0;
        await drop(out, fee, fee === 'transfer' ? `Заменён в команде: взнос ${amount} ₽ передан ${shortName(r.person)}` : 'Заменён в команде');
        await toMain(r, amount);
      } else { if (mainCount() >= size) throw bad('Основной состав полный — выберите, кого заменить'); await toMain(r, 0); }
      mailTo = r.id; mailText = `Капитан перевёл вас в основной состав команды «${cap.team}».${r.status === 'paid' ? ' Взнос уже оплачен.' : ' Оплатите взнос — организатор подтвердит участие.'}`;
    } else if (act === 'remove') {
      const r = get(str(body.target, 40)); if (!r) throw bad('Участник не найден');
      if (r.id === cap.id) throw bad('Капитана убрать нельзя — напишите организатору');
      await drop(r, 'refund', 'Капитан убрал из команды');
      mailTo = r.id; mailText = `Капитан убрал вас из команды «${cap.team}».${r.paid > 0 ? ' Взнос вернётся по правилам старта — организатор свяжется с вами.' : ''}`;
    } else if (act === 'captain') {
      const r = get(str(body.target, 40)); if (!r || !['new', 'paid', 'refund_requested'].includes(r.status)) throw bad('Капитаном может стать только участник основного состава');
      if (r.id === cap.id) throw bad('Вы уже капитан');
      await q('update teams set captain_reg=$1 where id=$2', [r.id, cap.tid]);
      mailTo = r.id; mailText = `Вы стали капитаном команды «${cap.team}». Принимать заявки, менять состав и отправлять ссылку-приглашение теперь можно в «Моих стартах», в карточке старта.`;
    } else if (act === 'invite') {
      await q('update teams set invite=$1 where id=$2', [rnd(16), cap.tid]);
    } else throw bad('Неизвестное действие');
  });
  dirty();
  if (mailTo) mailMember(mailTo, `команда «${cap.team}»`, [mailText, '', `${ev.name} · ${div.name}`, `${SITE_URL()}/#orders`]);
  return { teams: await myTeams(u.id), orders: await myOrders(u.id) };
});

route('POST', '/api/refund', async (req, res, u, body) => {
  need(u);
  { const w = await db.query(`update registrations set status='cancelled', team_role=null, note='Сам отозвал заявку в команду' where id=$1 and user_id=$2 and status in ('pending','reserve') returning *`, [str(body.id, 40), u.id]);
    if (w.rows.length) { dirty(); return { order: orderOut(w.rows[0]) }; } }
  const r = await db.query(`update registrations set status='refund_requested' where id=$1 and user_id=$2 and status in ('new','paid') returning *`, [str(body.id, 40), u.id]);
  if (!r.rows.length) throw bad('Заказ не найден');
  await fixCaptain(r.rows[0].event_id, r.rows[0].div_id, r.rows[0].team);
  dirty();
  { const o = r.rows[0]; notify(`↩️ <b>Запрос на возврат</b>\n${tg.esc(await evName(o.event_id))} · ${tg.esc(await divName(o.event_id, o.div_id))}\nОплачено ${rub(o.paid)} · ${o.id}\n${SITE_URL()}/#admin`,
    { title: 'запрос на возврат взноса', lines: [`Старт: ${await evName(o.event_id)} · ${await divName(o.event_id, o.div_id)}`, `Участник: ${`${o.person.last || ''} ${o.person.first || ''}`.trim()}`, `Телефон: ${o.person.phone || ''}`, `Заказ: ${o.id}`, `Оплачено: ${rub(o.paid)}`] }); }
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
    if (typeof v === 'number' && isFinite(v) && v > 0 && v < 86400) return Math.round(v * 100) / 100;
    if (v && typeof v === 'object' && Number.isInteger(v.cap) && v.cap >= 0 && v.cap < 100000) return { cap: v.cap };
  } else if (typeof v === 'number' && isFinite(v) && (v > 0 || (v === 0 && type === 'reps')) && v < 100000) return Math.round(v * 100) / 100;
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
  if (w.divs && w.divs.length && !w.divs.includes(reg.div_id)) throw bad('У вашей категории нет такого задания');
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
  await publicContent();
  const DRAFT_RESULTS = lastDraftResults;
  if (u.role === 'judge') {
    const rr = (await db.query(`select id, pub, event_id, div_id, person, team, status, team_role from registrations where status in ${ACTIVE} order by created_at`)).rows;
    return { role: u.role, PENDING: pending, DRAFT_RESULTS, SCORES: (await db.query('select id, reg_id, workout_id, value, state from scores')).rows.map(scoreOut),
      REGS: rr.map(r => ({ id: r.id, pub: r.pub, event: r.event_id, div: r.div_id, person: { first: r.person.first, last: r.person.last, gender: r.person.gender }, team: r.team, status: r.status, role: r.team_role })) };
  }
  const c = await rawContent();
  const used = await promoUsed();
  const staff = (await db.query('select email, name, role from staff order by created_at')).rows;
  const leads = (await db.query('select * from leads order by created_at desc')).rows;
  const regs = (await db.query('select r.*, u.email, (t.id is not null) is_cap from registrations r left join users u on u.id=r.user_id left join teams t on t.captain_reg=r.id order by r.created_at')).rows;
  return {
    role: u.role,
    PROMOS: (c.PROMOS || []).map(p => ({ ...p, used: used[p.code] || 0 })),
    ACCESS: [{ email: u.role === 'owner' ? u.email : '', name: 'Владелец', role: 'owner' }, ...staff],
    CLUB_LEADS: leads.map(l => ({ id: l.id, date: new Date(l.created_at.getTime() + 8 * 3600e3).toISOString().slice(0, 10), name: l.name, phone: l.phone, dir: l.dir, who: l.who, age: l.age, time: l.pref_time, status: l.status })),
    REGS: regs.map(r => ({ ...orderOut(r), email: r.email || '', captain: !!r.is_cap })),
    DRAFT_RESULTS,
    PENDING: pending,
    SCORES: (await db.query('select id, reg_id, workout_id, value, state from scores')).rows.map(scoreOut),
    KID_DUPES: await kidDupes(),
    ...(u.role === 'owner' ? { PENALTIES: Object.fromEntries(regs.filter(r => r.penalty).map(r => [r.id, r.penalty])) } : {}),
    WAIVERS: [...new Set(['Рекорд Талант', ...(await db.query("select waiver, count(*) n from registrations where waiver is not null group by 1 order by n desc limit 20")).rows.map(r => r.waiver)])],
    CREW: (await db.query('select * from crew order by created_at')).rows.map(crewOut),
    CREW_CFG: Object.fromEntries((await db.query('select * from crew_rates')).rows.map(r => [r.event_id, { rates: r.rates, shift: Number(r.shift_hours) }])),
  };
});
const scoreOut = s => ({ id: s.id, reg: s.reg_id, workout: s.workout_id, value: s.value, state: s.state });

/* organizers: look up an athlete — profile, children / parents, history of starts */
const likeQ = q => '%' + String(q).toLowerCase().replace(/ё/g, 'е').replace(/[%_\\]/g, '') + '%';
const NORM_SQL = x => `translate(lower(coalesce(${x},'')),'ё','е')`;
route('POST', '/api/admin/athletes', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const q = str(body.q, 80).trim();
  if (q.length < 2) return { list: [] };
  const words = q.split(/\s+/).slice(0, 3).map(likeQ), digits = q.replace(/\D/g, '');
  const userHay = `${NORM_SQL("u.profile->>'last'")} || ' ' || ${NORM_SQL("u.profile->>'first'")} || ' ' || lower(u.email)`;
  const users = (await db.query(`select u.id, u.email, u.profile, u.created_at, (select count(*)::int from kid_guardians g where g.user_id=u.id) kids,
      (select count(*)::int from registrations r where r.user_id=u.id or r.athlete_user=u.id) regs from users u
    where (${words.map((_, i) => `${userHay} like $${i + 1}`).join(' and ')})${digits.length >= 5 ? ` or regexp_replace(coalesce(u.profile->>'phone',''),'\\D','','g') like $${words.length + 1}` : ''}
    order by u.profile->>'last', u.profile->>'first' limit 30`, digits.length >= 5 ? [...words, '%' + digits.slice(-10) + '%'] : words)).rows;
  const kidHay = `${NORM_SQL('k.last')} || ' ' || ${NORM_SQL('k.first')}`;
  const kids = (await db.query(`select k.id, k.first, k.last, k.dob, k.owner_user, (select count(*)::int from registrations r where r.who=k.id) regs,
      (select coalesce(json_agg(coalesce(nullif(trim(coalesce(x.profile->>'first','') || ' ' || coalesce(x.profile->>'last','')),''), x.email)), '[]') from kid_guardians g join users x on x.id=g.user_id where g.kid_id=k.id) parents
    from kids k where ${words.map((_, i) => `${kidHay} like $${i + 1}`).join(' and ')} order by k.last, k.first limit 30`, words)).rows;
  // people known only from registrations (no account any more, or imported results)
  const regHay = `${NORM_SQL("person->>'last'")} || ' ' || ${NORM_SQL("person->>'first'")}`;
  const guests = (await db.query(`select person->>'last' last, person->>'first' first, coalesce(person->>'dob','') dob, count(*)::int regs from registrations
    where user_id is null and athlete_user is null and who='me' and ${words.map((_, i) => `${regHay} like $${i + 1}`).join(' and ')} group by 1,2,3 order by 1,2 limit 20`, words)).rows;
  return { list: [
    ...users.map(x => ({ type: 'user', id: String(x.id), name: `${x.profile.last || ''} ${x.profile.first || ''}`.trim() || x.email, dob: x.profile.dob || '', email: x.email, kids: x.kids, regs: x.regs })),
    ...kids.map(k => ({ type: 'kid', id: k.id, name: `${k.last} ${k.first}`, dob: k.dob, parents: k.parents, regs: k.regs, moved: !!k.owner_user })),
    ...guests.map(g => ({ type: 'guest', id: JSON.stringify([g.last || '', g.first || '', g.dob]), name: `${g.last || ''} ${g.first || ''}`.trim(), dob: g.dob, regs: g.regs })),
  ] };
});
route('POST', '/api/admin/athlete', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const type = str(body.type, 10), id = str(body.id, 300);
  const userCard = x => ({ id: String(x.id), email: x.email, created: x.created_at, profile: x.profile || {}, avatar: x.avatar || '' });
  const regsOut = rows => rows.map(r => ({ ...orderOut(r), email: r.email || '', created: r.created_at, ...(u.role === 'owner' && r.penalty ? { penalty: r.penalty } : {}) }));
  const regSel = `select r.*, x.email from registrations r left join users x on x.id=r.user_id`;
  if (type === 'user') {
    const x = (await db.query('select * from users where id=$1', [Number(id) || 0])).rows[0];
    if (!x) throw bad('Аккаунт не найден');
    const kids = (await db.query(`select k.*, (select coalesce(json_agg(json_build_object('id', g2.user_id, 'email', y.email, 'name', trim(coalesce(y.profile->>'first','') || ' ' || coalesce(y.profile->>'last','')))), '[]')
        from kid_guardians g2 join users y on y.id=g2.user_id where g2.kid_id=k.id and g2.user_id<>$1) others
      from kids k join kid_guardians g on g.kid_id=k.id where g.user_id=$1 order by k.dob`, [x.id])).rows;
    const fromKid = (await db.query('select id, first, last, dob from kids where owner_user=$1', [x.id])).rows;
    const regs = (await db.query(`${regSel} where (r.who='me' and r.user_id=$1) or r.athlete_user=$1 order by r.created_at desc`, [x.id])).rows;
    const kidRegs = (await db.query(`${regSel} where r.user_id=$1 and r.who<>'me' order by r.created_at desc`, [x.id])).rows;
    const crew = (await db.query('select * from crew where user_id=$1 order by created_at desc', [x.id])).rows;
    return { type, user: userCard(x), kids: kids.map(k => ({ id: k.id, first: k.first, last: k.last, dob: k.dob, gender: k.gender, affiliate: k.affiliate, others: k.others })),
      fromKid, regs: regsOut(regs), kidRegs: regsOut(kidRegs), crew: crew.map(c => ({ event: c.event_id, role: c.role, status: c.status })) };
  }
  if (type === 'kid') {
    const k = (await db.query('select * from kids where id=$1', [id])).rows[0];
    if (!k) throw bad('Ребёнок не найден');
    const parents = (await db.query('select y.*, g.created_at linked from kid_guardians g join users y on y.id=g.user_id where g.kid_id=$1 order by g.created_at', [k.id])).rows;
    const owner = k.owner_user ? (await db.query('select * from users where id=$1', [k.owner_user])).rows[0] : null;
    const regs = (await db.query(`${regSel} where r.who=$1 order by r.created_at desc`, [k.id])).rows;
    return { type, kid: { id: k.id, first: k.first, last: k.last, dob: k.dob, gender: k.gender, affiliate: k.affiliate, created: k.created_at },
      parents: parents.map(y => ({ ...userCard(y), linked: y.linked })), owner: owner ? userCard(owner) : null, regs: regsOut(regs) };
  }
  if (type === 'guest') {
    let key; try { key = JSON.parse(id); } catch (_) { throw bad('Неверный запрос'); }
    const regs = (await db.query(`${regSel} where r.user_id is null and r.athlete_user is null and r.who='me' and coalesce(r.person->>'last','')=$1 and coalesce(r.person->>'first','')=$2 and coalesce(r.person->>'dob','')=$3 order by r.created_at desc`, key.slice(0, 3).map(String))).rows;
    return { type, guest: { last: key[0], first: key[1], dob: key[2] }, regs: regsOut(regs) };
  }
  throw bad('Неверный запрос');
});
/* internal penalty notes: only the owner writes and reads them */
route('POST', '/api/admin/penalty', async (req, res, u, body) => {
  need(u, 'owner');
  const text = String(body.text == null ? '' : body.text).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 500);
  const r = await db.query('update registrations set penalty=$2 where id=$1 returning id', [str(body.reg, 40), text || null]);
  if (!r.rows.length) throw bad('Участник не найден');
  return { reg: r.rows[0].id, text };
});
route('POST', '/api/admin/score', async (req, res, u, body) => {
  need(u, 'owner', 'admin', 'judge');
  const reg = (await db.query('select * from registrations where id=$1', [str(body.reg, 40)])).rows[0];
  if (!reg) throw bad('Регистрация не найдена');
  if (reg.status !== 'paid') throw bad('Результат можно внести после оплаты');
  const ev = ((await rawContent()).EVENTS || []).find(e => e.id === reg.event_id);
  const w = ev && (ev.workouts || []).find(x => x.id === body.workout); if (!w) throw bad('Задание не найдено');
  if (w.divs && w.divs.length && !w.divs.includes(reg.div_id)) throw bad('У этой категории нет такого комплекса');
  if (body.value === null || body.value === '') {
    await db.query('delete from scores where reg_id=$1 and workout_id=$2', [reg.id, w.id]); dirty(); return { score: null };
  }
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
  const id = decodeURIComponent(p.id);
  const cur = (await db.query('select * from registrations where id=$1', [id])).rows[0];
  if (!cur) throw bad('Регистрация не найдена');
  let st = cur.status, paid = cur.paid, note = cur.note;
  if (body.status !== undefined) {
    if (!['new', 'paid', 'refund_requested', 'refunded', 'cancelled', 'blocked', 'pending', 'reserve'].includes(body.status)) throw bad('Неверный статус');
    st = body.status;
    if (st === 'paid' && cur.status !== 'paid' && (body.paid === undefined || Number(body.paid) === Number(cur.paid))) paid = cur.due;
  }
  if (body.paid !== undefined && !(st === 'paid' && cur.status !== 'paid' && Number(body.paid) === Number(cur.paid))) {
    const v = Math.round(Number(body.paid));
    if (!Number.isFinite(v) || v < 0 || v > 1e7) throw bad('Сумма — целое число рублей от 0');
    paid = v;
  }
  if (body.note !== undefined) note = str(body.note, 1000) || null;
  // free entry granted by the organizer: admitted with 0 paid, the reason is kept (e.g. «Рекорд Талант»)
  let waiver = cur.waiver;
  if (body.waiver !== undefined) {
    waiver = str(body.waiver, 80) || null;
    if (waiver) { st = 'paid'; paid = 0; }
    else if (cur.waiver && body.status === undefined) st = 'new';
  } else if (body.status !== undefined && body.status !== 'paid') waiver = null;
  else if (body.status === 'paid' && body.paid !== undefined && Number(body.paid) > 0) waiver = null;
  let div = cur.div_id, warn = '';
  if (body.div !== undefined && body.div !== cur.div_id) {
    const ev = ((await rawContent()).EVENTS || []).find(e => e.id === cur.event_id);
    const from = ev && ev.divisions.find(d => d.id === cur.div_id), to = ev && ev.divisions.find(d => d.id === body.div);
    if (!to) throw bad('Категория не найдена');
    if ((from && from.type === 'team') || to.type === 'team') throw bad('Командные заявки между категориями не переносятся — переносится вся команда, это пока делается вручную');
    const n = (await db.query(`select count(*)::int n from registrations where event_id=$1 and div_id=$2 and status in ${ACTIVE}`, [cur.event_id, to.id])).rows[0].n;
    if (to.limit && n >= to.limit) warn = `В категории «${to.name}» теперь ${n + 1} при лимите ${to.limit}`;
    div = to.id;
  }
  const r = await db.query('update registrations set status=$1, paid=$2, note=$3, div_id=$4, updated_by=$5, waiver=$6 where id=$7 returning *', [st, paid, note, div, u.email, waiver, id]);
  await fixCaptain(cur.event_id, cur.div_id, cur.team);
  dirty();
  return { order: orderOut(r.rows[0]), warn };
});
/* ---------- Telegram notifications for organizers ---------- */
/* email: events are collected for 30 s and sent as one letter, so a rush of registrations does not flood the mailbox */
let mailQueue = [], mailTimer = null;
async function flushMail() {
  mailTimer = null;
  const items = mailQueue.splice(0); if (!items.length || !mail.configured()) return;
  try {
    const to = (await db.query('select email from notify_emails order by created_at')).rows.map(r => r.email);
    if (!to.length) return;
    const subject = items.length === 1 ? `Рекорд: ${items[0].title}` : `Рекорд: новые уведомления (${items.length})`;
    const text = items.map(i => [i.title.toUpperCase(), ...i.lines].join('\n')).join('\n\n— — —\n\n') + `\n\nПанель организатора: ${SITE_URL()}/#admin\nНастроить уведомления: панель → «Управление сайтом» → «Уведомления на почту».`;
    for (const addr of to) await mail.send({ to: addr, subject, text }).catch(e => console.error('notify mail failed:', e.message));
  } catch (e) { console.error('notify failed:', e.message); }
}
function notify(tgHtml, msg) {
  if (msg && mail.configured()) { mailQueue.push(msg); if (!mailTimer) mailTimer = setTimeout(flushMail, +process.env.NOTIFY_DELAY_MS || 30000); }
  if (tg.configured()) db.query('select chat_id from tg_chats').then(r => tg.send(r.rows.map(x => x.chat_id), tgHtml)).catch(e => console.error('notify tg failed:', e.message));
}
const evName = async id => { const e = ((await rawContent()).EVENTS || []).find(x => x.id === id); return e ? e.name : id; };
const divName = async (evId, divId) => { const e = ((await rawContent()).EVENTS || []).find(x => x.id === evId); const d = e && e.divisions.find(x => x.id === divId); return d ? d.name : divId; };
const rub = n => (Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
const SITE_URL = () => String(process.env.SITE_URL || 'https://recordirk.ru').replace(/\/$/, '');
function tgStart() {
  tg.start({
    onStart: async (chat, code, from) => {
      if (!code) return 'Это бот уведомлений для организаторов «Рекорда». Подключить его можно ссылкой из панели организатора: «Управление сайтом» → «Уведомления в Telegram».';
      const l = (await db.query('delete from tg_links where code=$1 returning email, expires_at', [code])).rows[0];
      if (!l || l.expires_at < new Date()) return 'Ссылка устарела. Создайте новую в панели организатора.';
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
      await db.query('insert into tg_chats(chat_id, email, name) values ($1,$2,$3) on conflict (chat_id) do update set email=excluded.email, name=excluded.name', [chat, l.email, name]);
      return '✅ Готово. Сюда будут приходить уведомления: заявки на старты, заявки на пробную, заявки в команду и запросы на возврат.\nОтключить — команда /stop.';
    },
    onStop: async chat => { await db.query('delete from tg_chats where chat_id=$1', [chat]); return 'Уведомления отключены. Подключить снова можно из панели организатора.'; },
  });
}
route('GET', '/api/admin/tg', async (req, res, u) => {
  need(u, 'owner', 'admin');
  const chats = (await db.query('select chat_id, email, name, created_at from tg_chats order by created_at')).rows;
  return { ...tg.status(), chats: chats.map(c => ({ id: c.chat_id, name: c.name || '', email: u.role === 'owner' || c.email === u.email ? c.email || '' : '', created: c.created_at })) };
});
route('POST', '/api/admin/tg/link', async (req, res, u) => {
  need(u, 'owner', 'admin');
  if (!tg.configured()) throw bad('Бот ещё не подключён к сайту');
  if (!tg.bot()) throw bad('Бот запускается, попробуйте через минуту');
  const code = crypto.randomBytes(12).toString('hex');
  await db.query(`delete from tg_links where expires_at < now()`);
  await db.query(`insert into tg_links(code, email, expires_at) values ($1,$2, now() + interval '30 minutes')`, [code, u.email]);
  return { url: `https://t.me/${tg.bot()}?start=${code}` };
});
route('DELETE', '/api/admin/tg/:chat', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  await db.query('delete from tg_chats where chat_id=$1', [decodeURIComponent(p.chat)]);
  return { ok: true };
});
route('POST', '/api/admin/notify/test', async (req, res, u) => {
  need(u, 'owner', 'admin');
  limit('notify-test:' + u.id, 10, 3600e3);
  if (!mail.configured()) throw bad('Отправка писем не настроена');
  const to = (await db.query('select email from notify_emails')).rows.map(r => r.email);
  if (!to.length && !tg.configured()) throw bad('Сначала добавьте адрес');
  notify('🔔 Проверка: уведомления «Рекорда» работают.', { title: 'проверка уведомлений', lines: ['Уведомления работают. Сюда будут приходить заявки на старты, на пробную тренировку, в команду и запросы на возврат.'] });
  return { ok: true, to: to.length };
});
route('GET', '/api/admin/notify', async (req, res, u) => {
  need(u, 'owner', 'admin');
  return { mail: mail.configured(), emails: (await db.query('select email, created_at from notify_emails order by created_at')).rows.map(r => r.email), tg: tg.configured() };
});
route('POST', '/api/admin/notify', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw bad('Проверьте адрес почты');
  if ((await db.query('select count(*)::int n from notify_emails')).rows[0].n >= 10) throw bad('Можно до 10 адресов');
  await db.query('insert into notify_emails(email, added_by) values ($1,$2) on conflict do nothing', [email, u.email]);
  return { ok: true };
});
route('DELETE', '/api/admin/notify/:email', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  await db.query('delete from notify_emails where email=$1', [decodeURIComponent(p.email).toLowerCase()]);
  return { ok: true };
});

/* ---------- crew applications from the site ---------- */
const SELF_ROLES = ['judge', 'volunteer', 'assistant'];
route('POST', '/api/crew/apply', async (req, res, u, body) => {
  need(u);
  limit('crew-apply:' + u.id, 10, 3600e3);
  const ev = ((await rawContent()).EVENTS || []).find(e => e.id === str(body.event, 60));
  if (!ev || ev.status === 'draft' || ev.status === 'ended') throw bad('Набор в команду на этот старт закрыт');
  const p = u.profile || {};
  if (!p.first || !p.last || !p.phone) throw bad('Заполните в анкете имя, фамилию и телефон');
  if (!SELF_ROLES.includes(body.role)) throw bad('Выберите, кем хотите работать');
  if (!body.consent) throw bad('Нужно согласие на обработку персональных данных');
  const avail = (Array.isArray(body.days) ? body.days : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14);
  const name = `${p.last} ${p.first}`.trim(), note = str(body.note, 1000) || null;
  let r;
  try {
    const info = { dob: p.dob || '', gym: p.affiliate || '', tg: p.tg || '', gender: p.gender || '' };
    r = await db.query(`insert into crew(event_id, user_id, name, phone, contact, role, status, avail, note, source, info) values ($1,$2,$3,$4,$5,$6,'request',$7,$8,'site',$9) returning *`,
      [ev.id, u.id, name, p.phone, [u.email, p.tg ? 'tg ' + p.tg : ''].filter(Boolean).join(' · '), body.role, avail, note, info]);
  } catch (e) { if (e.code === '23505') throw bad('Вы уже подали заявку в команду этого старта'); throw e; }
  await logConsent(req, 'user:' + u.id, 'pd', 'crew:' + r.rows[0].id);
  const ROLE = { judge: 'судья', volunteer: 'волонтёр', assistant: 'ассистент организатора' };
  notify(`🙋 <b>Заявка в команду</b>\n${tg.esc(ev.name)}\nРоль: ${ROLE[body.role]}${avail.length ? `\nДни: ${avail.map(d => d.slice(8) + '.' + d.slice(5, 7)).join(', ')}` : ''}\n${SITE_URL()}/#admin`,
    { title: 'заявка в команду старта', lines: [`Старт: ${ev.name}`, `Имя: ${name}`, `Телефон: ${p.phone}`, `Email: ${u.email}`, `Роль: ${ROLE[body.role]}`, ...(avail.length ? [`Может: ${avail.map(d => d.slice(8) + '.' + d.slice(5, 7)).join(', ')}`] : []), ...(note ? [`Комментарий: ${note}`] : [])] });
  return { crew: { id: Number(r.rows[0].id), event: ev.id, role: body.role, status: 'request', avail } };
});
route('DELETE', '/api/crew/apply/:id', async (req, res, u, body, p) => {
  need(u);
  const r = await db.query(`delete from crew where id=$1 and user_id=$2 and status in ('request','declined') returning id`, [Number(p.id) || 0, u.id]);
  if (!r.rows.length) throw bad('Заявку уже подтвердили — чтобы отказаться, свяжитесь с организатором');
  return { ok: true };
});

/* ---------- event crew: judges, volunteers, venue staff; pay per shift ---------- */
const CREW_ROLES = ['head_judge', 'judge', 'venue_admin', 'assistant', 'volunteer'];
const CREW_ST = ['request', 'confirmed', 'declined'];
const crewOut = c => ({ id: Number(c.id), event: c.event_id, user: c.user_id ? Number(c.user_id) : null, avail: c.avail || [], source: c.source || 'manual', info: c.info || {}, name: c.name, phone: c.phone || '', contact: c.contact || '', role: c.role, status: c.status, rate: c.rate, work: c.work || {}, note: c.note || '' });
const money = (v, label) => { if (v === '' || v == null) return null; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1e6) throw bad(label + ': целое число рублей'); return n; };
function cleanWork(w) {
  const out = {};
  for (const [d, v] of Object.entries(w && typeof w === 'object' ? w : {}).slice(0, 31)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v) continue;
    if (v.k === 'full' || v.k === 'half') out[d] = { k: v.k };
    else if (v.k === 'h') { const h = Math.round(Number(v.h) * 4) / 4; if (!(h > 0 && h <= 24)) throw bad('Часы: число от 0,25 до 24'); out[d] = { k: 'h', h }; }
  }
  return out;
}
function crewFields(body, cur) {
  const f = { ...cur };
  if (body.name !== undefined) { f.name = nm(body.name, 120); if (!f.name) throw bad('Укажите имя'); }
  if (body.phone !== undefined) f.phone = str(body.phone, 40) || null;
  if (body.contact !== undefined) f.contact = str(body.contact, 200) || null;
  if (body.role !== undefined) { if (!CREW_ROLES.includes(body.role)) throw bad('Неверная должность'); f.role = body.role; }
  if (body.status !== undefined) { if (!CREW_ST.includes(body.status)) throw bad('Неверный статус'); f.status = body.status; }
  if (body.rate !== undefined) f.rate = money(body.rate, 'Ставка');
  if (body.work !== undefined) f.work = cleanWork(body.work);
  if (body.note !== undefined) f.note = str(body.note, 1000) || null;
  return f;
}
route('POST', '/api/admin/crew', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const ev = str(body.event, 60); if (!ev) throw bad('Не выбран старт');
  const f = crewFields({ role: 'judge', status: 'request', ...body }, {});
  if (!f.name) throw bad('Укажите имя');
  const r = await db.query('insert into crew(event_id, name, phone, contact, role, status, rate, work, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',
    [ev, f.name, f.phone || null, f.contact || null, f.role, f.status, f.rate ?? null, f.work || {}, f.note || null, u.email]);
  return { crew: crewOut(r.rows[0]) };
});
route('PATCH', '/api/admin/crew/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  const cur = (await db.query('select * from crew where id=$1', [Number(p.id) || 0])).rows[0];
  if (!cur) throw bad('Человек не найден');
  const f = crewFields(body, cur);
  const r = await db.query('update crew set name=$1, phone=$2, contact=$3, role=$4, status=$5, rate=$6, work=$7, note=$8, updated_by=$9 where id=$10 returning *',
    [f.name, f.phone, f.contact, f.role, f.status, f.rate, f.work, f.note, u.email, cur.id]);
  return { crew: crewOut(r.rows[0]) };
});
route('DELETE', '/api/admin/crew/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  await db.query('delete from crew where id=$1', [Number(p.id) || 0]);
  return { ok: true };
});
/* head judge (confirmed, applied from the site) manages the crew of their start: confirm / decline / mark work; no money */
async function headJudgeEvents(u) {
  return (await db.query(`select distinct event_id from crew where user_id=$1 and role='head_judge' and status='confirmed'`, [u.id])).rows.map(r => r.event_id);
}
const crewOutNoMoney = c => { const o = crewOut(c); delete o.rate; return o; };
route('GET', '/api/crew/manage', async (req, res, u) => {
  need(u);
  const evs = await headJudgeEvents(u);
  if (!evs.length) throw new HttpError(403, 'Раздел доступен главному судье старта');
  const crew = (await db.query('select * from crew where event_id in (select jsonb_array_elements_text($1::jsonb)) order by created_at', [JSON.stringify(evs)])).rows.map(crewOutNoMoney);
  const cfg = Object.fromEntries((await db.query('select event_id, shift_hours from crew_rates where event_id in (select jsonb_array_elements_text($1::jsonb))', [JSON.stringify(evs)])).rows.map(r => [r.event_id, { rates: {}, shift: Number(r.shift_hours) }]));
  return { events: evs, crew, cfg };
});
route('PATCH', '/api/crew/manage/:id', async (req, res, u, body, p) => {
  need(u);
  const cur = (await db.query('select * from crew where id=$1', [Number(p.id) || 0])).rows[0];
  if (!cur || !(await headJudgeEvents(u)).includes(cur.event_id)) throw new HttpError(403, 'Нет доступа');
  const f = crewFields({ status: body.status, work: body.work, role: body.role, note: body.note }, cur);
  const r = await db.query('update crew set role=$1, status=$2, work=$3, note=$4, updated_by=$5 where id=$6 returning *', [f.role, f.status, f.work, f.note, u.email, cur.id]);
  return { crew: crewOutNoMoney(r.rows[0]) };
});

route('PUT', '/api/admin/crew-rates/:event', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  const ev = decodeURIComponent(p.event);
  const rates = {}; for (const k of CREW_ROLES) { const v = money(body.rates && body.rates[k], 'Ставка'); if (v != null) rates[k] = v; }
  const shift = Number(body.shift); if (!(shift >= 1 && shift <= 24)) throw bad('Длина смены: от 1 до 24 часов');
  await db.query('insert into crew_rates(event_id, rates, shift_hours, updated_by) values ($1,$2,$3,$4) on conflict (event_id) do update set rates=excluded.rates, shift_hours=excluded.shift_hours, updated_by=excluded.updated_by', [ev, rates, shift, u.email]);
  return { cfg: { rates, shift } };
});

/* captain left the main roster (refund, cancel, block, delete) -> the earliest main member becomes captain */
async function fixCaptain(eventId, divId, team) {
  if (!team) return;
  const t = (await db.query('select * from teams where event_id=$1 and div_id=$2 and name=$3', [eventId, divId, team])).rows[0]; if (!t) return;
  const roster = await teamRoster(db.query.bind(db), eventId, divId, team);
  const main = roster.filter(r => ['new', 'paid'].includes(r.status));
  if (main.some(r => r.id === t.captain_reg)) return;
  const next = main[0]; if (!next) return;
  await db.query('update teams set captain_reg=$1 where id=$2', [next.id, t.id]);
  mailMember(next.id, `вы капитан команды «${team}»`, [`Прежний капитан вышел из основного состава, и капитаном команды «${team}» теперь стали вы.`, 'Принимать заявки, менять состав и отправлять ссылку-приглашение можно в «Моих стартах», в карточке старта.', '', `${SITE_URL()}/#orders`]);
}
route('POST', '/api/admin/team/captain', async (req, res, u, body) => {
  need(u, 'owner', 'admin');
  const r = (await db.query('select * from registrations where id=$1', [str(body.reg, 40)])).rows[0];
  if (!r || !r.team) throw bad('Это не командная заявка');
  if (!['new', 'paid', 'refund_requested'].includes(r.status)) throw bad('Капитаном может стать только участник основного состава');
  await db.query('update teams set captain_reg=$1 where event_id=$2 and div_id=$3 and name=$4', [r.id, r.event_id, r.div_id, r.team]);
  mailMember(r.id, `вы капитан команды «${r.team}»`, [`Организатор назначил вас капитаном команды «${r.team}».`, 'Принимать заявки, менять состав и отправлять ссылку-приглашение можно в «Моих стартах», в карточке старта.', '', `${SITE_URL()}/#orders`]);
  return { ok: true };
});
route('DELETE', '/api/admin/regs/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin');
  const r = await db.query('delete from registrations where id=$1 returning id, event_id, div_id, team', [decodeURIComponent(p.id)]);
  if (!r.rows.length) throw bad('Регистрация не найдена');
  await fixCaptain(r.rows[0].event_id, r.rows[0].div_id, r.rows[0].team);
  dirty();
  return { ok: true };
});

route('PATCH', '/api/admin/scores/:id', async (req, res, u, body, p) => {
  need(u, 'owner', 'admin', 'judge');
  const st = body.state === 'accepted' ? 'accepted' : 'rejected';
  await db.query('update scores set state=$1, reviewed_by=$2 where id=$3', [st, u.email, +p.id || 0]);
  dirty();
  return { ok: true };
});

/* ---------- backups: a daily snapshot of every table, kept 14 days; the owner downloads them ---------- */
const BACKUP_TABLES = ['content', 'users', 'staff', 'leads', 'teams', 'registrations', 'scores', 'consents', 'crew', 'crew_rates', 'tg_chats', 'notify_emails', 'kids', 'kid_guardians'];
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

const PRIMARY = 'https://recordirk.ru';
const MIRRORS = new Set(['www.recordirk.ru', 'xn--d1abpqbfcddho.xn--p1ai', 'www.xn--d1abpqbfcddho.xn--p1ai', 'рекордспорт.рф', 'www.рекордспорт.рф']);
/* the main page with search-engine verification tags that the organizer pastes in the panel */
let indexCache = { key: null };
async function serveIndex(req, res, status = 200) {
  const v = ((await db.query(`select data->'SITE'->'verify' v from content where id=1`)).rows[0] || {}).v || {};
  const ok = x => typeof x === 'string' && /^[A-Za-z0-9_-]{6,120}$/.test(x) ? x : '';
  const tags = (ok(v.yandex) ? `<meta name="yandex-verification" content="${ok(v.yandex)}">\n` : '') + (ok(v.google) ? `<meta name="google-site-verification" content="${ok(v.google)}">\n` : '');
  const file = path.join(PUBLIC, 'index.html'), st = fs.statSync(file), key = tags + st.mtimeMs;
  if (indexCache.key !== key) {
    const data = Buffer.from(fs.readFileSync(file, 'utf8').replace('</head>', tags + '</head>'));
    indexCache = { key, data, gz: zlib.gzipSync(data, { level: 9 }), etag: '"i' + crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + '"' };
  }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', ETag: indexCache.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (status === 200 && req.headers['if-none-match'] === indexCache.etag) { res.writeHead(304, headers); res.end(); return; }
  const gz = wantsGzip(req); if (gz) headers['Content-Encoding'] = 'gzip';
  res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : gz ? indexCache.gz : indexCache.data);
}
let scriptHash = '';
try { const m = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/); if (m) scriptHash = "'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'"; } catch (_) {}
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' " + (scriptHash || "'unsafe-inline'") + " https://mc.yandex.ru https://yastatic.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://mc.yandex.ru https://mc.yandex.com; font-src 'self'; connect-src 'self' https://mc.yandex.ru https://mc.yandex.com; frame-src https://mc.yandex.ru https://mc.yandex.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
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
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, pathname === '/api/admin/content' ? 40 * 1048576 : pathname === '/api/profile/avatar' ? 300 * 1024 : 64 * 1024) : {};
      const u = await sessionOf(req);
      const out = await r.fn(req, res, u, body, pathname.match(r.re).groups || {});
      if (out !== undefined) send(res, 200, out);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
    // one address for search engines: other domains of the site send visitors to the main one
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (MIRRORS.has(host) && !pathname.startsWith('/.well-known/')) { res.writeHead(301, { Location: PRIMARY + req.url }); res.end(); return; }
    if (pathname === '/' || pathname === '/index.html') { await serveIndex(req, res); return; }
    if (serveStatic(req, res, pathname)) return;
    if (!path.extname(pathname)) { await serveIndex(req, res, 404); return; }
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
  tgStart();
  setInterval(dailyBackup, 3600e3).unref();
}).catch(e => { console.error('startup failed:', e); process.exit(1); });
