'use strict';
// RECORD RACE heats are separate from the CrossFit leaderboard and score engine.
const EVENT_ID='evmvwkp907';
const ACTIVE=new Set(['new','paid','refund_requested']);
const DEFAULT_ORDER=[
 'race26-k8-f','race26-k8-m','race26-k10-f','race26-k10-m',
 'race26-k12-f','race26-k12-m','race26-k14-f','race26-k14-m',
 'race26-first-f','race26-first-m','race26-ind-f','race26-ind-m',
 'race26-ind-fpro','race26-ind-mpro',
 'race26-pair-f','race26-pair-mix','race26-pair-m',
 'race26-pair-fpro','race26-pair-mpro','race26-forces',
 'race26-relay-f','race26-relay-mix','race26-relay-m'
];
const dayOf=(ev,d)=>{
 const days=[ev.date,ev.dateEnd||ev.date];
 if(Array.isArray(d.days)&&d.days.length) return d.days[0];
 // Day one: children, individual and first start. Day two: pairs and relays.
 return (d.type==='team'?days[1]:days[0]);
};
const fmtTime=(minutes)=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
function parseTime(v){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v||'')))return null;const [h,m]=v.split(':').map(Number);return h*60+m;}
const entryName=r=>[r.person?.last,r.person?.first].filter(Boolean).join(' ').trim()||'Участник';
function participants(ev,regs){
 const divs=new Map(ev.divisions.map(d=>[d.id,d]));const individuals=[],teams=new Map();
 for(const r of regs){
  if(!ACTIVE.has(r.status)||r.event_id!==ev.id||!divs.has(r.div_id))continue;
  const d=divs.get(r.div_id),day=dayOf(ev,d);
  if(d.type==='team'){
   if(!r.team)continue;
   const key=r.div_id+'|'+r.team.trim().toLocaleLowerCase('ru');
   if(!teams.has(key))teams.set(key,{key:'team:'+key,divId:d.id,day,name:r.team,persons:[],created:r.created_at,team:true,size:Number(d.size)||2});
   teams.get(key).persons.push(r);
  }else individuals.push({key:'reg:'+r.id,divId:d.id,day,name:entryName(r),ids:[r.id],size:1,created:r.created_at,team:false});
 }
 const valid=[...individuals];
 for(const t of teams.values()){
  if(t.persons.length!==t.size)continue;
  t.ids=t.persons.map(r=>r.id);t.created=t.persons.map(r=>r.created_at).sort()[0];valid.push(t);
 }
 return valid.sort((a,b)=>String(a.created||'').localeCompare(String(b.created||''))||a.key.localeCompare(b.key));
}
const settingsFor=(ev,data)=>{
 const days=[...new Set([ev.date,ev.dateEnd||ev.date])];
 const cfg=data&&typeof data==='object'?data:{};
 const start=cfg.start&&typeof cfg.start==='object'?cfg.start:{};
 const order=Array.isArray(cfg.order)?cfg.order.filter(id=>ev.divisions.some(d=>d.id===id)):[];
 return {start:Object.fromEntries(days.map((d,i)=>[d,parseTime(start[d])===null?(i===0?'09:00':'09:00'):start[d]])),
  order:[...new Set([...order,...DEFAULT_ORDER,...ev.divisions.map(d=>d.id)])].filter(id=>ev.divisions.some(d=>d.id===id)),
  published:cfg.published&&typeof cfg.published==='object'?cfg.published:{},
  assignments:cfg.assignments&&typeof cfg.assignments==='object'?cfg.assignments:{},
  pendingMoves:cfg.pendingMoves&&typeof cfg.pendingMoves==='object'?cfg.pendingMoves:{},
  revision:Number(cfg.revision)||0};
};
function build(ev,regs,data,preview=false){
 const cfg=settingsFor(ev,data), participantsList=participants(ev,regs), days=[...new Set([ev.date,ev.dateEnd||ev.date])];
 const byDay=Object.fromEntries(days.map(d=>[d,[]])), pending=[];
 const sorted=participantsList.slice().sort((a,b)=>cfg.order.indexOf(a.divId)-cfg.order.indexOf(b.divId)||String(a.created||'').localeCompare(String(b.created||''))||a.key.localeCompare(b.key));
 for(const day of days){
  const part=sorted.filter(x=>x.day===day);
  const old=preview?{...cfg.assignments,...cfg.pendingMoves}:cfg.assignments;
  const slots=[],assigned=new Set();
  // Preserve official published positions, except cancelled/inactive registrations.
  for(const e of part){
   const a=old[e.key];
   if(!a||a.day!==day||!Number.isInteger(a.wave)||a.wave<1||a.wave>10000||!Number.isInteger(a.lane)||a.lane<1||a.lane+e.size>7)continue;
   if(slots.some(v=>v.wave===a.wave&&a.lane<v.lane+v.size&&v.lane<a.lane+e.size))continue;
   slots.push({...e,wave:a.wave,lane:a.lane,start:fmtTime(parseTime(cfg.start[day])+10*(a.wave-1)),number:a.number||null,locked:true});assigned.add(e.key);
  }
  const add=(e)=>{
   const lastWave=slots.reduce((n,x)=>Math.max(n,x.wave),0);
   const startWave=1;
   for(let wave=startWave;wave<=Math.floor((1439-parseTime(cfg.start[day]))/10)+1;wave++){
    // Draft waves group by category to avoid changing weight between adjacent athletes.
    const existing=slots.filter(x=>x.wave===wave);
    if(!cfg.published[day]&&existing.length&&existing.some(x=>x.divId!==e.divId))continue;
    const occupied=new Set(existing.flatMap(x=>Array.from({length:x.size},(_,i)=>x.lane+i)));
    for(let lane=1;lane<=7-e.size;lane++){
     if(Array.from({length:e.size},(_,i)=>lane+i).some(x=>occupied.has(x)))continue;
     if(cfg.published[day]&&wave>lastWave+1)continue;
     slots.push({...e,wave,lane,start:fmtTime(parseTime(cfg.start[day])+10*(wave-1)),number:null,locked:false});return;
    }
   }
   pending.push(e.key);
  };
  for(const e of part)if(!assigned.has(e.key))add(e);
  slots.sort((a,b)=>a.wave-b.wave||a.lane-b.lane||a.key.localeCompare(b.key));
  byDay[day]=slots.map(e=>({...e,number:e.number||('R'+day.replace(/-/g,'').slice(4)+'-'+String((e.wave-1)*6+e.lane).padStart(3,'0'))}));
 }
 return {eventId:ev.id,days:byDay,start:cfg.start,order:cfg.order,published:cfg.published,revision:cfg.revision,pending,capacity:6,interval:10};
}
function publish(ev,regs,data,day,full=false){
 const cfg=settingsFor(ev,data);
 if(!Object.prototype.hasOwnProperty.call(cfg.start,day))throw Error('Неверная дата старта');
 if(cfg.published[day]&&!full)throw Error('Для повторного выпуска выберите полный пересчёт');
 const fresh={...cfg,published:{...cfg.published,[day]:false},assignments:{...cfg.assignments}};
 if(full){for(const [key,a] of Object.entries(fresh.assignments))if(a.day===day)delete fresh.assignments[key];}
 for(const [key,a] of Object.entries(cfg.pendingMoves))if(a.day===day)fresh.assignments[key]=a;
 const board=build(ev,regs,fresh);
 for(const e of board.days[day])fresh.assignments[e.key]={day,wave:e.wave,lane:e.lane,number:e.number};
 fresh.pendingMoves={...cfg.pendingMoves};for(const [key,a] of Object.entries(fresh.pendingMoves))if(a.day===day)delete fresh.pendingMoves[key];
 fresh.published[day]=true;fresh.revision++;
 return fresh;
}
function move(ev,regs,data,key,day,wave,lane){
 const cfg=settingsFor(ev,data);const all=participants(ev,regs),target=all.find(x=>x.key===key);
 if(!target||target.day!==day)throw Error('Участник или команда не найдены в этом дне');
 if(!Number.isInteger(wave)||wave<1||wave>10000||!Number.isInteger(lane)||lane<1||lane+target.size>7)throw Error('Неверный заход или дорожка');
 const board=build(ev,regs,cfg,true),coll=board.days[day].some(x=>x.key!==key&&x.wave===wave&&lane<x.lane+x.size&&x.lane<lane+target.size);
 if(coll)throw Error('Конфликт дорожек: этот слот занят');
 const prev=board.days[day].find(x=>x.key===key);
 if(cfg.published[day])cfg.pendingMoves={...cfg.pendingMoves,[key]:{day,wave,lane,number:prev?.number||null}};
 else cfg.assignments={...cfg.assignments,[key]:{day,wave,lane,number:prev?.number||null}};
 // Published times are unchanged until the owner explicitly republishes.
 cfg.revision++;return cfg;
}
module.exports={EVENT_ID,DEFAULT_ORDER,participants,settingsFor,build,publish,move,parseTime,fmtTime};