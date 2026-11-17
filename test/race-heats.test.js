'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const H=require('../lib/race-heats');
const event={id:H.EVENT_ID,date:'2026-12-12',dateEnd:'2026-12-13',divisions:[
 {id:'race26-k8-f',name:'Дети 8–9',type:'ind'},
 {id:'race26-ind-f',name:'Женщины OPEN',type:'ind'},
 {id:'race26-pair-f',name:'Пары женщины OPEN',type:'team',size:2}]};
const r=(id,div,team,status='new')=>({id,event_id:event.id,div_id:div,team,status,created_at:'2026-11-17T10:'+String(id).padStart(2,'0')+':00',person:{last:'Тест',first:id}});
const rows=[...Array.from({length:7},(_,i)=>r(''+(i+1),'race26-ind-f')),r('8','race26-k8-f'),r('9','race26-pair-f','A'),r('10','race26-pair-f','A')];
test('race heat draft packs at most six athlete places, every ten minutes and by category',()=>{
 const b=H.build(event,rows,{});
 assert.equal(b.days[event.date].length,8);
 assert.equal(b.days[event.dateEnd].length,1);
 assert.equal(b.days[event.dateEnd][0].size,2);
 for(const day of Object.values(b.days))for(const e of day)assert.ok(e.lane+e.size<=7);
 const first=b.days[event.date].filter(x=>x.wave===1);
 assert.equal(new Set(first.map(x=>x.divId)).size,1);
 assert.equal(b.days[event.date].find(x=>x.wave===2).start,'09:10');
});
test('publication locks existing start time and number when late athletes arrive',()=>{
 const saved=H.publish(event,rows,{},event.date);
 const first=H.build(event,rows,saved).days[event.date].find(x=>x.key==='reg:2');
 const changed=H.build(event,[...rows,r('11','race26-ind-f')],saved).days[event.date].find(x=>x.key==='reg:2');
 assert.deepEqual([first.wave,first.lane,first.number],[changed.wave,changed.lane,changed.number]);
});
test('manual moves are staged, not visible publicly, then applied on full republish',()=>{
 const initial=H.publish(event,rows,{},event.date);
 const stable=H.build(event,rows,initial).days[event.date].find(x=>x.key==='reg:2');
 const draft=H.move(event,rows,initial,'reg:2',event.date,9,1);
 assert.equal(H.build(event,rows,draft).days[event.date].find(x=>x.key==='reg:2').wave,stable.wave);
 assert.equal(H.build(event,rows,draft,true).days[event.date].find(x=>x.key==='reg:2').wave,9);
 const published=H.publish(event,rows,draft,event.date,true);
 assert.equal(H.build(event,rows,published).days[event.date].find(x=>x.key==='reg:2').wave,9);
});
test('late team joins only once roster is complete and occupies two lanes',()=>{
 const partial=H.build(event,rows.filter(x=>x.id!=='10'),{});
 assert.equal(partial.days[event.dateEnd].length,0);
 assert.equal(H.build(event,rows,{}).days[event.dateEnd][0].size,2);
});
test('moving into an occupied spot raises a conflict',()=>{
 const saved=H.publish(event,rows,{},event.date);
 const original=H.build(event,rows,saved).days[event.date];
 const one=original.find(x=>x.key==='reg:1'),two=original.find(x=>x.key==='reg:2');
 assert.throws(()=>H.move(event,rows,saved,two.key,event.date,one.wave,one.lane),/Конфликт/);
});

test('six singles, three doubles or three four-person relay teams start per wave',()=>{
 const ev={id:H.EVENT_ID,date:'2026-12-12',dateEnd:'2026-12-13',divisions:[
  {id:'race26-ind-f',name:'Женщины OPEN',type:'ind'},
  {id:'race26-pair-f',name:'Двойки OPEN',type:'team',size:2},
  {id:'race26-relay-f',name:'Эстафеты',type:'team',size:4}
 ]};
 const regs=[];
 for(let i=1;i<=7;i++)regs.push(r(String(i),'race26-ind-f'));
 for(let i=1;i<=4;i++)for(let j=1;j<=2;j++)regs.push(r('p'+i+j,'race26-pair-f','Двойка-'+i));
 for(let i=1;i<=4;i++)for(let j=1;j<=4;j++)regs.push(r('e'+i+j,'race26-relay-f','Четвёрка-'+i));
 const b=H.build(ev,regs,{});
 const firstDay=b.days[ev.date],secondDay=b.days[ev.dateEnd];
 assert.equal(firstDay.filter(x=>x.wave===1).length,6);
 assert.equal(firstDay.filter(x=>x.wave===2).length,1);
 const doubles=secondDay.filter(x=>x.divId==='race26-pair-f');
 const relays=secondDay.filter(x=>x.divId==='race26-relay-f');
 assert.equal(doubles.filter(x=>x.wave===1).length,3);
 assert.equal(doubles.filter(x=>x.wave===2).length,1);
 assert.equal(relays.filter(x=>x.wave===3).length,3);
 assert.equal(relays.filter(x=>x.wave===4).length,1);
 assert.deepEqual(relays.filter(x=>x.wave===3).map(x=>x.lane),[1,2,3]);
 assert.ok(secondDay.every(x=>x.lane<=3));
 assert.ok(secondDay.every(x=>!secondDay.some(y=>y.wave===x.wave&&y.divId!==x.divId)));
 assert.throws(()=>H.move(ev,regs,{},relays[0].key,ev.dateEnd,3,4),/Неверный заход/);
 assert.throws(()=>H.move(ev,regs,{},relays[0].key,ev.dateEnd,1,1),/другой дивизион/);
});
