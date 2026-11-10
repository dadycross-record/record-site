'use strict';
const {duration}=require('./judging');
const ROLES={head_judge:'Главный судья',judge:'Судья',venue_admin:'Администратор площадки',assistant:'Ассистент организатора',volunteer:'Волонтёр'};
const normalized=s=>String(s||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');
function crewStatistics(crew,scores,events,rates){
 const people=new Map(),byCrew=new Map(),byName=new Map();
 const person=(key,name)=>{if(!people.has(key))people.set(key,{key,name,positions:new Set(),events:new Map(),heats:0,judgingSeconds:0,unknownTime:0,accrued:0,paid:0,paymentKnown:0,paymentUnknown:0});return people.get(key)};
 const event=(p,id)=>{if(!p.events.has(id))p.events.set(id,{days:new Map(),judging:0});return p.events.get(id)};
 for(const c of crew){if(c.status!=='confirmed'&&!Object.keys(c.work||{}).length&&c.info?.paidAmount==null)continue;
  const phone=String(c.phone||'').replace(/\D/g,'').slice(-10),key=c.user_id?'user:'+c.user_id:phone?'phone:'+phone:'name:'+normalized(c.name);
  const p=person(key,c.name);p.positions.add(c.info?.position||ROLES[c.role]||c.role);const e=event(p,c.event_id),cfg=rates[c.event_id]||{},shift=Number(cfg.shift_hours)||8;
  let hours=0;for(const [day,w]of Object.entries(c.work||{})){const h=w.k==='full'?shift:w.k==='half'?shift/2:w.k==='h'?Number(w.h)||0:0;hours+=h;e.days.set(day,Math.max(e.days.get(day)||0,h));}
  p.accrued+=Math.round(hours/shift*Number(c.rate??cfg.rates?.[c.role]??0));
  if(c.info?.paidAmount!=null){p.paid+=Number(c.info.paidAmount)||0;p.paymentKnown++;}else p.paymentUnknown++;
  byCrew.set('crew:'+c.id,p);const n=normalized(c.name);if(!byName.has(n))byName.set(n,new Set());byName.get(n).add(p);
 }
 for(const s of scores){let p=byCrew.get(s.judge_id);if(!p){const matches=byName.get(normalized(s.judge_name));p=matches?.size===1?[...matches][0]:person('manual:'+normalized(s.judge_name),s.judge_name);}
  const ev=events.find(e=>e.id===s.event_id),w=ev?.workouts?.find(w=>w.id===s.workout_id);if(!w)continue;
  const d=duration(w,s.value);p.heats++;if(!p.positions.size)p.positions.add('Судья (введён вручную)');const e=event(p,s.event_id);if(d.seconds===null)p.unknownTime++;else {p.judgingSeconds+=d.seconds;e.judging+=d.seconds;}
 }
 return [...people.values()].map(p=>({key:p.key,name:p.name,positions:[...p.positions],starts:p.events.size,heats:p.heats,judgingSeconds:p.judgingSeconds,unknownTime:p.unknownTime,onsiteSeconds:[...p.events.values()].reduce((n,e)=>n+(e.days.size?[...e.days.values()].reduce((a,b)=>a+b,0)*3600:e.judging),0),accrued:p.accrued,paid:p.paid,paymentKnown:p.paymentKnown,paymentUnknown:p.paymentUnknown})).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
}
module.exports={crewStatistics};
