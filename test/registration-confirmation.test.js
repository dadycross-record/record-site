'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

test('registration confirmation shows team search and Telegram only for team divisions', () => {
  const source = readFileSync('public/index.html', 'utf8');
  const screen = source.match(/^done\(\)\{[\s\S]*?\n\},(?=\nfail\()/m)[0];
  function render(type) {
    return vm.runInNewContext('({' + screen + '}).done().html', {
      ORDERS: [{ id: 'reg', event: 'race', div: 'division', who: 'me', status: 'new' }],
      EVENTS: [{ id: 'race', name: 'RECORD RACE', divisions: [{ id: 'division', name: 'Категория', type }] }],
      USER: null, S: {}, esc: String, fmtRub: () => '', isRaceEvent: () => false,
      finderLinks: () => '<button>Найти команду</button><a>Telegram</a>'
    });
  }
  const solo = render('ind');
  const team = render('team');
  assert.match(solo, /Заявка принята/);
  assert.doesNotMatch(solo, /Найти команду|Telegram/);
  assert.match(team, /Найти команду/);
  assert.match(team, /Telegram/);
});
