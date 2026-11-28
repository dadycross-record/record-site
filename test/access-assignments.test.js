'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Pool } = require('../lib/pg');
const { EVENT_ID } = require('../lib/race-heats');

const base = process.env.TEST_ACCESS_URL;
const database = process.env.TEST_ACCESS_DATABASE_URL;

test('access assignments take effect and can be revoked on the same session', { skip: !base || !database }, async () => {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  assert.equal(new URL(database).hostname, '127.0.0.1');
  assert.match(new URL(database).pathname, /_security_test$/);
  const db = new Pool(database, 1);
  const sha = token => createHash('sha256').update(token).digest('hex');
  const ownerEmail = 'owner@example.test';
  const judgeEmail = 'access-judge@example.test';
  async function account(email, token, profile) {
    const { rows: [user] } = await db.query(
      'insert into users(email,profile) values($1,$2) on conflict(email) do update set profile=excluded.profile returning id::text',
      [email, profile]);
    await db.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 hour')
      on conflict(token_hash) do update set expires_at=excluded.expires_at`, [sha(token), user.id]);
    return user.id;
  }
  async function api(token, path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method, headers: { Cookie: 'sid=' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  }
  let judgeId, originalContent;
  try {
    originalContent = (await db.query('select data,updated_at from content where id=1')).rows[0];
    const content = structuredClone(originalContent.data);
    if (!content.EVENTS.some(event => event.id === EVENT_ID)) {
      content.EVENTS.push({ ...content.EVENTS[0], id: EVENT_ID });
      await db.query('update content set data=$1 where id=1', [content]);
    }
    await account(ownerEmail, 'access-owner', {});
    judgeId = await account(judgeEmail, 'access-judge', { first: 'Вячеслав', last: 'Судейский' });
    assert.equal((await api('access-judge', '/api/admin/access')).status, 403);
    assert.equal((await api('access-owner', '/api/admin/access/accounts?q=' + encodeURIComponent('Вячеслав Судейский'))).data.accounts[0].id, judgeId);
    for (const role of ['judge', 'head_judge']) {
      const body = { account: judgeId, event: EVENT_ID, role };
      assert.equal((await api('access-owner', '/api/admin/access', 'POST', body)).status, 200);
      assert.equal((await api('access-owner', '/api/admin/access', 'POST', body)).status, 200);
    }
    const session = (await api('access-judge', '/api/session')).data.user;
    assert.deepEqual(session.headEvents, [EVENT_ID]);
    assert.deepEqual(session.judgeEvents, []);
    const state = await api('access-judge', '/api/admin/state');
    assert.equal(state.status, 200);
    assert.equal(state.data.ACCESS, undefined);
    assert.equal((await api('access-judge', '/api/admin/access', 'POST', { account: judgeId, role: 'admin' })).status, 403);
    const assignments = (await api('access-owner', '/api/admin/access')).data.assignments.filter(a => a.email === judgeEmail);
    assert.equal(assignments.length, 1);
    assert.equal((await api('access-owner', '/api/admin/access/' + assignments.find(a => a.role === 'head_judge').id, 'DELETE')).status, 200);
    assert.equal((await api('access-judge', '/api/admin/state')).status, 403);
    assert.equal((await api('access-judge', '/api/admin/race/heats/' + EVENT_ID, 'POST', { action: 'configure' })).status, 403);
    assert.equal((await api('access-owner', '/api/admin/access', 'POST', { account: judgeId, role: 'admin' })).status, 200);
    assert.equal((await api('access-judge', '/api/session')).data.user.role, 'admin');
    assert.equal((await api('access-owner', '/api/admin/staff/' + encodeURIComponent(judgeEmail), 'DELETE')).status, 200);
    assert.equal((await api('access-judge', '/api/session')).data.user.role, 'athlete');
  } finally {
    if (judgeId) {
      await db.query('delete from crew where user_id=$1', [judgeId]);
      await db.query('delete from staff where email=$1', [judgeEmail]);
      await db.query('delete from users where id=$1', [judgeId]);
    }
    if (originalContent) await db.query('update content set data=$1,updated_at=$2 where id=1', [originalContent.data,originalContent.updated_at]);
    for (const connection of db.idle) connection.sock.end();
  }
});
