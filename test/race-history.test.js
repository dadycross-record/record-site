'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { raceHistory } = require('../lib/race-history');

test('history uses athlete identity across years and categories and counts unique finished starts', () => {
  const events = [2025, 2026, 2027].map(year => ({
    id: 'event-' + year, name: 'RECORD RACE', raceMode: 'race', date: year + '-12-12',
    status: year === 2027 ? 'draft' : 'ended',
    divisions: ['m', 'mpro'].map(d => ({ id: 'race' + String(year).slice(2) + '-ind-' + d, name: d })),
    workouts: ['m', 'mpro'].map(d => ({ id: d, type: 'time', divs: ['race' + String(year).slice(2) + '-ind-' + d] }))
  }));
  const regs = [
    ['old',2025,'m',7], ['now',2026,'mpro',7], ['double',2026,'m',7],
    ['other',2026,'mpro',8], ['hidden',2027,'m',7]
  ].map(([id,year,division,user_id]) => ({
    id,pub:id,event_id:'event-'+year,div_id:'race'+String(year).slice(2)+'-ind-'+division,
    who:'me',user_id,status:'paid',person:{first:'Иван',last:'Иванов',dob:'1990-01-01'}
  }));
  const scores = regs.map((r,i)=>({reg_id:r.id,workout_id:r.div_id.split('-').at(-1),state:'accepted',value:4000-i*10}));
  const index = raceHistory(events, regs, scores);
  assert.equal(index.boards.get('event-2026').divisions[1].entries.find(r=>r.id==='now').raceCount,2);
  assert.equal(index.boards.has('event-2027'),false);
  assert.deepEqual(index.forRegistration('now').map(r=>[r.eventId,r.level,r.seconds]),[
    ['event-2026','standard',3980],['event-2026','pro',3990],['event-2025','standard',4000]
  ]);
  assert.equal(index.forRegistration('other').length,1);
  assert.equal(index.boards.get('event-2026').divisions[1].entries.some(r=>'userId' in r),false);
});
