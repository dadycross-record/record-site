'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const backup = require('../lib/backup');

function example(version) {
  const tables = Object.fromEntries(backup.TABLES.map(name => [name, [{ id: 1 }]]));
  if (version >= 2) { tables.score_judges = []; tables.audit_log = []; }
  if (version >= 3) tables.team_messages = [{ id: 1, team_id: 1, sender_id: 1, receiver_id: 2, body: 'ok' }];
  return { app: 'record-site', version, created: '2026-11-16T00:00:00.000Z', tables };
}

test('old v1 and v2 backups can still be validated', () => {
  assert.doesNotThrow(() => backup.validate(example(1)));
  assert.doesNotThrow(() => backup.validate(example(2)));
});

test('v3 backups must contain the team messages table', () => {
  assert.doesNotThrow(() => backup.validate(example(3)));
  const incomplete = example(3);
  delete incomplete.tables.team_messages;
  assert.throws(() => backup.validate(incomplete), /team_messages/);
});

test('new snapshots include team messages in v3 format', async () => {
  const db = { async tx(callback) {
    return callback(async (sql, params) => {
      if (/^SET TRANSACTION /.test(sql)) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ ready: params[0] }] };
      const m = /^SELECT \* FROM ([a-z_]+)$/.exec(sql);
      if (!m) throw new Error('Unexpected query: ' + sql);
      return { rows: m[1] === 'team_messages' ? [{ id: 3, body: 'hello' }] : [] };
    });
  }};
  const snapshot = await backup.snapshot(db);
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.tables.team_messages[0].body, 'hello');
  assert.doesNotThrow(() => backup.validate(snapshot));
});
