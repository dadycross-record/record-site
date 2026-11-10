'use strict';
const JUDGING={}, JUDGE_FILTER={};
let AUDIT={rows:null,next:null,busy:false}, ATH_EDIT=null;
const canJudgeView=ev=>!!USER&&(S.viewAs==='owner'||(USER.headEvents||[]).includes(ev.id));
function ensureJudging(ev){
  if(!canJudgeView(ev)||JUDGING[ev.id])return;
  JUDGING[ev.id]={loading:true};
  api('GET','/api/admin/judging?event='+encodeURIComponent(ev.id)).then(r=>{JUDGING[ev.id]=r;render();}).catch(e=>{JUDGING[ev.id]={error:e.message};render();});
}
function judgeInput(ev,reg,workout){
  if(!canJudgeView(ev))return '';
  ensureJudging(ev);const data=JUDGING[ev.id];if(!data?.ready)return '';
  const name=data.assignments.find(a=>a.reg_id===reg&&a.workout_id===workout)?.judge_name||'';
  return `<label class="muted tiny" style="display:block;margin-top:6px">Судья<input class="inp" list="judges-${esc(ev.id)}" data-judge-reg="${esc(reg)}" data-judge-workout="${esc(workout)}" data-judge-event="${esc(ev.id)}" value="${esc(name)}" placeholder="ФИО: выбрать или вписать" maxlength="160" autocomplete="off"></label>`;
}
function judgeFilter(ev){
  if(!canJudgeView(ev))return '';ensureJudging(ev);const d=JUDGING[ev.id];if(!d?.ready)return '';
  const names=[...new Set([...d.judges.map(j=>j.name),...d.assignments.map(j=>j.judge_name)])].sort((a,b)=>a.localeCompare(b,'ru'));
  return `<label class="f">Судья<select class="inp" data-judge-filter="${esc(ev.id)}"><option value="">Все судьи</option><option value="__none" ${JUDGE_FILTER[ev.id]==='__none'?'selected':''}>Судья не указан</option>${names.map(n=>`<option value="${esc(n)}" ${JUDGE_FILTER[ev.id]===n?'selected':''}>${esc(n)}</option>`).join('')}</select></label>`;
}
function judgeMatches(ev,regs,workouts){
  const name=JUDGE_FILTER[ev.id];if(!canJudgeView(ev)||!name||!JUDGING[ev.id]?.ready)return true;
  return workouts.some(w=>regs.some(reg=>{const j=JUDGING[ev.id].assignments.find(a=>a.reg_id===reg&&a.workout_id===w.id);return name==='__none'?!j:j?.judge_name===name;}));
}
function judgingRows(ev){const d=JUDGING[ev.id],div=S.route==='adminResults'?adm.rq?.div:adm.rs?.div,name=JUDGE_FILTER[ev.id];return (d?.rows||[]).filter(r=>(!div||r.div_id===div)&&(!name||r.judge_name===name));}
function judgeTotals(rows){const map=new Map();rows.forEach(r=>{const key=r.judge_id||r.judge_name.trim().toLocaleLowerCase('ru');if(!map.has(key))map.set(key,{name:r.judge_name,n:0,seconds:0,unknown:0});const g=map.get(key);g.n++;if(r.seconds===null)g.unknown++;else g.seconds+=r.seconds;});return [...map.values()];}
function judgingPanel(ev){
  if(!canJudgeView(ev))return '';ensureJudging(ev);const d=JUDGING[ev.id];
  if(d?.error)return `<div class="rule">${esc(d.error)} <button class="linkbtn" data-op-refresh="${esc(ev.id)}">Повторить</button></div>`;
  if(!d?.ready)return '<div class="rule">Учёт судейства подготавливается…</div>';
  const totals=judgeTotals(judgingRows(ev));
  return `<section class="card stack" style="margin-top:20px"><h2 style="margin:0">Учёт судейства</h2><div class="muted small">Доступно владельцу и главному судье этого старта. Один результат атлета или команды за комплекс — один заход. Время суммируется по фактическому результату либо таймкапу; это расчёт нагрузки, а не табель смен.</div><datalist id="judges-${esc(ev.id)}">${d.judges.map(j=>`<option value="${esc(j.name)}"></option>`).join('')}</datalist>${totals.length?`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Судья</th><th>Заходов</th><th>Время на площадке</th><th>Без времени</th></tr></thead><tbody>${totals.map(t=>`<tr><td>${esc(t.name)}</td><td>${t.n}</td><td>${(t.seconds/3600).toFixed(2)} ч · ${Math.round(t.seconds/60)} мин</td><td>${t.unknown}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted">Нет результатов с назначенными судьями по выбранному фильтру.</div>'}<div class="row wrap"><button class="btn sm" data-op-export="${esc(ev.id)}">Учёт судейства в Excel</button><button class="btn sm ghost" data-op-refresh="${esc(ev.id)}">Обновить</button></div></section>`;
}
function exportJudging(ev){const rows=judgingRows(ev),totals=judgeTotals(rows);downloadXlsx('judging-'+ev.id+'.xlsx',[{name:'Сводка',rows:[['Судья','Заходов','Секунд','Часов','Без времени'],...totals.map(t=>[t.name,t.n,t.seconds,t.seconds/3600,t.unknown])]},{name:'Заходы',rows:[['Судья','Участник / команда','Категория','Комплекс','Секунды','Основание','Заявка'],...rows.map(r=>[r.judge_name,r.athlete,r.category,r.workout,r.seconds,r.basis,r.reg_id])]}]);}
function athleteEditor(C){
  if(S.viewAs!=='owner')return '';
  const targets=C.type==='user'?[{type:'user',id:C.user.id,name:'Анкета взрослого',profile:C.user.profile},...C.kids.map(k=>({type:'kid',id:k.id,name:[k.last,k.first].join(' '),profile:k}))]:C.type==='kid'?[{type:'kid',id:C.kid.id,name:'Анкета ребёнка',profile:C.kid}]:[{type:'guest',id:JSON.stringify([C.guest.last,C.guest.first,C.guest.dob]),name:'Анкета участника без аккаунта',profile:C.regs[0]?.person||C.guest}];
  const edit=ATH_EDIT&&targets.find(t=>t.type===ATH_EDIT.type&&String(t.id)===String(ATH_EDIT.id));
  if(!edit)return `<div class="card stack" style="margin-bottom:12px"><b>Изменить анкету</b>${targets.map((t,i)=>`<button class="btn sm ghost" data-ath-edit="${i}">${esc(t.name)}</button>`).join('')}</div>`;
  const p=edit.profile||{},fields=[['last','Фамилия'],['first','Имя'],['dob','Дата рождения'],['affiliate','Клуб'],['size','Размер футболки'],['print','Имя в лидерборде'],...(edit.type==='kid'?[]:[['phone','Телефон'],['tg','Telegram'],['emName','Экстренный контакт'],['emPhone','Телефон экстренного контакта']])];
  return `<form id="operationsAthleteForm" class="card stack" style="margin-bottom:12px"><b>${esc(edit.name)}</b>${fields.map(([key,label])=>`<label class="f">${label}<input class="inp" name="${key}" type="${key==='dob'?'date':'text'}" value="${esc(p[key]||'')}" maxlength="200"></label>`).join('')}<label class="f">Пол<select class="inp" name="gender"><option value="M" ${p.gender!=='F'?'selected':''}>Мужской</option><option value="F" ${p.gender==='F'?'selected':''}>Женский</option></select></label><button class="btn" type="submit">Сохранить изменения</button><button class="btn ghost" type="button" data-op-cancel-edit>Отмена</button></form>`;
}
const AUDIT_ENTITIES={content:'Контент сайта',users:'Анкета взрослого',kids:'Анкета ребёнка',kid_guardians:'Доступ к ребёнку',registrations:'Заявка',scores:'Результат',score_judges:'Судья захода',crew:'Команда старта',crew_rates:'Ставки и смены',teams:'Команда участников',staff:'Доступ к панели',leads:'Заявка на тренировку'};
const AUDIT_FIELDS={profile:'Анкета',first:'Имя',last:'Фамилия',dob:'Дата рождения',gender:'Пол',affiliate:'Клуб',size:'Футболка',phone:'Телефон',email:'Email',status:'Статус',person:'Данные участника',paid:'Оплата',due:'Сумма к оплате',value:'Результат',judge_name:'Судья',judge_id:'Судья из списка',state:'Проверка результата',work:'Рабочие смены',role:'Роль',events:'Старты',updated_by:'Кто изменил',created_at:'Дата создания',updated_at:'Дата изменения',info:'Дополнительные сведения'};
function auditSummary(row){const d=row.details||{},a=d.after||{},b=d.before||{};return Object.keys({...b,...a}).filter(k=>JSON.stringify(b[k])!==JSON.stringify(a[k])).map(k=>k==='changed_sections'?'Разделы контента: '+(a[k]||[]).join(', '):(AUDIT_FIELDS[k]||k)).join(', ')||'Изменение записи';}
function operationsAuditScreen(){
  if(S.viewAs!=='owner')return {title:'Журнал изменений',html:'<div class="empty">Нет доступа</div>'};
  if(!AUDIT.rows&&!AUDIT.busy){AUDIT.busy=true;api('GET','/api/admin/audit').then(r=>{AUDIT={...r,busy:false};render();}).catch(e=>{AUDIT={rows:[],error:e.message};render();});}
  return {title:'Журнал изменений',html:`<div class="muted small">Новые изменения с момента включения журнала. Даты и время — Иркутск. Журнал включается в резервную копию.</div><div class="row wrap" style="margin:12px 0"><button class="btn sm" data-op-audit-export>Журнал в Excel</button><button class="btn sm ghost" data-op-audit-refresh>Обновить</button></div>${AUDIT.error?`<div class="rule">${esc(AUDIT.error)}</div>`:''}<div class="stack">${(AUDIT.rows||[]).map(r=>`<details class="card"><summary><b>${esc(fmtStamp(r.created_at))}</b> · ${esc(r.actor_name||r.actor_email)} · ${esc({INSERT:'Добавил',UPDATE:'Изменил',DELETE:'Удалил'}[r.action]||r.action)} ${esc(AUDIT_ENTITIES[r.entity]||r.entity)}<div class="muted tiny">${esc(r.actor_email)} · учётная запись ${esc(r.actor_id||'система')} · ${esc(r.entity_id||'')} · ${esc(auditSummary(r))}</div></summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px">${esc(JSON.stringify(r.details,null,2))}</pre></details>`).join('')}</div>${AUDIT.next?`<button class="btn ghost" data-op-audit-more="${AUDIT.next}">Показать ещё</button>`:''}`};
}
async function auditExport(){const rows=[];let before=0;for(;;){const r=await api('GET','/api/admin/audit?limit=500&before='+before);rows.push(...r.rows);if(!r.next)break;before=r.next;}downloadXlsx('record-audit.xlsx',[{name:'Журнал',rows:[['Время (Иркутск)','Учётная запись','Email','Имя','Действие','Раздел','Запись','Что изменилось','Подробности'],...rows.map(r=>[fmtStamp(r.created_at),r.actor_id,r.actor_email,r.actor_name,r.action,AUDIT_ENTITIES[r.entity]||r.entity,r.entity_id,auditSummary(r),JSON.stringify(r.details).slice(0,32000)])]}]);}
document.addEventListener('change',e=>{
 const t=e.target,ds=t.dataset||{};
 if(ds.judgeFilter){JUDGE_FILTER[ds.judgeFilter]=t.value;render();}
 if(ds.judgeReg){t.disabled=true;api('POST','/api/admin/judging',{reg:ds.judgeReg,workout:ds.judgeWorkout,name:t.value}).then(async()=>{const r=await api('GET','/api/admin/judging?event='+encodeURIComponent(ds.judgeEvent));JUDGING[ds.judgeEvent]=r;render();}).catch(err=>{t.disabled=false;toast(err.message);});}
});
document.addEventListener('click',e=>{
 const t=e.target.closest('button');if(!t)return;const d=t.dataset;
 if(d.opRefresh){delete JUDGING[d.opRefresh];render();}
 if(d.opExport){const ev=EVENTS.find(e=>e.id===d.opExport);if(ev)exportJudging(ev);}
 if(d.athEdit!==undefined){const C=adm.ath.card;const targets=C.type==='user'?[{type:'user',id:C.user.id},...C.kids.map(k=>({type:'kid',id:k.id}))]:[{type:C.type,id:C.type==='kid'?C.kid.id:JSON.stringify([C.guest.last,C.guest.first,C.guest.dob])}];ATH_EDIT=targets[+d.athEdit];render();}
 if(d.opCancelEdit!==undefined){ATH_EDIT=null;render();}
 if(d.opAuditExport!==undefined)auditExport().catch(err=>toast(err.message));
 if(d.opAuditRefresh!==undefined){AUDIT={rows:null};render();}
 if(d.opAuditMore){api('GET','/api/admin/audit?before='+d.opAuditMore).then(r=>{AUDIT.rows.push(...r.rows);AUDIT.next=r.next;render();}).catch(err=>toast(err.message));}
});
document.addEventListener('submit',e=>{
 if(e.target.id!=='operationsAthleteForm')return;e.preventDefault();e.stopImmediatePropagation();
 if(!confirm('Изменить данные?'))return;
 const fields=Object.fromEntries(new FormData(e.target).entries());const C=adm.ath.card,target=ATH_EDIT;
 api('POST','/api/admin/athlete/update',{...target,profile:fields,confirm:true}).then(r=>{ATH_EDIT=null;return api('POST','/api/admin/athlete',{type:C.type,id:C.type==='user'?C.user.id:C.type==='kid'?C.kid.id:r.id});}).then(card=>{adm.ath.card=card;render();toast('Анкета обновлена');}).catch(err=>toast(err.message));
},true);

let CREW_STATS={rows:null,busy:false,q:""};
function crewStatisticsScreen(){
 if(S.viewAs!=='owner')return {title:'Судьи',html:'<div class="empty">Нет доступа</div>'};
 if(!CREW_STATS.rows&&!CREW_STATS.busy){CREW_STATS.busy=true;api('GET','/api/admin/crew-statistics').then(r=>{CREW_STATS={...r,busy:false,q:CREW_STATS.q};render();}).catch(e=>{CREW_STATS={rows:[],error:e.message,q:''};render();});}
 const rows=(CREW_STATS.rows||[]).filter(r=>(r.name+' '+r.positions.join(' ')).toLocaleLowerCase('ru').includes(CREW_STATS.q.toLocaleLowerCase('ru')));
 return {title:'Судьи · статистика команды',html:`<div class="muted small">Все старты и сохранённые должности. Начислено — расчёт по ставкам и сменам. Выплачено — суммы, отмеченные организатором в карточках команды. Время на площадке берётся из смен; если смены не отмечены — из комплексов.</div><div class="row wrap" style="margin:12px 0"><input class="inp" id="crewStatsQ" type="search" value="${esc(CREW_STATS.q)}" placeholder="ФИО или должность"><button class="btn sm" data-crew-stats-export>Excel</button><button class="btn sm ghost" data-crew-stats-refresh>Обновить</button></div>${CREW_STATS.error?`<div class="rule">${esc(CREW_STATS.error)}</div>`:''}<div class="card tbl-wrap"><table class="tbl"><thead><tr><th>ФИО</th><th>Должности</th><th>Стартов</th><th>Заходов</th><th>Судейство, ч</th><th>На площадке, ч</th><th>Начислено</th><th>Выплачено</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${esc(r.name)}</b></td><td>${r.positions.map(esc).join(', ')}</td><td>${r.starts}</td><td>${r.heats}</td><td>${(r.judgingSeconds/3600).toFixed(2)}${r.unknownTime?`<div class="muted tiny">Без времени: ${r.unknownTime}</div>`:''}</td><td>${(r.onsiteSeconds/3600).toFixed(2)}</td><td>${fmtRub(r.accrued)}</td><td>${r.paymentKnown?fmtRub(r.paid):'Не отмечено'}${r.paymentKnown&&r.paymentUnknown?'<div class="muted tiny">Часть выплат не отмечена</div>':''}</td></tr>`).join('')||'<tr><td colspan="8">Нет данных</td></tr>'}</tbody></table></div>`};
}
function exportCrewStatistics(){const rows=(CREW_STATS.rows||[]).filter(r=>(r.name+' '+r.positions.join(' ')).toLocaleLowerCase('ru').includes(CREW_STATS.q.toLocaleLowerCase('ru')));downloadXlsx('record-crew-statistics.xlsx',[{name:'Судьи и команда',rows:[['ФИО','Должности','Стартов','Заходов','Судейство (сек)','На площадке (сек)','Начислено (руб)','Выплачено (руб)','Неотмеченных выплат','Заходов без времени'],...rows.map(r=>[r.name,r.positions.join(', '),r.starts,r.heats,r.judgingSeconds,r.onsiteSeconds,r.accrued,r.paymentKnown?r.paid:'Не отмечено',r.paymentUnknown,r.unknownTime])]}]);}
document.addEventListener('click',e=>{const d=e.target.closest('button')?.dataset||{};if(d.crewStatsRefresh!==undefined){CREW_STATS={rows:null,busy:false,q:''};if(d.crewStatsRefresh!==undefined)render();}if(d.crewStatsExport!==undefined)exportCrewStatistics();});
document.addEventListener('input',e=>{if(e.target.id==='crewStatsQ'){const pos=e.target.selectionStart;CREW_STATS.q=e.target.value;render();const input=document.getElementById('crewStatsQ');input.focus();try{input.setSelectionRange(pos,pos)}catch{}}});
// Keep the registration's model in sync before its existing change handlers run.
document.addEventListener('change',e=>{const t=e.target;if(t.dataset.gymInput){t.value=RecordClubs.canonical(t.value,GYMS);const box=document.getElementById('gymSuggestions_'+t.id);if(box)box.innerHTML='';}},true);
document.addEventListener('input',e=>{const t=e.target;if(!t.dataset.gymInput)return;const box=document.getElementById('gymSuggestions_'+t.id);if(!box)return;box.innerHTML=RecordClubs.suggest(t.value,GYMS).map(name=>`<button class="btn sm ghost" style="text-align:left" type="button" role="option" data-gym-choice="${esc(name)}" data-gym-target="${esc(t.id)}">${esc(name)}</button>`).join('');});
document.addEventListener('mousedown',e=>{if(e.target.closest('[data-gym-choice]'))e.preventDefault();});
document.addEventListener('click',e=>{const b=e.target.closest('[data-gym-choice]');if(!b)return;const t=document.getElementById(b.dataset.gymTarget);if(!t)return;t.value=b.dataset.gymChoice;t.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById(t.id)?.focus();});
