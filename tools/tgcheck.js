'use strict';
/* Can this server reach Telegram? npm run tgcheck */
const https = require('https');
const hosts = ['https://api.telegram.org/', 'https://ya.ru/'];
let left = hosts.length;
for (const u of hosts) {
  const t0 = Date.now();
  const r = https.get(u, res => { console.log(`${u} -> HTTP ${res.statusCode} за ${Date.now() - t0} мс`); res.resume(); if (!--left) process.exit(0); });
  r.setTimeout(10000, () => r.destroy(new Error('нет ответа за 10 с')));
  r.on('error', e => { console.log(`${u} -> ошибка: ${e.code || ''} ${e.message}`); if (!--left) process.exit(0); });
}
