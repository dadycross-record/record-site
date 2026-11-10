'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Pool } = require('../lib/pg');
const backup = require('../lib/backup');

test('incomplete backup is rejected before any database operation', async () => {
  let called = false;
  await assert.rejects(backup.restore({ tx() { called = true; } }, { app: 'record-site', version: 1, tables: {} }));
  assert.equal(called, false);
});

test('PostgreSQL: children, guardian links, rollback and sequences survive recovery', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /_security_test$/);
  const db = new Pool(url.toString(), 2);
  try {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const schema = source.match(/const SCHEMA = `([\s\S]*?)`;/)[1];
    for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.query(statement);
    await db.query("INSERT INTO users(id,email) VALUES (7,'parent@example.test')");
    await db.query("INSERT INTO kids(id,first,last,owner_user) VALUES ('kidtest','Test','Child',7)");
    await db.query("INSERT INTO kid_guardians(kid_id,user_id) VALUES ('kidtest',7)");
    const dump = JSON.parse(JSON.stringify(await backup.snapshot(db)));
    await db.query("UPDATE kids SET first='changed'");
    await backup.restore(db, dump);
    assert.equal((await db.query('SELECT first FROM kids')).rows[0].first, 'Test');
    assert.equal((await db.query('SELECT user_id FROM kid_guardians')).rows[0].user_id, 7);
    assert.equal((await db.query("INSERT INTO users(email) VALUES ('next@example.test') RETURNING id")).rows[0].id, 8);
    const broken = structuredClone(dump);
    broken.tables.users[0].missing_column = 'invalid';
    await assert.rejects(backup.restore(db, broken));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kid_guardians')).rows[0].n, 1);
  } finally { for (const c of db.idle) c.sock.end(); }
});
