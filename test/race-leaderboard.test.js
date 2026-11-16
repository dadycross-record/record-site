'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {raceBoard,ageOn,ageBand}=require('../lib/race-leaderboard');
const event={
 id:'evmvwkp907',name:'RECORD RACE',date:'2026-12-12',dateEnd:'2026-12-13',
 divisions:[
 {id:'race26-ind-f',name:'Женщины',type:'ind'},
 {id:'race26-ind-fpro',name:'Женщины Профессионалы',type:'ind'},
 {id:'race26-pair-m',name:'Пары мужчины',type:'team'},
 {id:'race26-relay-m',name:'Эстафета мужчины',type:'team'},
 {id:'race26-first-f',name:'Первый старт женщины',type:'ind'}
 ],
 workouts:['race26-ind-f','race26-ind-fpro','race26-pair-m','race26-relay-m','race26-first-f'].map(id=>({id:'w-'+id,day:id.includes('pair')||id.includes('relay')?'2026-12-13':'2026-12-12',type:'time',divs:[id]}))
};
function reg(id,div,dob,extra={}){
 return {id,pub:'P'+id,event_id:event.id,div_id:div,status:'paid',
 person:{first:id,last:'Тест',dob,gender:'F'},...extra};
}
function sc(rid,div,seconds){return {reg_id:rid,workout_id:'w-'+div,value:seconds,state:'accepted'};}
test('ages use competition day, and fractional average stays in correct five-year band',()=>{
 assert.equal(ageOn('1986-12-13','2026-12-12'),39);
 assert.equal(ageOn('1986-12-13','2026-12-13'),40);
 assert.equal(ageBand(39.5),3);
 assert.equal(ageBand(49.5),5);
 assert.equal(ageBand(24.5),0);
});
test('absolute standings are independent from age groups, and underfilled bands move younger',()=>{
 const d='race26-ind-f';
 const rr=[reg('a',d,'1980-01-01'),reg('b',d,'1986-01-01'),reg('c',d,'1987-01-01'),reg('d',d,'1995-01-01')];
 const s=[sc('a',d,300),sc('b',d,400),sc('c',d,500),sc('d',d,350)];
 const board=raceBoard(event,rr,s).divisions.find(x=>x.id===d);
 assert.equal(board.entries.find(r=>r.name.startsWith('a ')).absolutePlace,1);
 assert.equal(board.entries.find(r=>r.name.startsWith('d ')).absolutePlace,2);
 assert.equal(board.entries.find(r=>r.name.startsWith('a ')).ageGroup,'35–49');
 assert.equal(board.entries.find(r=>r.name.startsWith('b ')).ageGroup,'35–49');
 assert.equal(board.entries.find(r=>r.name.startsWith('c ')).ageGroup,'35–49');
 assert.equal(board.entries.find(r=>r.name.startsWith('a ')).agePlace,1);
 assert.equal(board.entries.find(r=>r.name.startsWith('d ')).ageEstablished,false);
});
test('PRO and standard divisions cannot mix; result requires accepted state',()=>{
 const rr=[reg('a','race26-ind-f','1980-01-01'),reg('b','race26-ind-fpro','1980-01-01')];
 const s=[sc('a','race26-ind-f',300),{...sc('b','race26-ind-fpro',200),state:'pending'}];
 const r=raceBoard(event,rr,s);
 assert.equal(r.divisions.find(x=>x.id==='race26-ind-f').entries[0].seconds,300);
 assert.equal(r.divisions.find(x=>x.id==='race26-ind-fpro').entries[0].seconds,null);
});
test('pair age is average; incomplete pair is not ranked or counted in quorum',()=>{
 const d='race26-pair-m';
 const rr=[reg('a',d,'1986-01-01',{team:'A'}),reg('b',d,'1996-01-01',{team:'A'}),reg('c',d,'1980-01-01',{team:'B'})];
 const board=raceBoard(event,rr,[sc('a',d,1000)]).divisions.find(x=>x.id===d);
 const a=board.entries.find(x=>x.name==='A'),b=board.entries.find(x=>x.name==='B');
 assert.equal(a.age,35);
 assert.equal(a.complete,true);
 assert.equal(a.seconds,1000);
 assert.equal(b.complete,false);
 assert.equal(b.absolutePlace,null);
});
test('relay has only under 40 and 40+ categories',()=>{
 const d='race26-relay-m';
 const rr=[21,40,38,58].map((age,i)=>reg('r'+i,d,String(2026-age)+'-01-01',{team:'R'}));
 const r=raceBoard(event,rr,[]).divisions.find(x=>x.id===d);
 assert.equal(r.entries[0].ageGroup,'до 40');
});
