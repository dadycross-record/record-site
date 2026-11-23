'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const history = require('../lib/archive-history');
const cup = require('../data/record-cup-teams-2026.json');

test('RECORD CUP archive matches exact athlete name without creating registrations', () => {
  assert.equal(history.archiveEntries(cup).length, 190);
  const correct = history.historyForPerson(cup, { first:'Роман', last:'Тукаленко', dob:'2018-01-01', gender:'M' });
  assert.equal(correct.length, 1);
  assert.equal(correct[0].team, 'МиниСпартанцы');
  assert.equal(correct[0].place, 2);
  assert.equal(correct[0].workouts.length, 3);
  assert.equal(history.historyForPerson(cup, { first:'Пётр', last:'Тукаленко', dob:'2018-01-01' }).length, 0);
  assert.equal(history.historyForPerson(cup, { first:'Роман', last:'Тукаленко', dob:'1988-01-01' }).length, 0);
  assert.equal(cup.results['kids-10-12-m'].some(row=>row.n.startsWith('Гугу-Гага')), false);
});

test('BAZA GAMES archive is read-only and requires exact first/last name', () => {
  const ev = { id:'bazagames26', name:'BAZA GAMES 2026', status:'ended', date:'2026-01-08',
    divisions:[{id:'am',name:'Мужчины'},{id:'ty',name:'Подростки'}] };
  const rows=[
    {pub:'public-1',event_id:'bazagames26',div_id:'am',person:{first:'Андрей',last:'Громов',gender:'M'}},
    {pub:'public-2',event_id:'bazagames26',div_id:'ty',person:{first:'Илья',last:'Петров',gender:'M'}},
  ];
  const adult=history.historyForLegacyRows(rows,{last:'Громов',first:'Андрей',gender:'M',dob:'1990-10-11'},[ev],'self');
  assert.equal(adult.length,1);
  assert.equal(adult[0].pub,'public-1');
  assert.equal(adult[0].who,'self');
  assert.equal(adult[0].source,'historical-registration');
  assert.equal(history.historyForLegacyRows(rows,{first:'Андрей',last:'Громов',gender:'F'},[ev]).length,0);
  assert.equal(history.historyForLegacyRows(rows,{first:'Антон',last:'Громов'},[ev]).length,0);
  assert.equal(history.historyForLegacyRows(rows,{first:'Андрей',last:'Громов',dob:'2018-11-01'},[ev]).length,0);
  const teen=history.historyForLegacyRows(rows,{first:'Илья',last:'Петров',dob:'2012-06-01'},[ev],'kid1');
  assert.equal(teen.length,1);
  assert.equal(teen[0].who,'kid1');
  assert.equal(rows[0].pub,'public-1'); // fixture remains unchanged
});

test('Client and server expose the same history in athlete and organizer accounts', () => {
  const js = fs.readFileSync(require.resolve('../server.js'),'utf8');
  const html = fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  const source=fs.readFileSync(require.resolve('../src/index.src.html'),'utf8');
  assert.match(js,/async function unlinkedHistoryForPeople/);
  assert.match(js,/\.\.\.\(await unlinkedHistoryForPeople\(/);
  assert.match(js,/archived: \[\.\.\.archiveHistory\.historyForPerson/);
  assert.match(html,/function archivedHistoryCards\(history\)/);
  assert.match(html,/function archivedPerformance\(h\)/);
  assert.match(html,/Архивные выступления/);
  assert.match(html,/async r=>\{ Object\.assign\(ME,r\.profile\)/);
  assert.equal(source.slice(source.indexOf('function archivedPerformance(h)'),source.indexOf('function myPlace(o){')),
    html.slice(html.indexOf('function archivedPerformance(h)'),html.indexOf('function myPlace(o){')));
});
