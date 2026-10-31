'use strict';
/* Restore the database from a backup file downloaded in the organizer panel.
   Usage: DATABASE_URL=postgres://... node tools/restore.js record-backup-YYYYMMDDHHMM.json.gz
   Replaces ALL data in the listed tables with the contents of the backup, in one transaction. */
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('../lib/pg');

const file = process.argv[2];
if (!file || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=... node tools/restore.js <backup.json.gz>'); process.exit(1); }
const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
if (dump.app !== 'record-site' || !dump.tables) { console.error('not a record-site backup'); process.exit(1); }

const ORDER = ['content', 'users', 'staff', 'leads', 'teams', 'registrations', 'scores', 'consents', 'crew', 'crew_rates'];
const SERIAL = ['users', 'leads', 'teams', 'scores', 'consents', 'crew'];
const db = new Pool(process.env.DATABASE_URL, 1);

(async () => {
  await db.tx(async q => {
    await q(`truncate ${[...ORDER].reverse().join(', ')} restart identity cascade`);
    for (const t of ORDER) {
      for (const row of dump.tables[t] || []) if (row) {
        const cols = Object.keys(row);
        await q(`insert into ${t} (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(c => row[c]));
      }
      if (SERIAL.includes(t)) await q(`select setval(pg_get_serial_sequence('${t}', 'id'), greatest(coalesce((select max(id) from ${t}), 0), 1))`);
      console.log(`${t}: ${(dump.tables[t] || []).length} rows`);
    }
  });
  console.log('restored from', dump.created);
  process.exit(0);
})().catch(e => { console.error('restore failed, nothing changed:', e.message); process.exit(1); });
