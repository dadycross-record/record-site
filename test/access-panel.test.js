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
