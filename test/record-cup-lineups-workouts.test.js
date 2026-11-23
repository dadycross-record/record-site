'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const archive = require('../data/record-cup-teams-2026.json');

const archiveResults = Object.values(archive.results).flat();

test('RECORD CUP preserves 97 historical team results and exactly two names for verified pairs', () => {
  assert.equal(archiveResults.length, 97);
  const withMembers = archiveResults.filter(row => Array.isArray(row.team));
  assert.equal(withMembers.length, 96);
  assert.equal(withMembers.filter(row => row.team.length === 2).length, 94);
  assert.equal(withMembers.filter(row => row.team.length === 1).length, 2);
  assert.equal(archive.results['kids-6-7-m'].find(row => row.n === 'МиниСпартанцы').lineupUnverified, 'РоманиТукаленко');
  assert.equal(archive.results['am-mm35'].find(row => row.n === 'Авантюристы').team, undefined);
  for (const row of withMembers) {
    assert.ok(row.team.length === 1 || row.team.length === 2);
    assert.ok(row.team.every(name => typeof name === 'string' && name.trim().split(/\s+/).length >= 2));
  }
});

test('every division gets its original workout count and supplied protocols are category-specific', () => {
  const workouts = archive.event.workouts;
  assert.equal(workouts.filter(w => w.body?.length).length, 16);
  for (const div of archive.event.divisions) {
    const own = workouts.filter(w => w.divs.includes(div.id));
    assert.equal(own.length, div.id.startsWith('kids') ? 3 : 5, div.id);
    assert.ok(own.every(w => w.type === 'protocol'));
  }
  assert.ok(archive.event.sections.some(s => s.k === 'wods' && s.on === true));
});

test('published archive uses current protocols and shows verified lineups in the expanded leaderboard row', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(server, /cupEvent\.workouts\s*=\s*recordCup\.event\.workouts/);
  assert.match(html, /Состав команды/);
  assert.match(html, /Состав команды пока не подтверждён/);
});
