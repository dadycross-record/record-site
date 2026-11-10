'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {crewStatistics}=require('../lib/crew-statistics');
test('crew summary preserves roles, counts starts and keeps actual payments separate',()=>{
 const crew=[{id:1,user_id:7,name:'Test Judge',event_id:'one',role:'judge',status:'confirmed',rate:1000,work:{'2026-01-01':{k:'full'}},info:{position:'Старший судья',paidAmount:700}},{id:2,user_id:7,name:'Test Judge',event_id:'two',role:'assistant',status:'confirmed',rate:1000,work:{'2026-01-02':{k:'half'}},info:{position:'Секретарь'}}];
 const events=['one','two'].map(id=>({id,workouts:[{id:'w',type:'time',cap:600}]}));
 const scores=[{event_id:'one',judge_id:'crew:1',judge_name:'Test Judge',workout_id:'w',value:120},{event_id:'two',judge_id:'crew:2',judge_name:'Test Judge',workout_id:'w',value:300},{event_id:'one',judge_id:'',judge_name:'External',workout_id:'w',value:90}];
 const rows=crewStatistics(crew,scores,events,{}),person=rows.find(r=>r.key==='user:7');
 assert.equal(person.starts,2);assert.equal(person.heats,2);assert.equal(person.judgingSeconds,420);assert.equal(person.onsiteSeconds,12*3600);assert.equal(person.accrued,1500);assert.equal(person.paid,700);assert.equal(person.paymentUnknown,1);assert.deepEqual(person.positions,['Старший судья','Секретарь']);
 assert.equal(rows.find(r=>r.name==='External').paymentKnown,0);
});
