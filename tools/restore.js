'use strict';
// Run only against a deliberately selected recovery database, never on startup.
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('../lib/pg');
const { validate, restore } = require('../lib/backup');
async function main() {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL || process.env.RESTORE_CONFIRM !== 'record-site') throw new Error('Укажите файл, DATABASE_URL и RESTORE_CONFIRM=record-site. Восстановление заменяет данные целевой базы.');
  const dump = validate(JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')));
  await restore(new Pool(process.env.DATABASE_URL, 1), dump);
  console.log('restored from', dump.created);
}
main().then(() => process.exit(0)).catch(e => { console.error('restore failed:', e.message); process.exit(1); });
