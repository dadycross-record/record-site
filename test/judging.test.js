'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {duration,summarize}=require('../lib/judging');
test('judging uses actual time, the workout cap or explicitly unknown time',()=>{
  assert.deepEqual(duration({type:'time',cap:600},123.45),{seconds:123.45,basis:'Фактическое время'});
  assert.equal(duration({type:'time',cap:600},{cap:42}).seconds,600);
  assert.equal(duration({type:'time',cap:600},700).seconds,600);
  assert.equal(duration({type:'reps',cap:300},42).seconds,300);
  assert.equal(duration({type:'load'},100).seconds,null);
});
test('judging summary counts every athlete/workout once and flags unknown durations',()=>{
  const totals=summarize([{judge_id:'crew:1',judge_name:'Judge',seconds:120},{judge_id:'crew:1',judge_name:'Judge',seconds:300},{judge_id:'',judge_name:'External',seconds:null}]);
  const judge=totals.find(t=>t.judge==='Judge');assert.equal(judge.heats,2);assert.equal(judge.seconds,420);assert.equal(totals.find(t=>t.judge==='External').unknown,1);
});
