'use strict';
function duration(workout,value) {
  const cap=Number(workout.cap)>0?Number(workout.cap):null;
  if(workout.type==='time'&&typeof value==='number'&&value>0) return {seconds:cap?Math.min(value,cap):value,basis:'Фактическое время'};
  if(cap) return {seconds:cap,basis:'Таймкап'};
  return {seconds:null,basis:'Время не задано'};
}
function summarize(rows) {
  const groups=new Map();
  for(const row of rows){const key=row.judge_id||row.judge_name.trim().toLocaleLowerCase('ru');if(!groups.has(key))groups.set(key,{judge:row.judge_name,heats:0,seconds:0,unknown:0});const g=groups.get(key);g.heats++;if(row.seconds===null)g.unknown++;else g.seconds+=row.seconds;}
  return [...groups.values()].sort((a,b)=>a.judge.localeCompare(b.judge,'ru'));
}
module.exports={duration,summarize};
