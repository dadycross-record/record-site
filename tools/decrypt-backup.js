#!/usr/bin/env node
'use strict';
/* Decrypts an off-site backup from Yandex Disk.
   Usage: node tools/decrypt-backup.js record-backup-mon.bin > record-backup.json.gz
   The passphrase (BACKUP_KEY) is read from the BACKUP_KEY environment variable or asked for. */
const fs = require('fs'), crypto = require('crypto'), readline = require('readline');
async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Укажите файл: node tools/decrypt-backup.js record-backup-mon.bin > backup.json.gz'); process.exit(1); }
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 6).toString() !== 'RECBK1') { console.error('Это не зашифрованная копия «Рекорда»'); process.exit(1); }
  let pass = process.env.BACKUP_KEY;
  if (!pass) { const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); pass = await new Promise(r => rl.question('Ключ шифрования: ', a => { rl.close(); r(a); })); }
  const salt = buf.slice(6, 22), iv = buf.slice(22, 34), tag = buf.slice(34, 50), data = buf.slice(50);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv); d.setAuthTag(tag);
  try { process.stdout.write(Buffer.concat([d.update(data), d.final()])); }
  catch (_) { console.error('Неверный ключ или файл повреждён'); process.exit(1); }
}
main();
