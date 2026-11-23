'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('archived leaderboards preserve ties, incomplete placings and recorded workout results', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const impl = html.slice(html.indexOf('function leaderboard('), html.indexOf('/* ---------- state & routing'));
  const workouts = [{ type: 'protocol' }, { type: 'protocol' }];
  const event = { id: 'cup', publishedArchive: true, workouts };
  const results = { 'cup:mixed': [
    { n: 'Unplaced', place: null, pts: 6, r: ['4+2', null], wr: [6, null] },
    { n: 'First tied', place: 4, pts: 25, r: ['04:28,46', '07:29,15'], wr: [5, 4] },
    { n: 'Second tied', place: 4, pts: 25, r: ['04:24,11', '06:24,62'], wr: [7, 3] },
  ] };
  const c = vm.createContext({
    EVENTS: [event],
    allResults: () => results,
    lbEv: ev => ev,
    resKey: (ev, div) => ev.id + ':' + div,
    esc: value => String(value).replace(/</g, '&lt;'),
    rankWorkout: () => { throw new Error('Archive ranks must not be recalculated'); },
  });
  vm.runInContext(impl, c);
  const { rows } = c.leaderboard('cup', 'mixed');
  assert.deepEqual(Array.from(rows, r => [r.n, r.place, r.pts]), [
    ['First tied', 4, 25],
    ['Second tied', 4, 25],
    ['Unplaced', null, 6],
  ]);
  assert.deepEqual(rows[2].wr, [6, null]);
  assert.equal(c.fmtRes('protocol', '4+2'), '4+2');
  assert.equal(c.fmtRes('protocol', '<'), '&lt;');
});
