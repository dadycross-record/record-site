'use strict';
/* Telegram bot for organizer notifications (no dependencies).
   TELEGRAM_BOT_TOKEN — token from @BotFather. Organizers link their chat from the panel:
   the panel gives a t.me/<bot>?start=<code> link, the bot receives "/start <code>" via long polling. */
const https = require('https');
const http = require('http');

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = () => String(process.env.TG_API || 'https://api.telegram.org').replace(/\/$/, '');
let botName = '', running = false, lastError = '';

function call(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${API()}/bot${token()}/${method}`);
    const data = Buffer.from(JSON.stringify(params || {}));
    const lib = u.protocol === 'http:' ? http : https;
    const r = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return reject(new Error('telegram: bad response ' + res.statusCode)); }
        if (!j.ok) { const e = new Error('telegram: ' + (j.description || res.statusCode)); e.code = j.error_code; return reject(e); }
        resolve(j.result);
      });
    });
    r.on('error', reject);
    r.setTimeout(timeoutMs, () => r.destroy(new Error('telegram: timeout')));
    r.end(data);
  });
}

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* onStart(chatId, code, from) -> reply text; onStop(chatId) -> reply text */
async function start({ onStart, onStop }) {
  if (!token() || running) return;
  running = true;
  let offset = 0, webhookCleared = false;
  while (running) {
    try {
      if (!botName) { const me = await call('getMe'); botName = me.username || ''; console.log('telegram bot @' + botName); }
      const ups = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65000);
      lastError = '';
      for (const up of ups) {
        offset = up.update_id + 1;
        const m = up.message; if (!m || !m.text || !m.chat) continue;
        const chat = String(m.chat.id), text = m.text.trim();
        let reply;
        const sm = text.match(/^\/start(?:\s+(\S+))?/);
        if (sm) reply = await onStart(chat, sm[1] || '', m.from || {});
        else if (/^\/stop/.test(text)) reply = await onStop(chat);
        else reply = 'Этот бот присылает организаторам «Рекорда» уведомления о новых заявках. Чтобы подключить его, откройте ссылку из панели организатора. Отключить — команда /stop.';
        if (reply) await call('sendMessage', { chat_id: chat, text: reply, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
      }
    } catch (e) {
      lastError = e.message;
      if (e.code === 409 && !webhookCleared) { webhookCleared = true; await call('deleteWebhook').catch(() => {}); continue; }
      if (e.code === 401) { console.error('telegram: wrong TELEGRAM_BOT_TOKEN'); running = false; return; }
      await sleep(10000);
    }
  }
}

async function send(chats, html) {
  if (!token()) return;
  for (const c of chats) {
    await call('sendMessage', { chat_id: c, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
      .catch(e => console.error('telegram send failed:', e.message));
  }
}

module.exports = { start, send, esc, configured: () => !!token(), bot: () => botName, status: () => ({ ready: !!token(), bot: botName, error: lastError }) };
