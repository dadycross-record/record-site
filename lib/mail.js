'use strict';
/* Minimal SMTP sender: implicit TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN, UTF-8 messages. */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function config() {
  const e = process.env;
  if (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASS) return null;
  // copied values often carry stray spaces or line breaks; app passwords never contain spaces
  const user = String(e.SMTP_USER).trim(), pass = String(e.SMTP_PASS).replace(/\s+/g, '');
  return {
    host: String(e.SMTP_HOST).trim(), port: +(String(e.SMTP_PORT || '').trim() || 465), user, pass,
    from: String(e.MAIL_FROM || '').trim() || user, fromName: e.MAIL_FROM_NAME || 'Центр спорта «Рекорд»',
    insecure: e.SMTP_TLS_INSECURE === '1',
  };
}

function reader(sock) {
  let buf = '', waiting = null;
  const lines = [];
  const pump = () => {
    if (!waiting) return;
    const i = lines.findIndex(l => /^\d{3} /.test(l));
    if (i < 0) return;
    const block = lines.splice(0, i + 1);
    const w = waiting; waiting = null;
    w.res({ code: +block[i].slice(0, 3), text: block.join('\n') });
  };
  const onData = d => { buf += d.toString('utf8'); let k; while ((k = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, k).replace(/\r$/, '')); buf = buf.slice(k + 1); } pump(); };
  sock.on('data', onData);
  return {
    read: () => new Promise((res, rej) => { waiting = { res, rej }; sock.once('error', rej); pump(); }),
    detach: () => sock.removeListener('data', onData),
  };
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

async function send({ to, subject, text, html }) {
  const c = config();
  if (!c) throw new Error('SMTP is not configured');
  const timeout = setTimeout(() => sock && sock.destroy(new Error('SMTP timeout')), 20000);
  let sock = c.port === 465
    ? tls.connect({ host: c.host, port: c.port, servername: c.host, rejectUnauthorized: !c.insecure })
    : net.connect(c.port, c.host);
  try {
    await new Promise((res, rej) => { sock.once(c.port === 465 ? 'secureConnect' : 'connect', res); sock.once('error', rej); });
    let r = reader(sock);
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const ans = await r.read();
      if (!ok.includes(ans.code)) throw new Error(`SMTP ${ans.code}: ${ans.text.slice(0, 200)}`);
      return ans;
    };
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO recordirk.ru', [250]);
    if (c.port !== 465) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server has no STARTTLS');
      await cmd('STARTTLS', [220]);
      r.detach();
      sock = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: !c.insecure });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      r = reader(sock);
      ehlo = await cmd('EHLO recordirk.ru', [250]);
    }
    if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) await cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235]);
    else { await cmd('AUTH LOGIN', [334]); await cmd(b64(c.user), [334]); await cmd(b64(c.pass), [235]); }
    await cmd(`MAIL FROM:<${c.from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const boundary = 'b' + crypto.randomBytes(8).toString('hex');
    const wrap = s => b64(s).replace(/.{76}/g, '$&\r\n');
    const parts = [
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(text),
      ...(html ? [`--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap(html)] : []),
      `--${boundary}--`,
    ];
    const domain = c.from.split('@')[1] || 'recordirk.ru';
    const message = [
      `From: ${encWord(c.fromName)} <${c.from}>`, `To: <${to}>`, `Subject: ${encWord(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...parts, '',
    ].join('\r\n').replace(/\r\n\./g, '\r\n..');
    await cmd(message + '\r\n.', [250]);
    sock.write('QUIT\r\n');
  } finally {
    clearTimeout(timeout);
    setTimeout(() => { try { sock.destroy(); } catch (_) {} }, 500);
  }
}

function describe() {
  const c = config(); if (!c) return 'smtp: not configured';
  const mask = a => a.replace(/^(.{2})[^@]*(@.*)$/, '$1***$2');
  return `smtp: ${c.host}:${c.port} user=${mask(c.user)} from=${mask(c.from)} pass=${c.pass.length} chars${/^[a-z]{16}$/.test(c.pass) ? ' (looks like an app password)' : ' (NOT 16 lowercase letters)'}`;
}

module.exports = { send, configured: () => !!config(), describe };
