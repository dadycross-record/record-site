'use strict';
const TABLES = ['content', 'users', 'staff', 'leads', 'teams', 'registrations', 'scores', 'consents', 'crew', 'crew_rates', 'tg_chats', 'notify_emails', 'kids', 'kid_guardians'];
const SERIAL = ['users', 'leads', 'teams', 'scores', 'consents', 'crew'];
const TRANSIENT = ['sessions', 'login_codes', 'tg_links', 'kid_invites'];

async function snapshot(db) {
  const tables = {};
  await db.tx(async q => {
    await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of TABLES) tables[table] = (await q(`SELECT * FROM ${table}`)).rows;
  });
  return { app: 'record-site', version: 1, created: new Date().toISOString(), tables };
}

function validate(dump) {
  if (!dump || dump.app !== 'record-site' || dump.version !== 1 || !dump.tables) throw new Error('Неизвестный формат копии');
  for (const table of TABLES) {
    if (!Array.isArray(dump.tables[table])) throw new Error(`В копии нет таблицы ${table}; восстановление отменено`);
    for (const row of dump.tables[table]) {
      if (!row || Array.isArray(row) || typeof row !== 'object' || !Object.keys(row).length || Object.keys(row).some(c => !/^[a-z_][a-z0-9_]*$/.test(c))) throw new Error(`Повреждённая строка в ${table}`);
    }
  }
  return dump;
}

async function restore(db, dump) {
  validate(dump);
  await db.tx(async q => {
    await q(`truncate ${[...TRANSIENT, ...TABLES].reverse().join(', ')} restart identity cascade`);
    for (const table of TABLES) {
      for (const row of dump.tables[table]) {
        const cols = Object.keys(row);
        await q(`insert into ${table} (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map(c => row[c]));
      }
      if (SERIAL.includes(table)) await q(`select setval(pg_get_serial_sequence('${table}', 'id'), greatest(coalesce((select max(id) from ${table}), 0), 1), exists(select 1 from ${table}))`);
    }
  });
}
module.exports = { TABLES, validate, restore, snapshot };
