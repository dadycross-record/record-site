'use strict';
// RECORD RACE only. This module never changes the CrossFit points leaderboard.
// Age bands are virtual standings, not registration divisions.
const ADULT_BANDS = [
  [16,24],[25,29],[30,34],[35,39],[40,44],[45,49],
  [50,54],[55,59],[60,64],[65,69],[70,74],[75,79],[80,84],[85,89]
];
const ACTIVE = new Set(['new','paid','refund_requested']);
const AGE_DIVS = new Set([
  'race26-ind-f','race26-ind-m','race26-ind-fpro','race26-ind-mpro',
  'race26-pair-f','race26-pair-m','race26-pair-mix','race26-pair-fpro','race26-pair-mpro'
]);
const KIND = {
  'race26-ind-f':['individual','standard','F'], 'race26-ind-m':['individual','standard','M'],
  'race26-ind-fpro':['individual','pro','F'], 'race26-ind-mpro':['individual','pro','M'],
  'race26-first-f':['first','standard','F'],'race26-first-m':['first','standard','M'],
  'race26-pair-f':['pair','standard','F'],'race26-pair-m':['pair','standard','M'],
  'race26-pair-mix':['pair','standard','X'],'race26-pair-fpro':['pair','pro','F'],
  'race26-pair-mpro':['pair','pro','M'],'race26-forces':['forces','pro','M'],
  'race26-relay-f':['relay','standard','F'],'race26-relay-m':['relay','standard','M'],
  'race26-relay-mix':['relay','standard','X']
};
for (const n of [8,10,12,14]) for (const g of ['f','m']) KIND['race26-k'+n+'-'+g]=['kids','standard',g==='f'?'F':'M'];

function ageOn(dob, day) {
  if (typeof dob !== 'string' || typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dob) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y,m,d]=dob.split('-').map(Number), [cy,cm,cd]=day.split('-').map(Number);
  if (m<1||m>12||d<1||d>31 || new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)!==dob) return null;
  const age=cy-y-((cm<m||(cm===m&&cd<d))?1:0);
  return age>=0&&age<120 ? age : null;
}
const ageBand = age => ADULT_BANDS.findIndex(([from,to])=>age>=from&&age<to+1);
const bandName = idx => idx>=0&&idx<ADULT_BANDS.length ? ADULT_BANDS[idx].join('–') : null;
const normalizedName = r => [r.person?.last,r.person?.first].filter(Boolean).join(' ').trim() || ('Участник '+String(r.pub||'').slice(0,6));
const scoreSeconds = value => {
  const n=typeof value==='number'?value:typeof value==='string'&&value.trim()?Number(value):NaN;
  return Number.isFinite(n)&&n>0 ? n : null;
};
const statusFor = s => s===null ? 'Ожидает результата' : 'Финишировал';
const round2=n=>Math.round(n*100)/100;
function raceBoard(event, registrations, scores) {
  if(!event || !Array.isArray(event.divisions)) throw new Error('Неизвестный старт');
  const divs=event.divisions.filter(d=>KIND[d.id]).map(d=>({...d,kind:KIND[d.id][0],level:KIND[d.id][1],gender:KIND[d.id][2]}));
  const divById=new Map(divs.map(d=>[d.id,d]));
  const workByDiv=new Map(divs.map(d=>[d.id,(event.workouts||[]).filter(w=>!w.divs?.length||w.divs.includes(d.id))]));
  const regs=registrations.filter(r=>r.event_id===event.id&&ACTIVE.has(r.status)&&divById.has(r.div_id));
  const results=new Map();
  for(const s of scores) {
    if(s.state!=='accepted')continue;
    const r=regs.find(x=>x.id===s.reg_id);
    if(!r)continue;
    const workouts=workByDiv.get(r.div_id)||[];
    if(workouts.length!==1 || workouts[0].id!==s.workout_id)continue;
    const seconds=scoreSeconds(s.value);
    if(seconds!==null)results.set(r.id,Math.min(results.get(r.id)??Infinity,seconds));
  }
  const grouped=new Map(divs.map(d=>[d.id,[]]));
  for(const d of divs){
    const rr=regs.filter(r=>r.div_id===d.id);
    const day=(workByDiv.get(d.id)||[])[0]?.day||event.date;
    if(d.type==='team'){
      const teams=new Map();
      for(const r of rr) if(r.team){const key=r.team.trim().toLocaleLowerCase('ru');if(!teams.has(key))teams.set(key,[]);teams.get(key).push(r)}
      for(const [key, members] of teams) {
        const unique=[...new Map(members.map(r=>[r.id,r])).values()];
        const required=d.kind==='relay'?4:2;
        const ages=unique.map(r=>ageOn(r.person?.dob,day));
        const complete=unique.length===required&&ages.every(a=>a!==null);
        const age=complete?ages.reduce((a,b)=>a+b,0)/required:null;
        const candidateResults=unique.map(r=>results.get(r.id)).filter(Number.isFinite);
        const seconds=complete&&candidateResults.length?Math.min(...candidateResults):null;
        const actual=complete && (d.kind==='pair'?ageBand(age):null);
        const relayGroup=complete && d.kind==='relay'?(age>=40?'40+':'до 40'):null;
        grouped.get(d.id).push({id:d.id+':'+key,divId:d.id,name:unique[0]?.team||key,
          members:unique.map(normalizedName),age:age===null?null:round2(age),baseBand:actual,
          ageBand:actual,relayGroup,complete,required,memberCount:unique.length,
          seconds,publicId:unique.map(r=>r.pub),status:!complete?'Неполный состав':statusFor(seconds)});
      }
    } else {
      const byPerson=new Map();
      for(const r of rr){
        const age=ageOn(r.person?.dob,day);
        const ident=(r.athlete_user||(r.user_id&&r.who==='me'))?('user:'+String(r.athlete_user||r.user_id)) :
          [r.person?.last,r.person?.first,r.person?.dob].map(x=>String(x||'').toLocaleLowerCase('ru')).join('|');
        const key=ident||r.id;
        const seconds=results.get(r.id)??null;
        const old=byPerson.get(key);
        if(old && (old.seconds!==null&&(seconds===null||seconds>=old.seconds)))continue;
        byPerson.set(key,{id:r.id,divId:d.id,name:normalizedName(r),age,baseBand:AGE_DIVS.has(d.id)?ageBand(age):null,
          ageBand:AGE_DIVS.has(d.id)?ageBand(age):null,relayGroup:null,complete:true,required:1,
          memberCount:1,members:[],seconds,publicId:[r.pub],status:statusFor(seconds)});
      }
      grouped.set(d.id,[...byPerson.values()]);
    }
  }
  const standings=[];
  for(const d of divs) {
    const entries=grouped.get(d.id);
    const eligible=entries.filter(r=>r.complete);
    // Merge underpopulated age groups only towards younger bands, as requested by organizer.
    // The absolute result never changes when age bands are merged.
    const merges=[];
    if(AGE_DIVS.has(d.id)){
      const memberBands=new Map(ADULT_BANDS.map((_,idx)=>[idx,[]]));
      for(const row of eligible)if(row.baseBand!==null&&row.baseBand>=0)memberBands.get(row.baseBand).push(row);
      for(let idx=ADULT_BANDS.length-1;idx>0;idx--){
        const items=memberBands.get(idx);
        if(items.length>0&&items.length<2){
          const younger=memberBands.get(idx-1);
          younger.push(...items);
          for(const row of items){row.ageBand=idx-1;merges.push({name:row.name,from:bandName(idx),to:bandName(idx-1)})}
          memberBands.set(idx,[]);
        }
      }
      // If a group at 40-44 moved to 35-39 after having inherited an older athlete,
      // the youngest group's displayed range reflects the entire merged cohort.
      for(const [idx,items] of memberBands){
        const upper=Math.max(...items.map(r=>r.baseBand??idx),idx);
        const effectiveLabel=items.length>=2 ? ADULT_BANDS[idx][0]+'–'+ADULT_BANDS[upper][1] : bandName(idx);
        for(const r of items){r.ageBand=idx;r.ageGroup=effectiveLabel;r.ageEstablished=items.length>=2;}
      }
    }
    const compare=(a,b)=>(a.seconds??Infinity)-(b.seconds??Infinity)||a.name.localeCompare(b.name,'ru');
    eligible.sort(compare);
    let previousTime=null,previousPlace=0;
    for(let i=0;i<eligible.length;i++){
      const r=eligible[i];
      if(r.seconds===null){r.absolutePlace=null;continue}
      r.absolutePlace=r.seconds===previousTime?previousPlace:i+1;
      previousTime=r.seconds;previousPlace=r.absolutePlace;
    }
    // Separately calculate age places among finishers, including absolute medalists.
    const ageGroups=new Map();
    for(const r of eligible) {
      const key=d.kind==='relay'?r.relayGroup:AGE_DIVS.has(d.id)?r.ageBand:d.kind==='kids'?(r.age===null?'':Math.floor(r.age/2)*2):null;
      if(key===null||key===undefined||key===-1) continue;
      const label=d.kind==='relay'?key:d.kind==='kids'? (key+'–'+(key+1)) : r.ageGroup;
      const signature=String(key);
      if(!ageGroups.has(signature))ageGroups.set(signature,{key:signature,label,rows:[]});
      ageGroups.get(signature).rows.push(r);
    }
    for(const group of ageGroups.values()){
      const rows=group.rows.sort(compare);
      let prev=null,prevPlace=0;
      for(let i=0;i<rows.length;i++){
        const r=rows[i];
        r.ageEstablished=d.kind==='relay'?rows.length>=2:r.ageEstablished??true;
        if(r.seconds===null){r.agePlace=null;continue}
        r.agePlace=r.seconds===prev?prevPlace:i+1;
        prev=r.seconds;prevPlace=r.agePlace;
      }
    }
    standings.push({id:d.id,name:d.name,kind:d.kind,level:d.level,gender:d.gender,
      registrations:entries.length,finishers:eligible.filter(r=>r.seconds!==null).length,
      singleResult:(workByDiv.get(d.id)||[]).length===1,
      ageGroups:[...ageGroups.values()].map(g=>({key:g.key,label:g.label,
        established:g.rows.length>=2,count:g.rows.length})),merges,
      entries:entries.sort(compare).map(r=>({id:r.id,name:r.name,members:r.members,age:r.age,
        ageGroup:r.ageGroup||r.relayGroup||null,ageEstablished:r.ageEstablished??true,
        absolutePlace:r.absolutePlace??null,agePlace:r.agePlace??null,
        seconds:r.seconds,status:r.status,complete:r.complete,memberCount:r.memberCount,
        required:r.required,publicId:r.publicId}))});
  }
  return {eventId:event.id,eventName:event.name,eventDate:event.date,eventEnd:event.dateEnd,
    calculation:'single-finish-time',minimumAgeGroupSize:2,divisions:standings};
}
module.exports={raceBoard,ageOn,ageBand,bandName,ADULT_BANDS,AGE_DIVS,KIND};
