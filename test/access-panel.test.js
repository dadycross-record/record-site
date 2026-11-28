'use strict';

const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');

for (const path of ['public/index.html', 'src/index.src.html']) {
  test(path + ' prioritizes leading roles and archives completed assignments', () => {
    const source = readFileSync(path, 'utf8');
    const render = source.match(/function accessPanel\(\)\{[\s\S]+?\n\}(?=\nfunction syncAccess)/)[0];
    const EVENTS = [
      { id: 'current', status: 'open', name: 'Текущий старт' },
      { id: 'finished', status: 'ended', name: 'Прошедший старт' }
    ];
    const html = vm.runInNewContext(render + '\naccessPanel()', {
      adm: { access: { role: 'head_judge', assignments: [
        { name: 'Действующий судья', role: 'judge', id: '1', event: 'current' },
        { name: 'Архивный судья', role: 'judge', id: '2', event: 'finished' },
        { name: 'Архивный главный', role: 'head_judge', id: '3', event: 'finished' },
        { name: 'Действующий главный', role: 'head_judge', id: '4', event: 'current' },
        { name: 'Действующий организатор', role: 'admin' }
      ] } },
      EVENTS, S: { viewAs: 'owner' }, ROLE_L: { admin: 'Организатор', head_judge: 'Главный судья', judge: 'Судья' },
      esc: value => String(value ?? ''), fErr: () => '',
      pastStart: id => EVENTS.find(e => e.id === id)?.status !== 'open'
    });
    const [active, archive] = html.split('<details');
    assert.ok(archive);
    assert.match(active, /Действующий организатор[\s\S]*Действующий главный[\s\S]*Действующий судья/);
    assert.doesNotMatch(active, /Архивный|<option value="finished"/);
    assert.match(archive, /Архивный главный[\s\S]*Архивный судья/);
    assert.doesNotMatch(archive, /data-access-revoke/);
  });
}

test('an unsuccessful list request displays its own retry action', async () => {
  const source = readFileSync('public/index.html', 'utf8');
  const panel = source.match(/function accessPanel\(\)\{[\s\S]+?\n\}(?=\nfunction syncAccess)/)[0];
  const update = source.match(/async function updateAccess[\s\S]+?\n\}(?=\n\n)/)[0];
  const state = {};
  const context = vm.createContext({
    adm: { access: state }, syncAccess: () => state, render: () => {},
    api: async () => { throw Error('Нет связи с сервером'); },
    EVENTS: [], S: { viewAs: 'owner' }, ROLE_L: {}, esc: String, fErr: () => ''
  });
  await vm.runInContext(panel + '\n' + update + '\nupdateAccess("list")', context);
  const html = vm.runInContext('accessPanel()', context);
  assert.match(html, /Нет связи с сервером/);
  assert.match(html, /data-act="accessReload"/);
  assert.doesNotMatch(html, /Загружаю назначения/);
});
