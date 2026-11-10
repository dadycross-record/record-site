'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

test('profile statistics separate parent, children, shared and transferred history', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  const helpers = html.slice(html.indexOf('function performanceGroups(){'), html.indexOf('function myPlace(o){'));
  const context = vm.createContext({
    ME: { kids: [{ id: 'kid1', first: 'Child', last: 'One' }, { id: 'kid2', first: 'Child', last: 'Two' }] },
    ORDERS: [
      { id: 'adult', who: 'me', self: true, status: 'paid', event: 'ended', place: 5 },
      { id: 'child', who: 'kid1', self: false, status: 'paid', event: 'ended', place: 1 },
      { id: 'shared', who: 'kid2', self: false, mine: false, status: 'paid', event: 'next', place: 3 },
      { id: 'transferred', who: 'oldkid', self: true, status: 'paid', event: 'ended', place: 2 },
      { id: 'cancelled', who: 'kid1', self: false, status: 'cancelled', event: 'next', place: 1 },
    ],
    ACTIVE_ST: ['paid'], EVENTS: [{ id: 'ended', status: 'ended' }, { id: 'next', status: 'open' }],
    myPlace: order => order.place, esc: s => String(s).replace(/</g, '&lt;'),
  });
  vm.runInContext(helpers, context);
  const groups = vm.runInContext('performanceGroups()', context);
  assert.deepEqual(Array.from(groups[0].orders, o => o.id), ['adult', 'transferred']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.performanceStats(groups[0].orders))), { starts: 2, upcoming: 0, best: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.performanceStats(groups[1].orders))), { starts: 1, upcoming: 0, best: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.performanceStats(groups[2].orders))), { starts: 1, upcoming: 1, best: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(context.performanceStats([]))), { starts: 0, upcoming: 0, best: null });
  assert.match(context.performanceCard(groups[0]), /data-performer="self"/);
  const source = fs.readFileSync(require.resolve('../src/index.src.html'), 'utf8');
  assert.equal(source.slice(source.indexOf('function performanceGroups(){'), source.indexOf('function myPlace(o){')), helpers);
});
