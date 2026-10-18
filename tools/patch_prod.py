"""One-time conversion of the prototype into the production client (talks to the server API)."""
import re, sys
P = sys.argv[1]
s = open(P, encoding='utf-8').read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f'expected {count} got {n}: {old[:90]!r}')
    s = s.replace(old, new)

def rx(pattern, new, flags=re.S):
    global s
    m = list(re.finditer(pattern, s, flags))
    if len(m) != 1:
        raise SystemExit(f'regex expected 1 got {len(m)}: {pattern[:90]!r}')
    s = s[:m[0].start()] + new + s[m[0].end():]

# ---------- head: own fonts, real title ----------
rep('<title>Record</title>\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap">\n<style>\n',
    '<title>Центр спорта «Рекорд» — Иркутск</title>\n<meta name="description" content="Центр спорта «Рекорд»: функциональные тренировки, тяжёлая атлетика, кикбоксинг и детские группы. Соревнования, регистрация и лидерборд.">\n<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">\n<style>\n'
    '@font-face{font-family:"Unbounded";src:url(/fonts/unbounded.woff) format("woff");font-weight:200 900;font-display:swap}\n'
    '@font-face{font-family:"Golos Text";src:url(/fonts/golos.woff) format("woff");font-weight:400 900;font-display:swap}\n'
    '@font-face{font-family:"JetBrains Mono";src:url(/fonts/jbmono.woff) format("woff");font-weight:100 800;font-display:swap}\n'
    '.cfoot .docs{display:flex;flex-wrap:wrap;gap:6px 16px}.cfoot .docs a{color:var(--muted)}\n'
    '.check a,.fine a{color:var(--accent)}\n.codebox{font-family:var(--f-mono);font-size:24px;letter-spacing:.3em;text-align:center}\n'
    '.loading{min-height:60vh;display:grid;place-items:center;color:var(--muted)}\n')
rep('const TODAY = "2026-10-13";', 'let TODAY = new Date(Date.now()+8*3600e3).toISOString().slice(0,10);')

# ---------- state: no demo person, orders, scores ----------
rx(r'\nconst ME = \{[^\n]*\n', '\nconst ME = {first:"",last:"",print:"",gender:"M",dob:"",affiliate:"",phone:"",email:"",tg:"",emName:"",emPhone:"",kids:[]};\n')
rx(r'let ORDERS = \[\n.*?\n\];', 'let ORDERS = [];')
rx(r'let PROMOS = \[\n.*?\n\];', 'let PROMOS = [];')
rx(r'let ACCESS = \[\n.*?\n\];', 'let ACCESS = [];\n/* server session */\nlet USER = null, MAIL_READY = true, LOADED = false, LOAD_ERR = "";\nlet ADM = {REGS:[], PENDING:[]};\nconst ACTIVE_ST = ["new","paid","refund_requested"];\nlet MYSCORES = [];')
rx(r'let SCORES = \{[^\n]*\n', 'let SCORES = {};\n')
rx(r'let CLUB_LEADS = \[\n.*?\n\];', 'let CLUB_LEADS = [];')
rep('const TEAM_CODE = "1234";\n', '')

# leaderboard: rows come from the server; "me" is set from my registrations
rep('''  if (evId==="oq" && divId==="m"){ const me=rows.find(r=>r.me); if(me){ ev.workouts.forEach((w,i)=>{ const s=SCORES[w.id]; me.r[i] = s && (s.state==="accepted") ? s.value : null; }); } }\n''', '')
rep('const hasReg = (evId, who="me") => ORDERS.some(o=>o.event===evId && o.status==="paid" && (o.who||"me")===who);',
    'const hasReg = (evId, who="me") => ORDERS.some(o=>o.event===evId && ACTIVE_ST.includes(o.status) && (o.who||"me")===who);')
rep('const athleteAge = (ev, p=person()) => ev.ageMode==="year" ? (+ev.date.slice(0,4) - +p.dob.slice(0,4)) : ageOn(p.dob, ev.date);',
    'const athleteAge = (ev, p=person()) => !p || !p.dob ? NaN : ev.ageMode==="year" ? (+ev.date.slice(0,4) - +p.dob.slice(0,4)) : ageOn(p.dob, ev.date);')
rep('const S = { route:"club", p:{}, stack:[], lb:{ev:"oq",tab:"ind",div:"m",w:-1,q:"",open:null}, evTab:{}, reg:null, searchOpen:false, who:"me", viewAs:"owner" };',
    'const S = { route:"club", p:{}, stack:[], lb:{ev:"",tab:"ind",div:"m",w:-1,q:"",open:null}, evTab:{}, reg:null, searchOpen:false, who:"me", viewAs:"guest" };')
rep('<span class="demo-tag">прототип</span>', '')

# ---------- teams: codes are checked by the server ----------
rep('''Остальные находят команду по названию и вводят этот код. В демо код любой команды: <span class="mono">${TEAM_CODE}</span>.</div>''',
    '''Остальные находят команду по названию и вводят этот код.</div>''')
rep('''    S.reg.team=v.name.toUpperCase(); S.reg.newTeam=true; return go("form",{});''',
    '''    S.reg.team=v.name.toUpperCase(); S.reg.newTeam=true; S.reg.teamReq={mode:"create",name:S.reg.team,code:v.code}; return go("form",{});''')
rep('''    if (g("jCode").value.trim()!==TEAM_CODE){ S.p={...S.p,err:"Код не подходит. Уточните его у капитана"}; render(); g("jCode")&&g("jCode").focus(); return; }
    S.reg.team=S.p.pick; S.reg.newTeam=false; return go("form",{});''',
    '''    const jc=g("jCode").value.trim(); if (!/^\\d{4,6}$/.test(jc)){ S.p={...S.p,err:"Код — от 4 до 6 цифр. Уточните его у капитана"}; render(); g("jCode")&&g("jCode").focus(); return; }
    S.reg.team=S.p.pick; S.reg.newTeam=false; S.reg.teamReq={mode:"join",name:S.p.pick,code:jc}; return go("form",{});''')

# ---------- registration form: separate consents with links, sent to the server ----------
rep('''    <label class="f">Зал<select class="inp" id="rAff">${AFFILIATES.map(a=>`<option ${a===ME.affiliate?"selected":""}>${a}</option>`).join("")}</select></label>''',
    '''    <label class="f">Зал<select class="inp" id="rAff">${AFFILIATES.map(a=>`<option ${a===(f.aff||p.affiliate||ME.affiliate)?"selected":""}>${a}</option>`).join("")}</select></label>''')
rep('''    <div class="grid2"><label class="f">Экстренный контакт<input class="inp" id="rEm" value="${esc(ME.emName)}"></label><label class="f">Его телефон<input class="inp" id="rEmP" value="${esc(ME.emPhone)}"></label></div>''',
    '''    <div class="grid2"><label class="f">Экстренный контакт<input class="inp" value="${esc(ME.emName||"не указан")}" disabled></label><label class="f">Его телефон<input class="inp" value="${esc(ME.emPhone||"—")}" disabled></label></div>
    <div class="muted tiny">Данные берутся из анкеты. Исправить их можно в <button type="button" class="linkbtn" data-go="profile">анкете участника</button>.</div>''')
rep('''    <label class="check"><input type="checkbox" id="c1" ${f.c1?"checked":""}><span>Принимаю правила соревнований и стандарты движений</span></label>
    <label class="check"><input type="checkbox" id="c2" ${f.c2?"checked":""}><span>Даю согласие на обработку персональных данных (152-ФЗ)</span></label>
    ${age<18?`<label class="check"><input type="checkbox" id="c3" ${f.c3?"checked":""}><span>${kid?`Я, ${esc(ME.first)} ${esc(ME.last)}, законный представитель, согласен на участие ребёнка и обработку его данных`:"Законный представитель согласен на участие"}</span></label>`:""}''',
    '''    <label class="check"><input type="checkbox" id="c1" ${f.c1?"checked":""}><span>Принимаю <a href="/docs/rules" target="_blank">условия участия</a>, правила старта и стандарты движений</span></label>
    <label class="check"><input type="checkbox" id="c2" ${f.c2?"checked":""}><span>Даю <a href="/docs/consent" target="_blank">согласие на обработку персональных данных</a> и ознакомлен с <a href="/docs/privacy" target="_blank">политикой</a></span></label>
    ${age<18?`<label class="check"><input type="checkbox" id="c3" ${f.c3?"checked":""}><span>${kid?`Я, ${esc(ME.first)} ${esc(ME.last)}, законный представитель, согласен на участие ребёнка и обработку его данных`:"Законный представитель согласен на участие"}</span></label>`:""}
    <label class="check"><input type="checkbox" id="c4" ${f.c4?"checked":""}><span>Можно показывать ${kid?"имя ребёнка":"моё имя"}, зал и результаты в открытом лидерборде — <a href="/docs/publish" target="_blank">согласие на распространение</a>. Без галочки в таблице будет «Участник №…»</span></label>
    <label class="check"><input type="checkbox" id="c5" ${f.c5?"checked":""}><span>Можно публиковать фото и видео со старта в соцсетях клуба</span></label>''')
rep('''    <button class="btn block" type="submit" ${ready?"":"disabled"}>${ready?"Перейти к оплате":"Отметьте согласия"}</button>
    <div class="muted tiny" style="text-align:center">Место держится 15 минут, пока идёт оплата.</div>''',
    '''    ${f.err?`<div class="err-t">${esc(f.err)}</div>`:""}
    <button class="btn block" type="submit" ${ready&&!f.busy?"":"disabled"}>${f.busy?"Отправляю…":!ready?"Отметьте согласия":total>0?"Отправить заявку":"Зарегистрироваться"}</button>
    ${total>0?'<div class="muted tiny" style="text-align:center">Онлайн-оплата скоро появится. Пока организатор подтвердит заявку и подскажет, как оплатить взнос.</div>':""}''')
rep('''function keepForm(){ const f=S.reg.f; const g=id=>document.getElementById(id); if(g("rSize")) f.size=g("rSize").value; ["c1","c2","c3"].forEach(k=>{ if(g(k)) f[k]=g(k).checked; }); }''',
    '''function keepForm(){ const f=S.reg.f; const g=id=>document.getElementById(id); if(g("rSize")) f.size=g("rSize").value; if(g("rAff")) f.aff=g("rAff").value; ["c1","c2","c3","c4","c5"].forEach(k=>{ if(g(k)) f[k]=g(k).checked; }); }''')
rep('''  if (["c1","c2","c3","rSize"].includes(id)){ keepForm(); const y=window.scrollY; render(); window.scrollTo(0,y); }''',
    '''  if (["c1","c2","c3","c4","c5","rSize","rAff"].includes(id)){ keepForm(); const y=window.scrollY; render(); window.scrollTo(0,y); }''')
rep('''  if (e.target.id==="fReg"){ keepForm(); return go("pay",{}); }''',
    '''  if (e.target.id==="fReg"){ keepForm(); return submitReg(); }''')
rep('''  if (ds.act==="promo"){ const v=document.getElementById("rPromo").value.trim().toUpperCase(); S.reg.f.promo=v; keepForm(); const res=promoCheck(v,S.reg.ev,S.reg.div.price); S.reg.f.promoOk=!res.err; S.reg.f.promoMsg = res.err || `Скидка ${res.label} применена: −${fmtRub(res.off)}`; return render(); }''',
    '''  if (ds.act==="promo"){ const v=document.getElementById("rPromo").value.trim().toUpperCase(); S.reg.f.promo=v; keepForm();
    api("POST","/api/promo",{code:v,event:S.reg.ev.id,div:S.reg.div.id}).then(res=>{ S.reg.f.promoOk=true; S.reg.f.promoOff=res.off; S.reg.f.promoMsg=`Скидка ${res.label} применена: −${fmtRub(res.off)}`; render(); })
      .catch(err=>{ S.reg.f.promoOk=false; S.reg.f.promoOff=0; S.reg.f.promoMsg=err.message; render(); }); return; }''')
rep('const promoOff = r => r && r.f.promoOk ? (promoCheck(r.f.promo, r.ev, r.div.price).off || 0) : 0;',
    'const promoOff = r => r && r.f.promoOk ? (r.f.promoOff || 0) : 0;')
rx(r'  if \(ds\.act==="paid"\)\{\n.*?S\.stack=\[\]; return go\("done",\{\},false\);\n  \}\n  if \(ds\.act==="payfail"\) return go\("fail",\{\}\);\n  if \(ds\.act==="retry"\) return back\(\);\n', '')
rep('''  if (ds.pick){
    const ev = EVENTS.find(x=>x.id===S.p.ev), div = ev.divisions.find(d=>d.id===ds.pick);''',
    '''  if (ds.pick){
    const ev = EVENTS.find(x=>x.id===S.p.ev), div = ev.divisions.find(d=>d.id===ds.pick);
    if (!USER) return needLogin("Войдите, чтобы записаться на старт");
    if (!profileReady()) { toast("Сначала заполните анкету участника"); return go("profile",{edit:true,then:"divisions"}); }''')
rep('''    const ev = EVENTS.find(x=>x.id===ds.ev); S.who="me";''', '''    const ev = EVENTS.find(x=>x.id===ds.ev); S.who="me"; if (!ev) return;''')

# done screen
rx(r'done\(\)\{\n.*?\n\},\nfail\(\)\{', '''done(){
  const o = ORDERS[ORDERS.length-1]; if (!o) return SCREENS.orders();
  const ev = EVENTS.find(e=>e.id===o.event)||{name:"",divisions:[]}, d = ev.divisions.find(x=>x.id===o.div)||{name:""};
  const nm = o.who==="me" ? "Вы в списке" : `${esc((o.person||{}).first||"")} в списке`;
  return {title:"Готово", html:`
   <div class="center"><div class="big-ic" style="background:var(--good-soft);color:var(--good)"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 12l5 5 9-10"/></svg></div>
   <div style="font-family:var(--f-display);font-weight:800;font-size:22px;text-transform:uppercase">${o.status==="paid"?nm:"Заявка принята"}</div>
   <p class="muted">${esc(ev.name)} · ${esc(d.name)}${o.team?` · ${esc(o.team)}`:""}</p>
   <div class="card kv" style="text-align:left;margin:16px 0"><dt>Заказ</dt><dd class="mono">${o.id}</dd><dt>${o.status==="paid"?"Взнос":"К оплате"}</dt><dd class="mono">${fmtRub(o.status==="paid"?o.paid:o.due)}</dd><dt>Email</dt><dd>${esc(USER?USER.email:"")}</dd></div>
   <p class="muted small">${o.status==="paid"?"Статус и возврат — в разделе «Мои старты».":"Организатор подтвердит заявку и подскажет, как оплатить взнос. Статус видно в разделе «Мои старты»."}</p>
   <div class="stack"><button class="btn block" data-tab-go="me" data-sub="orders">Мои старты</button><button class="btn block ghost" data-tab-go="home">На главную</button></div></div>`};
},
fail(){''')

# ---------- profile, my starts, results ----------
rx(r'me\(\)\{\n  const \{rows\} = leaderboard\("oq","m"\);.*?\n\},\norders\(\)\{\n.*?\n\},\nscore\(\)\{\n.*?\n\},\nqr\(\)\{\n.*?\n\},\nprofile\(\)\{\n.*?\n\}\n\};',
   '''me(){
  if (!USER) return SCREENS.login();
  const act = ORDERS.filter(o=>ACTIVE_ST.includes(o.status));
  const places = act.map(o=>myPlace(o)).filter(Boolean), best = places.length ? Math.min(...places) : null;
  const canScore = scoreTargets().length;
  const nm = ME.first ? `${ME.first} ${ME.last}` : USER.email;
  const ini = ME.first ? (ME.first[0]+(ME.last[0]||"")) : USER.email[0].toUpperCase();
  return {title:null, html:`
   <div class="pcard"><div class="row"><div class="big-av">${esc(ini)}</div><div class="sp"><div style="font-weight:700;font-size:18px">${esc(nm)}</div><div class="muted small">${esc(ME.affiliate||USER.email)}</div></div></div>
   <div class="stats"><div><b>${act.length}</b><span>Стартов</span></div><div><b>${act.filter(o=>{const e=EVENTS.find(x=>x.id===o.event); return e&&e.status!=="ended";}).length}</b><span>Впереди</span></div><div><b class="acc">${best?"#"+best:"—"}</b><span>Лучшее место</span></div></div></div>
   ${profileReady()?"":`<div class="rule" style="margin-top:12px">Заполните анкету участника — без неё нельзя записаться на старт. <button class="linkbtn" data-go="profile" data-edit="1">Заполнить</button></div>`}
   <h2 class="sec">Сервис</h2>
   <div class="menu">
    ${["owner","admin","judge"].includes(S.viewAs)?`<button data-go="admin"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg><span class="sp">${S.viewAs==="judge"?"Панель судьи":"Панель организатора"}</span><span class="chip warn">${ROLE_L[S.viewAs]}</span></button>`:""}
    <button data-go="orders"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/></svg><span class="sp">Мои старты</span><span class="chip neutral">${ORDERS.length}</span></button>
    ${canScore?`<button data-go="score"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M6 9l6-6 6 6M4 21h16"/></svg><span class="sp">Сдать результат</span><span class="chip live">идёт приём</span></button>`:""}
    <button data-go="profile"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"/></svg><span class="sp">Анкета участника</span></button>
    <button data-act="logout"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg><span class="sp">Выйти</span></button>
   </div>
   <p class="foot">Вы вошли как ${esc(USER.email)}</p>`};
},
login(){
  const L = S.login || (S.login = {step:"email", email:"", ok:false, err:"", busy:false});
  const why = L.why ? `<div class="rule" style="margin-bottom:14px">${esc(L.why)}</div>` : "";
  if (!MAIL_READY) return {title:"Вход", html:`${why}<div class="empty">Вход на сайт скоро заработает: мы настраиваем почту для отправки кодов.</div>`};
  if (L.step==="code") return {title:"Вход", html:`${why}
   <form class="stack" id="fCode" novalidate>
    <div class="muted small">Отправили код на <b>${esc(L.email)}</b>. Письмо приходит за минуту — проверьте и папку «Спам».</div>
    <label class="f">Код из письма<input class="inp codebox ${L.err?"err":""}" id="lCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></label>
    ${L.err?`<div class="err-t">${esc(L.err)}</div>`:""}
    <button class="btn block" type="submit" ${L.busy?"disabled":""}>${L.busy?"Проверяю…":"Войти"}</button>
    <button class="btn block ghost" type="button" data-act="lagain">Другой email или новый код</button>
   </form>`, after:()=>{ const i=document.getElementById("lCode"); i&&i.focus(); }};
  return {title:"Вход", html:`${why}
   <form class="stack" id="fLogin" novalidate>
    <div class="muted small">Вход без пароля: пришлём код на почту. Если вы у нас впервые, аккаунт создастся сам.</div>
    <label class="f">Email<input class="inp ${L.err?"err":""}" id="lEmail" type="email" inputmode="email" autocomplete="email" value="${esc(L.email)}" placeholder="name@mail.ru"></label>
    <label class="check"><input type="checkbox" id="lOk" ${L.ok?"checked":""}><span>Даю <a href="/docs/consent" target="_blank">согласие на обработку персональных данных</a> и ознакомлен с <a href="/docs/privacy" target="_blank">политикой</a></span></label>
    ${L.err?`<div class="err-t">${esc(L.err)}</div>`:""}
    <button class="btn block" type="submit" ${L.busy?"disabled":""}>${L.busy?"Отправляю…":"Получить код"}</button>
   </form>`};
},
orders(){
  if (!ORDERS.length) return {title:"Мои старты", html:'<div class="empty">Вы пока никуда не записаны.<br><button class="btn" data-tab="events" style="margin-top:14px">Выбрать старт</button></div>'};
  return {title:"Мои старты", html:`<div class="stack cards">${[...ORDERS].reverse().map(orderCard).join("")}</div>`};
},
score(){
  const T = scoreTargets();
  if (!T.length) return {title:"Сдать результат", html:'<div class="empty">Сейчас нет онлайн-старта, где у вас идёт сдача результатов</div>'};
  const ti = Math.min(S.p.o ?? 0, T.length-1), {o, ev, ws} = T[ti];
  const wi = Math.min(S.p.w ?? 0, ws.length-1), w = ws[wi], cur = MYSCORES.find(s=>s.reg_id===o.id && s.workout_id===w.id);
  const st = {pending:'<span class="chip warn">На проверке</span>',accepted:'<span class="chip ok">Принят</span>',rejected:'<span class="chip full">Отклонён</span>'};
  const done = id => MYSCORES.some(s=>s.reg_id===o.id && s.workout_id===id);
  return {title:"Сдать результат", html:`
   ${T.length>1?`<div class="pills" role="tablist" style="margin-bottom:10px">${T.map((t,i)=>`<button role="tab" aria-selected="${i===ti}" data-so="${i}">${esc(t.ev.name)} · ${esc(t.o.who==="me"?"я":(t.o.person||{}).first||"")}</button>`).join("")}</div>`:""}
   <div class="muted small" style="margin-bottom:10px">${esc(ev.name)}${ev.permanent?` · ${monthTitle(curMonth(ev).id)}`:ev.submitTo?` · окно сдачи до ${dHuman(ev.submitTo)}, 23:59`:""}</div>
   <div class="pills" role="tablist">${ws.map((x,i)=>`<button role="tab" aria-selected="${i===wi}" data-sw="${i}">${esc(x.name)}${done(x.id)?" ✓":""}</button>`).join("")}</div>
   <div class="card wod" style="margin-top:12px"><h4>${esc(w.name)}</h4><div class="muted tiny">${esc(w.note||"")}</div><ul>${(w.body||[]).map(x=>`<li>${esc(x)}</li>`).join("")}</ul></div>
   ${cur?`<div class="card row" style="margin-top:12px"><div class="sp"><div class="muted tiny">Отправлено</div><div class="mono" style="font-size:20px;font-weight:700">${fmtRes(w.type,cur.value)}</div></div>${st[cur.state]}</div>`:""}
   <form class="stack" id="fScore" style="margin-top:14px" novalidate>
    ${w.type==="time"?`<label class="check"><input type="checkbox" id="sCap" ${S.p.cap?"checked":""}><span>Не уложился в лимит ${Math.floor(w.cap/60)}:00</span></label>
      ${S.p.cap?`<label class="f">Повторений к лимиту<input class="inp mono" id="sVal" inputmode="numeric" placeholder="142"></label>`:`<label class="f">Время (мм:сс)<input class="inp mono" id="sVal" placeholder="13:45" inputmode="numeric"></label>`}`
     : w.type==="reps"?`<label class="f">Повторений<input class="inp mono" id="sVal" inputmode="numeric" placeholder="240"></label>`
     : `<label class="f">Вес, кг<input class="inp mono" id="sVal" inputmode="decimal" placeholder="185"></label>`}
    <label class="f">Ссылка на видео<input class="inp" id="sVid" placeholder="https://vk.com/video..." inputmode="url"></label>
    ${S.p.err?`<div class="err-t">${esc(S.p.err)}</div>`:'<div class="muted tiny">Видео одним дублем, весь комплекс целиком, таймер в кадре.</div>'}
    <button class="btn block" type="submit" ${S.p.busy?"disabled":""}>${cur?"Заменить результат":"Отправить на проверку"}</button>
   </form>`};
},
profile(){
  const edit = S.p.edit || !profileReady();
  if (!edit){
    const kv = [["Фамилия и имя",`${ME.last} ${ME.first}`],["Пол",ME.gender==="F"?"Женский":"Мужской"],["Дата рождения",ME.dob?dShort(ME.dob):"—"],["Зал",ME.affiliate||"—"],["Телефон",ME.phone||"—"],["Email",USER.email],["Telegram",ME.tg||"—"],["Экстренный контакт",ME.emName?`${ME.emName}, ${ME.emPhone}`:"—"],["Дети",ME.kids.length?ME.kids.map(k=>`${k.first} ${k.last}, ${k.dob.slice(0,4)} г.р.`).join("; "):"—"]];
    return {title:"Анкета участника", html:`<div class="card kv">${kv.map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</div>
     <div class="stack" style="margin-top:14px"><button class="btn block" data-go="profile" data-edit="1">Изменить анкету</button></div>
     <div class="rule" style="margin-top:12px">Анкета заполняется один раз и подставляется в каждую регистрацию.</div>
     <h2 class="sec">Аккаунт</h2>
     ${S.p.delAsk?`<div class="panel stack"><div class="small">Удалить аккаунт и анкету? Регистрации на старты останутся у организатора без ваших контактов, имя в лидерборде скроется.</div><div class="row"><button class="btn sm" data-act="accdelyes">Удалить</button><button class="btn sm ghost" data-act="accdelno">Отмена</button></div></div>`
       :'<button class="btn sm ghost" data-act="accdelask">Удалить аккаунт и отозвать согласие</button>'}`};
  }
  const v = S.p.v || {...ME, kids:ME.kids.map(k=>({...k}))}; S.p.v = v; const e = S.p.e || {};
  const sel = (id,cur,arr) => `<select class="inp" id="${id}">${arr.map(([k,l])=>`<option value="${k}" ${k===cur?"selected":""}>${l}</option>`).join("")}</select>`;
  return {title:"Анкета участника", html:`
   <form class="stack" id="fProfile" novalidate>
    <div class="grid2"><label class="f">Фамилия<input class="inp ${e.last?"err":""}" id="pLast" value="${esc(v.last)}" autocomplete="family-name"></label><label class="f">Имя<input class="inp ${e.first?"err":""}" id="pFirst" value="${esc(v.first)}" autocomplete="given-name"></label></div>
    <div class="grid2"><label class="f">Пол${sel("pGender",v.gender,[["M","Мужской"],["F","Женский"]])}</label><label class="f">Дата рождения<input class="inp ${e.dob?"err":""}" id="pDob" type="date" value="${esc(v.dob)}"></label></div>
    <label class="f">Зал<select class="inp" id="pAff">${["",...AFFILIATES].map(a=>`<option ${a===v.affiliate?"selected":""} value="${esc(a)}">${a||"Выберите"}</option>`).join("")}</select></label>
    <div class="grid2"><label class="f">Телефон<input class="inp ${e.phone?"err":""}" id="pPhone" type="tel" value="${esc(v.phone)}" placeholder="+7" autocomplete="tel"></label><label class="f">Telegram<input class="inp" id="pTg" value="${esc(v.tg)}" placeholder="@name"></label></div>
    <div class="grid2"><label class="f">Экстренный контакт<input class="inp" id="pEm" value="${esc(v.emName)}" placeholder="Имя"></label><label class="f">Его телефон<input class="inp" id="pEmP" type="tel" value="${esc(v.emPhone)}" placeholder="+7"></label></div>
    ${Object.values(e).filter(Boolean).map(x=>`<div class="err-t">${esc(x)}</div>`).join("")}
    <h2 class="sec" style="margin-top:8px">Дети</h2>
    <div class="muted tiny">Добавьте детей, чтобы записывать их на детские старты от своего аккаунта.</div>
    ${v.kids.map((k,i)=>`<div class="card stack"><div class="grid2"><label class="f">Фамилия<input class="inp" id="kLast${i}" value="${esc(k.last)}"></label><label class="f">Имя<input class="inp" id="kFirst${i}" value="${esc(k.first)}"></label></div>
      <div class="grid2"><label class="f">Пол${sel("kGender"+i,k.gender,[["M","Мальчик"],["F","Девочка"]])}</label><label class="f">Дата рождения<input class="inp" id="kDob${i}" type="date" value="${esc(k.dob)}"></label></div>
      <button type="button" class="btn sm ghost" data-kiddel="${i}" style="align-self:flex-start">Убрать</button></div>`).join("")}
    <button type="button" class="btn ghost" data-act="kidadd" style="align-self:flex-start">+ Ребёнок</button>
    <button class="btn block" type="submit" ${S.p.busy?"disabled":""}>${S.p.busy?"Сохраняю…":"Сохранить анкету"}</button>
   </form>`};
}
};''')

rx(r'function orderCard\(o\)\{\n.*?\n\}\nfunction refundPct', '''function orderCard(o){
  const ev = EVENTS.find(e=>e.id===o.event) || {name:"Старт удалён",divisions:[],format:"onsite",status:"ended",date:o.date}, d = ev.divisions.find(x=>x.id===o.div) || {name:""};
  const stMap = {new:'<span class="chip warn">Ожидает оплаты</span>',paid:'<span class="chip ok">Зарегистрирован</span>',refund_requested:'<span class="chip warn">Запрошен возврат</span>',refunded:'<span class="chip neutral">Возврат оформлен</span>',cancelled:'<span class="chip neutral">Отменена</span>'};
  const pct = refundPct(ev), p = o.person || {};
  const panel = S.p.refund===o.id ? `<div class="panel stack"><div>${o.status==="paid"&&o.paid>0?`По правилам старта возвращается ${pct}% взноса — <b class="mono">${fmtRub(Math.round(o.paid*pct/100))}</b>. Организатор оформит возврат и напишет вам.`:"Заявка будет отменена, место освободится для других."}</div><div class="row"><button class="btn sm" data-refund-ok="${o.id}">${o.status==="paid"&&o.paid>0?"Запросить возврат":"Отменить заявку"}</button><button class="btn sm ghost" data-refund-no>Назад</button></div></div>` : "";
  const scoring = scoreTargets().some(t=>t.o.id===o.id);
  return `<div class="order"><div class="hd"><span class="small">${ev.date?dateRange(ev):""} · ${ev.format==="online"?"Онлайн":"Очный"}</span>${stMap[o.status]||""}</div>
   <div class="bd"><div style="font-family:var(--f-display);font-weight:600;font-size:16px;text-transform:uppercase">${esc(ev.name)}</div>
   <dl class="kv small" style="margin:10px 0 0"><dt>Участник</dt><dd>${esc(p.last||"")} ${esc(p.first||"")}</dd><dt>Категория</dt><dd>${esc(d.name)}${o.team?` · ${esc(o.team)}`:""}</dd><dt>Заказ</dt><dd class="mono">${o.id}</dd><dt>${o.status==="new"?"К оплате":"Взнос"}</dt><dd class="mono">${fmtRub(o.status==="new"?o.due:o.paid)}</dd><dt>Лидерборд</dt><dd>${o.publish?"с именем":"анонимно"} <button class="linkbtn" data-pubtoggle="${o.id}">${o.publish?"скрыть имя":"показывать имя"}</button></dd></dl></div>
   ${["new","paid"].includes(o.status)?`<div class="acts">${scoring?`<button class="btn sm" data-go="score">Сдать результат</button>`:""}<button class="btn sm ghost" data-go="profile">Анкета</button>${ev.status!=="ended"?`<button class="btn sm ghost" data-refund="${o.id}">${o.status==="paid"&&o.paid>0?"Возврат":"Отменить"}</button>`:""}</div>`:""}
   ${panel}</div>`;
}
function refundPct''')

rep('''  if (ds.refundOk){ const o=ORDERS.find(x=>x.id===ds.refundOk); o.status="refunded"; const ev=EVENTS.find(x=>x.id===o.event); const d=ev.divisions.find(x=>x.id===o.div); if(d.type!=="team") d.taken--; S.p={}; render(); return toast("Возврат оформлен. Деньги придут за 3–10 дней"); }''',
    '''  if (ds.refundOk){ api("POST","/api/refund",{id:ds.refundOk}).then(async r=>{ replaceOrder(r.order); S.p={}; await loadContent(); render(); toast("Запрос отправлен организатору"); }).catch(err=>toast(err.message)); return; }
  if (ds.pubtoggle){ const o=ORDERS.find(x=>x.id===ds.pubtoggle); api("POST","/api/publish",{id:o.id,publish:!o.publish}).then(async r=>{ replaceOrder(r.order); await loadContent(); render(); toast(r.order.publish?"Имя будет видно в лидерборде":"В лидерборде вы будете «Участник №…»"); }).catch(err=>toast(err.message)); return; }
  if (ds.so!==undefined){ S.p={o:+ds.so,w:0}; return render(); }
  if (ds.act==="logout"){ api("POST","/api/auth/logout",{}).finally(()=>{ location.hash=""; location.reload(); }); return; }
  if (ds.act==="lagain"){ S.login={...S.login,step:"email",err:""}; return render(); }
  if (ds.act==="kidadd"){ syncProfile(); S.p.v.kids.push({id:"",first:"",last:"",gender:"M",dob:""}); return render(); }
  if (ds.kiddel!==undefined){ syncProfile(); S.p.v.kids.splice(+ds.kiddel,1); return render(); }
  if (ds.act==="accdelask"){ S.p={...S.p,delAsk:true}; return render(); }
  if (ds.act==="accdelno"){ S.p={...S.p,delAsk:false}; return render(); }
  if (ds.act==="accdelyes"){ api("POST","/api/account/delete",{}).then(()=>{ location.hash=""; location.reload(); }).catch(err=>toast(err.message)); return; }''')
rep('''  if (ds.sw!==undefined){ S.p={w:+ds.sw}; return render(); }
  if (ds.act==="judge"){ SCORES[ds.w].state="accepted"; render(); return toast("Результат принят. Лидерборд пересчитан"); }''',
    '''  if (ds.sw!==undefined){ S.p={o:S.p.o,w:+ds.sw}; return render(); }''')
rep('''  if (ds.go) return go(ds.go,{});''', '''  if (ds.go==="profile" && ds.edit) return go("profile",{edit:true});
  if (ds.go) return go(ds.go,{});''')

# score submit -> server
rx(r'  if \(e\.target\.id==="fScore"\)\{\n    const ev=EVENTS\.find\(x=>x\.id==="oq"\), wi=S\.p\.w\?\?2, w=ev\.workouts\[wi\];', '''  if (e.target.id==="fScore"){
    const T=scoreTargets(), ti=Math.min(S.p.o??0,T.length-1), {o,ws}=T[ti], wi=Math.min(S.p.w??0,ws.length-1), w=ws[wi];''')
rep('''    SCORES[w.id]={value:val,video:vid,state:"pending"}; S.p={w:wi}; render(); toast("Результат отправлен на проверку");''',
    '''    S.p={...S.p,busy:true,err:null}; render();
    api("POST","/api/score",{reg:o.id,workout:w.id,value:val,video:vid}).then(r=>{ MYSCORES=MYSCORES.filter(s=>!(s.reg_id===o.id&&s.workout_id===w.id)); MYSCORES.push(r.score); S.p={o:ti,w:wi}; render(); toast("Результат отправлен на проверку"); })
      .catch(err=>{ S.p={...S.p,busy:false,err:err.message}; render(); });''')

# ---------- organizer: participants table from the server, CSV for Excel ----------
rx(r'/\* rows for the Google Sheet: one row per paid or refunded registration \*/\nconst SHEET_COLS = .*?\nasync function copySheet\(ev\)\{\n.*?\n\}\n', '''/* participants table: one row per registration, downloadable for Excel */
const SHEET_COLS = ["Дата заявки","Заказ","Старт","Категория","Дни выступления","Команда","Фамилия","Имя","Пол","Дата рождения","Возраст","Зал","Телефон","Email","Экстренный контакт","Футболка","Промокод","Взнос, ₽","Оплачено, ₽","Статус","Имя в лидерборде"];
const REG_ST = {new:"Ожидает оплаты",paid:"Оплачен",refund_requested:"Запрошен возврат",refunded:"Возврат",cancelled:"Отменена"};
function sheetRows(ev){
  return ADM.REGS.filter(o=>o.event===ev.id).map(o=>{ const p=o.person||{}, d=ev.divisions.find(x=>x.id===o.div)||{name:""};
    return [dShort(o.date),o.id,ev.name,d.name,evDays(ev).length>1?divDays(ev,d):dShort(ev.date),o.team||"",p.last||"",p.first||"",p.gender==="F"?"Ж":"М",p.dob?dShort(p.dob):"",p.dob?athleteAge(ev,p):"",p.affiliate||"",p.phone||"",o.email||"",p.emName?`${p.emName}, ${p.emPhone||""}`:"",o.size||"",o.promo||"",o.due,o.paid,REG_ST[o.status]||o.status,o.publish?"да":"нет"]; });
}
function downloadCsv(name, rows){
  const q = v => `"${String(v??"").replace(/"/g,'""')}"`;
  const blob = new Blob(["\\ufeff"+rows.map(r=>r.map(q).join(";")).join("\\r\\n")], {type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); a.remove();
  toast(`Файл ${name} сохранён — откройте его в Excel`);
}
''')
rx(r'adminPeople\(\)\{\n.*?\n\}\n\}\);', '''adminPeople(){
  const ev=curEv(); if (!ev) return {title:"Участники", html:'<div class="empty">Старт не найден</div>'};
  const regs = ADM.REGS.filter(o=>o.event===ev.id), act = regs.filter(o=>ACTIVE_ST.includes(o.status));
  const tot = act.length, sum = act.reduce((a,o)=>a+(o.paid||0),0), due = act.filter(o=>o.status==="new").reduce((a,o)=>a+(o.due||0),0);
  const byDiv = d => act.filter(o=>o.div===d.id).length;
  return {title:"Участники", html:`<div class="muted small" style="margin-bottom:10px">${esc(ev.name)} · ${ev.date?dHuman(ev.date):""}</div>
    <div class="card tbl-wrap"><table class="tbl"><thead><tr><th>Категория</th><th class="num">Записано</th><th class="num">Оплачено</th></tr></thead><tbody>
    ${ev.divisions.map(d=>`<tr><td>${esc(d.name)}<div class="muted tiny">${ageLabel(d,ev)}</div><div class="minibar"><i style="width:${Math.min(100,Math.round(d.taken/(d.limit||1)*100))}%"></i></div></td><td class="num">${byDiv(d)}${d.type==="team"?` · ${d.taken} ком.`:""}/${d.limit}</td><td class="num">${fmtRub(act.filter(o=>o.div===d.id).reduce((a,o)=>a+(o.paid||0),0))}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">Категорий нет</td></tr>'}
    <tr><td><b>Итого</b></td><td class="num"><b>${tot}</b></td><td class="num"><b>${fmtRub(sum)}</b>${due?`<div class="muted tiny">ждём ${fmtRub(due)}</div>`:""}</td></tr></tbody></table></div>
    <div class="row wrap" style="margin-top:12px"><button class="btn sm" data-act="regcsv" ${regs.length?"":"disabled"}>Скачать таблицу для Excel</button></div>
    <h2 class="sec">Заявки · ${regs.length}</h2>
    ${regs.length?`<div class="stack cards">${[...regs].reverse().map(o=>{ const p=o.person||{}, d=ev.divisions.find(x=>x.id===o.div)||{name:""};
      return `<div class="card stack"><div class="row"><div class="sp"><b>${esc(p.last||"")} ${esc(p.first||"")}</b><div class="muted tiny">${esc(d.name)}${o.team?` · ${esc(o.team)}`:""} · ${o.id} · ${dShort(o.date)}</div><div class="muted tiny">${esc(p.phone||"")} · ${esc(o.email||"")}${p.parent?` · родитель: ${esc(p.parent)}`:""}</div></div><span class="chip ${o.status==="paid"?"ok":o.status==="new"||o.status==="refund_requested"?"warn":"neutral"}">${REG_ST[o.status]||o.status}</span></div>
        <div class="row wrap">${o.status==="new"?`<button class="btn sm" data-regst="paid" data-reg="${o.id}">Оплата получена · ${fmtRub(o.due)}</button><button class="btn sm ghost" data-regst="cancelled" data-reg="${o.id}">Отменить</button>`:""}
        ${o.status==="refund_requested"?`<button class="btn sm" data-regst="refunded" data-reg="${o.id}">Возврат сделан</button><button class="btn sm ghost" data-regst="paid" data-reg="${o.id}">Оставить заявку</button>`:""}</div></div>`; }).join("")}</div>`
      :'<div class="empty">Заявок пока нет</div>'}`};
}
});''')
rep('''    sheet: ev.sheetUrl && !/^https:\\/\\/docs\\.google\\.com\\/spreadsheets\\//.test(ev.sheetUrl) ? "Ссылка должна вести на Google Таблицу: https://docs.google.com/spreadsheets/…" : null,\n''', '')
rx(r'\n    <label class="f">Ссылка на таблицу<input class="inp \$\{E\.sheet\?"err":""\}" id="aSheet"[^\n]*', '')

# judge review from the server
rx(r'function scoreReview\(id, s\)\{\n.*?\n\}\nfunction admEvRow', '''function scoreReview(s){
  const ev = EVENTS.find(e=>e.id===s.event); const w = ev && ev.workouts.find(x=>x.id===s.workout); if (!w) return "";
  return `<div class="card stack"><div class="row"><div class="sp"><b>${esc(s.name)}</b><div class="muted tiny">${esc(ev.name)} · ${esc(w.name)}${s.team?` · ${esc(s.team)}`:""}</div></div><span class="mono" style="font-size:18px;font-weight:700">${fmtRes(w.type,s.value)}</span></div>
   <a href="${esc(s.video)}" target="_blank" rel="noopener noreferrer" class="small" style="color:var(--accent);word-break:break-all">${esc(s.video)}</a>
   <div class="row"><button class="btn sm" data-sacc="${s.id}">Принять</button><button class="btn sm ghost" data-srej="${s.id}">Отклонить</button></div></div>`;
}
function admEvRow''')
rep('''  if (ds.sacc || ds.srej){ const id=ds.sacc||ds.srej; SCORES[id].state = ds.sacc?"accepted":"rejected"; render(); toast(ds.sacc?"Результат принят, лидерборд пересчитан":"Результат отклонён, атлет увидит статус"); return true; }''',
    '''  if (ds.sacc || ds.srej){ const id=ds.sacc||ds.srej, ok=!!ds.sacc; api("PATCH","/api/admin/scores/"+id,{state:ok?"accepted":"rejected"}).then(async()=>{ ADM.PENDING=ADM.PENDING.filter(x=>String(x.id)!==String(id)); await loadContent(); render(); toast(ok?"Результат принят, лидерборд пересчитан":"Результат отклонён, атлет увидит статус"); }).catch(err=>toast(err.message)); return true; }
  if (ds.regst){ api("PATCH","/api/admin/regs/"+encodeURIComponent(ds.reg),{status:ds.regst}).then(async r=>{ const i=ADM.REGS.findIndex(x=>x.id===r.order.id); if(i>=0) ADM.REGS[i]={...ADM.REGS[i],...r.order}; await loadContent(); render(); toast("Статус заявки обновлён"); }).catch(err=>toast(err.message)); return true; }
  if (ds.act==="regcsv"){ const ev=curEv(); downloadCsv(`uchastniki-${ev.id}.csv`, [SHEET_COLS, ...sheetRows(ev)]); return true; }''')
rep('''  const pend = Object.entries(SCORES).filter(([,v])=>v.state==="pending");''', '''  const pend = ADM.PENDING;''')
rep('''${pend.length?`<div class="stack cards">${pend.map(([id,s])=>scoreReview(id,s)).join("")}</div>`:'<div class="empty">Новых результатов нет</div>'}''',
    '''${pend.length?`<div class="stack cards">${pend.map(scoreReview).join("")}</div>`:'<div class="empty">Новых результатов нет</div>'}''')
rep('''${pend.length?`<h2 class="sec">Результаты на проверке · ${pend.length}</h2><div class="stack">${pend.map(([id,s])=>scoreReview(id,s)).join("")}</div>`:""}''',
    '''${pend.length?`<h2 class="sec">Результаты на проверке · ${pend.length}</h2><div class="stack">${pend.map(scoreReview).join("")}</div>`:""}''')
rep('''  const reg = act.reduce((a,e)=>a+e.divisions.reduce((s,d)=>s+d.taken,0),0);
  const money = act.reduce((a,e)=>a+e.divisions.reduce((s,d)=>s+d.taken*d.price,0),0);''',
    '''  const actRegs = ADM.REGS.filter(o=>ACTIVE_ST.includes(o.status) && act.some(e=>e.id===o.event));
  const reg = actRegs.length, money = actRegs.reduce((a,o)=>a+(o.paid||0),0);''')
rep('''<span class="chip ${a.role==="owner"?"warn":a.role==="admin"?"ok":"neutral"}">${ROLE_L[a.role]}</span>${a.role==="owner"?"":`<button class="iconbtn sm" data-accdel="${i}" aria-label="Закрыть доступ">${IC.del}</button>`}''',
    '''<span class="chip ${a.role==="owner"?"warn":a.role==="admin"?"ok":"neutral"}">${ROLE_L[a.role]}</span>${a.role==="owner"?"":`<button class="iconbtn sm" data-accdel="${esc(a.email)}" aria-label="Закрыть доступ">${IC.del}</button>`}''')
rep('''   <p class="foot">В боевой версии данные хранятся в базе на сервере и видны всем участникам.</p>`};''', '''`};''')
rx(r'  if \(ds\.act==="accadd"\)\{\n.*?\n  \}\n  if \(ds\.accdel!==undefined\)\{[^\n]*\n', '''  if (ds.act==="accadd"){
    const name=(adm.accName||"").trim(), email=(adm.accEmail||"").trim().toLowerCase(), role=adm.accRole||"admin";
    adm.accErr = !name ? "Укажите имя" : !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) ? "Нужен email, под которым человек входит на сайт" : ACCESS.some(a=>a.email===email) ? "У этого человека уже есть доступ" : null;
    if (adm.accErr){ render(); return true; }
    api("POST","/api/admin/staff",{name,email,role}).then(()=>{ ACCESS.push({name,email,role}); adm.accName=""; adm.accEmail=""; render(); toast(`${name} получил доступ: ${ROLE_L[role]}. Пусть войдёт на сайт по email ${email}`); }).catch(err=>{ adm.accErr=err.message; render(); });
    return true;
  }
  if (ds.accdel!==undefined){ const a=ACCESS.find(x=>x.email===ds.accdel); if (a && a.role!=="owner") api("DELETE","/api/admin/staff/"+encodeURIComponent(a.email)).then(()=>{ ACCESS=ACCESS.filter(x=>x!==a); render(); toast(`Доступ ${a.name} закрыт`); }).catch(err=>toast(err.message)); return true; }
''')
rx(r'  if \(ds\.act==="freset"\)\{[^\n]*\n  if \(ds\.act==="fresetno"\)\{[^\n]*\n  if \(ds\.act==="fresetyes"\)\{[^\n]*\n', '')
rep('''  if (ds.viewas){ S.viewAs=ds.viewas; render(); toast(`Теперь вы видите сайт как «${ROLE_L[ds.viewas]}»`); return true; }\n''', '')
rep('''    const name = ev.name || "Старт";
    EVENTS.splice(EVENTS.indexOf(ev),1);
    ORDERS = ORDERS.filter(o=>o.event!==ev.id);
    Object.keys(TEAMS).filter(k=>k.startsWith(ev.id+":")).forEach(k=>delete TEAMS[k]);''',
    '''    const name = ev.name || "Старт";
    if (ADM.REGS.some(o=>o.event===ev.id && ACTIVE_ST.includes(o.status))){ adm.delAsk=false; render(); toast("На старт есть заявки. Отмените их или верните деньги, затем удалите старт"); return true; }
    EVENTS.splice(EVENTS.indexOf(ev),1);''')
rep('''const ADMIN_ROUTES = ["adminClub","admin","adminEvent","adminDiv","adminWod","adminSch","adminPeople","adminPromo"];
function allowed(route){
  if (!ADMIN_ROUTES.includes(route)) return true;
  if (S.viewAs==="athlete") return false;''',
    '''const ADMIN_ROUTES = ["adminClub","admin","adminEvent","adminDiv","adminWod","adminSch","adminPeople","adminPromo"];
const LOGIN_ROUTES = ["me","orders","score","profile","form","team","teamCreate","teamJoin","done",...ADMIN_ROUTES];
function allowed(route){
  if (!ADMIN_ROUTES.includes(route)) return true;
  if (!["owner","admin","judge"].includes(S.viewAs)) return false;''')

# ---------- club: trial form and leads go to the server ----------
rep('''<label class="check"><input type="checkbox" id="tOk" ${f.ok?"checked":""}><span>Согласен на обработку персональных данных</span></label>''',
    '''<label class="check"><input type="checkbox" id="tOk" ${f.ok?"checked":""}><span>Даю <a href="/docs/consent" target="_blank">согласие на обработку персональных данных</a> и ознакомлен с <a href="/docs/privacy" target="_blank">политикой</a></span></label>''')
rep('''    <button class="btn block" type="submit">Записаться на пробную</button>
  </form>`;''', '''    ${fErr(e.send)}
    <button class="btn block" type="submit" ${T.busy?"disabled":""}>${T.busy?"Отправляю…":"Записаться на пробную"}</button>
  </form>`;''')
rep('''  CLUB_LEADS.push({id:"L-"+Date.now().toString(36),date:TODAY,name:f.name.trim(),phone:f.phone.trim(),dir:f.dir||TRIAL_DIRS[0],who:f.who||TRIAL_WHO[0],age:f.age.trim(),time:f.time||TRIAL_TIME[0],status:"new"});
  S.trial={f:{},err:{},sent:f.name.trim()}; render(); document.getElementById("trial").scrollIntoView({block:"start"});''',
    '''  S.trial.busy=true; { const y=window.scrollY; render(); window.scrollTo(0,y); }
  api("POST","/api/lead",{name:f.name.trim(),phone:f.phone.trim(),dir:f.dir||TRIAL_DIRS[0],who:f.who||TRIAL_WHO[0],age:(f.age||"").trim(),time:f.time||TRIAL_TIME[0],consent:true})
    .then(()=>{ S.trial={f:{},err:{},sent:f.name.trim()}; render(); document.getElementById("trial").scrollIntoView({block:"start"}); })
    .catch(err=>{ S.trial.busy=false; S.trial.err={send:err.message}; const y=window.scrollY; render(); window.scrollTo(0,y); });''')
rep('''leads.map(l=>{ const i=CLUB_LEADS.indexOf(l); return''', '''leads.map(l=>{ const i=l.id; return''')
rep('''  if (ds.leaddone!==undefined){ CLUB_LEADS[+ds.leaddone].status="done"; render(); return true; }
  if (ds.leaddel!==undefined){ const l=CLUB_LEADS.splice(+ds.leaddel,1)[0]; render(); toast(`Заявка ${l.name} удалена`); return true; }''',
    '''  if (ds.leaddone!==undefined){ const l=CLUB_LEADS.find(x=>String(x.id)===ds.leaddone); api("PATCH","/api/admin/leads/"+l.id,{status:"done"}).then(()=>{ l.status="done"; render(); }).catch(err=>toast(err.message)); return true; }
  if (ds.leaddel!==undefined){ const l=CLUB_LEADS.find(x=>String(x.id)===ds.leaddel); api("DELETE","/api/admin/leads/"+l.id).then(()=>{ CLUB_LEADS=CLUB_LEADS.filter(x=>x!==l); render(); toast(`Заявка ${l.name} удалена`); }).catch(err=>toast(err.message)); return true; }''')
rep('''Скачать CSV для Google таблицы''', '''Скачать таблицу для Excel''')
rx(r'(  if \(ds\.act==="leadcsv"\)\{\n)    const q = v => .*?\n(    const rows = )', '  if (ds.act==="leadcsv"){\n    const rows = ')
rx(r'    const blob = new Blob\(\["﻿"\+rows\.map\(r=>r\.map\(q\)\.join\(";"\)\)\.join\("\\n"\)\], \{type:"text/csv"\}\);\n    const a=document\.createElement\("a"\); a\.href=URL\.createObjectURL\(blob\); a\.download="record-zayavki\.csv"; document\.body\.appendChild\(a\); a\.click\(\); a\.remove\(\);\n    toast\("Файл record-zayavki\.csv сохранён"\); return true;',
   '    downloadCsv("record-zayavki.csv", rows); return true;')
rep('''<footer class="cfoot">${LOGO}<div>© ООО «Центр спорта «Рекорд» · ИНН 3808303298 · ОГРН 1263800012607</div>''',
    '''<footer class="cfoot">${LOGO}<div>© ООО «Центр спорта «Рекорд» · ИНН 3808303298 · ОГРН 1263800012607</div><nav class="docs" aria-label="Документы">${DOC_LINKS}</nav>''')

# ---------- persistence: server API instead of browser storage ----------
rx(r'/\* ---------- persistence: browser storage always, plus a JSON file on disk when chosen ---------- \*/\n.*?\ndocument\.getElementById\("docIn"\)', '''/* ---------- server API ---------- */
const DOC_LINKS = [["privacy","Политика обработки данных"],["consent","Согласие на обработку данных"],["offer","Оферта"],["rules","Условия соревнований"]].map(([k,t])=>`<a href="/docs/${k}" target="_blank">${t}</a>`).join("");
async function api(method, url, body){
  const opt = {method, headers:{}, credentials:"same-origin"};
  if (body!==undefined && method!=="GET"){ opt.headers["Content-Type"]="application/json"; opt.body=JSON.stringify(body); }
  let r; try { r = await fetch(url, opt); } catch(_){ throw new Error("Нет связи с сервером. Проверьте интернет"); }
  let data = {}; try { data = await r.json(); } catch(_){}
  if (!r.ok) throw Object.assign(new Error(data.error || "Ошибка сервера. Попробуйте ещё раз"), {status:r.status});
  return data;
}
function markMe(){
  const mine = new Set(ORDERS.map(o=>o.pub));
  Object.values(RESULTS).forEach(rows=>rows.forEach(r=>{ r.me = (r.k||[]).some(k=>mine.has(k)); }));
}
async function loadContent(){
  const c = await api("GET","/api/content");
  EVENTS.splice(0, EVENTS.length, ...(c.EVENTS||[]));
  Object.keys(TEAMS).forEach(k=>delete TEAMS[k]); Object.assign(TEAMS, c.TEAMS||{});
  Object.keys(RESULTS).forEach(k=>delete RESULTS[k]); Object.assign(RESULTS, c.RESULTS||{});
  SITE = c.SITE || {}; if (!SITE.contacts) SITE.contacts = {...CONTACT_DEF}; if (!SITE.gallery) SITE.gallery = [];
  if (c.today) TODAY = c.today;
  markMe();
  if (canEdit()) persist.last = contentJson();
}
async function loadSession(){
  const s = await api("GET","/api/session");
  USER = s.user; if (s.mailReady!==undefined) MAIL_READY = s.mailReady;
  Object.keys(ME).forEach(k=>{ if (k!=="kids") ME[k]=""; }); ME.gender="M"; ME.kids=[];
  if (USER){ Object.assign(ME, USER.profile||{}); ME.kids = USER.kids||[]; ME.email = USER.email; ORDERS = s.orders||[]; MYSCORES = s.scores||[]; }
  else { ORDERS = []; MYSCORES = []; }
  S.viewAs = USER ? USER.role : "guest";
  markMe();
  if (USER && ["owner","admin","judge"].includes(USER.role)) await loadAdmin();
}
async function loadAdmin(){
  const a = await api("GET","/api/admin/state");
  ADM = {REGS:a.REGS||[], PENDING:a.PENDING||[]};
  if (a.PROMOS) PROMOS = a.PROMOS;
  if (a.ACCESS) ACCESS = a.ACCESS;
  if (a.CLUB_LEADS) CLUB_LEADS = a.CLUB_LEADS;
  persist.last = contentJson();
}
const replaceOrder = o => { const i=ORDERS.findIndex(x=>x.id===o.id); if (i>=0) ORDERS[i]=o; else ORDERS.push(o); markMe(); };
const profileReady = () => !!(USER && ME.first && ME.last && ME.dob && ME.phone);
function needLogin(why){ S.login = {step:"email", email:(S.login&&S.login.email)||"", ok:false, err:"", why}; S.after = {route:S.route, p:S.p}; return go("login",{}); }
/* online starts where this athlete can hand in results now */
function scoreTargets(){
  const out = [];
  ORDERS.filter(o=>o.status==="paid").forEach(o=>{ const ev=EVENTS.find(e=>e.id===o.event); if (!ev || ev.format!=="online" || ev.status!=="live") return;
    if (!ev.permanent && ev.submitTo && TODAY>ev.submitTo) return;
    const ws = ev.permanent ? ev.workouts.filter(w=>w.month===curMonth(ev).id && !(ev.months||[]).some(m=>m.id===w.month&&m.done)) : ev.workouts;
    if (ws.length) out.push({o, ev, ws}); });
  return out;
}
function myPlace(o){
  const ev = EVENTS.find(e=>e.id===o.event); if (!ev) return null;
  const months = ev.permanent ? (ev.months||[]).map(m=>m.id) : [undefined];
  let best = null;
  months.forEach(m=>{ const {rows} = leaderboard(ev.id, o.div, m); const r = rows.find(x=>(x.k||[]).includes(o.pub)); if (r && (best===null || r.place<best)) best = r.place; });
  return best;
}
function syncProfile(){
  const g=id=>document.getElementById(id), v=S.p.v; if (!v || !g("pLast")) return;
  Object.assign(v,{last:g("pLast").value.trim(),first:g("pFirst").value.trim(),gender:g("pGender").value,dob:g("pDob").value,affiliate:g("pAff").value,phone:g("pPhone").value.trim(),tg:g("pTg").value.trim(),emName:g("pEm").value.trim(),emPhone:g("pEmP").value.trim()});
  v.kids.forEach((k,i)=>{ if (g("kLast"+i)) Object.assign(k,{last:g("kLast"+i).value.trim(),first:g("kFirst"+i).value.trim(),gender:g("kGender"+i).value,dob:g("kDob"+i).value}); });
}
async function submitReg(){
  const r=S.reg, f=r.f;
  f.busy=true; f.err=""; render();
  try {
    const res = await api("POST","/api/register",{event:r.ev.id,div:r.div.id,who:r.who,team:r.teamReq||null,size:f.size,affiliate:f.aff||"",promo:f.promoOk?f.promo:"",
      consents:{rules:!!f.c1,pd:!!f.c2,parent:!!f.c3,publish:!!f.c4,photo:!!f.c5}});
    ORDERS.push(res.order); markMe();
    await loadContent();
    S.stack=[]; go("done",{},false);
  } catch(err){ f.busy=false; f.err=err.message; render(); }
}
/* organizer edits: the whole content document is saved on the server a moment after each change */
const persist = { timer:null, last:"", busy:false, error:null, lastSaved:null };
const contentJson = () => JSON.stringify({EVENTS, SITE, PROMOS:PROMOS.map(({used,...p})=>p)});
function scheduleSave(){ if (!LOADED || !canEdit()) return; clearTimeout(persist.timer); persist.timer = setTimeout(saveNow, 700); }
async function saveNow(){
  if (persist.busy){ scheduleSave(); return; }
  const json = contentJson(); if (json===persist.last) return;
  persist.busy = true;
  try { await api("PUT","/api/admin/content", JSON.parse(json)); persist.last = json; persist.error = null; persist.lastSaved = new Date(); }
  catch(e){ persist.error = e.message; }
  persist.busy = false;
  const el = document.getElementById("saveState"); if (el) el.innerHTML = saveStateHtml();
  if (persist.error) toast("Не сохранилось: "+persist.error);
}
const hhmm = d => `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
function saveStateHtml(){
  if (persist.error) return '<span class="chip full">Ошибка сохранения</span>';
  if (!persist.lastSaved) return '<span class="chip neutral">Изменений нет</span>';
  return `<span class="chip ok">Сохранено в ${hhmm(persist.lastSaved)}</span>`;
}
document.getElementById("docIn")''')
rx(r'function dataCard\(\)\{\n.*?\n\}\n\n/\* ---------- QR ---------- \*/', '''function dataCard(){
  return `<div class="card stack"><div class="row"><b class="sp">Сохранение</b><span id="saveState">${saveStateHtml()}</span></div>
    <div class="muted small">Изменения сохраняются на сервере автоматически через секунду и сразу видны участникам.</div>${persist.error?fErr(persist.error):""}</div>`;
}

/* ---------- QR ---------- */''')
# document attachments: keep them small, they live in the content document
rep('const DOC_MAX = 15*1048576;', 'const DOC_MAX = 5*1048576;')
rep('`Файл ${fmtSize(f.size)} — можно до 15 МБ`', '`Файл ${fmtSize(f.size)} — можно до 5 МБ`')

# ---------- forms: login, code, profile ----------
rep('''document.addEventListener("submit", e=>{
  e.preventDefault();
  const g=id=>document.getElementById(id);''', '''document.addEventListener("submit", e=>{
  e.preventDefault();
  const g=id=>document.getElementById(id);
  if (e.target.id==="fLogin"){
    const L=S.login; L.email=g("lEmail").value.trim().toLowerCase(); L.ok=g("lOk").checked;
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(L.email)){ L.err="Проверьте email"; return render(); }
    if (!L.ok){ L.err="Нужно согласие на обработку персональных данных"; return render(); }
    L.busy=true; L.err=""; render();
    api("POST","/api/auth/code",{email:L.email,consent:true}).then(()=>{ L.busy=false; L.step="code"; render(); }).catch(err=>{ L.busy=false; L.err=err.message; render(); });
    return;
  }
  if (e.target.id==="fCode"){
    const L=S.login, code=g("lCode").value.replace(/\\D/g,"");
    if (code.length!==6){ L.err="Код — 6 цифр из письма"; return render(); }
    L.busy=true; L.err=""; render();
    api("POST","/api/auth/verify",{email:L.email,code}).then(async()=>{ await loadSession(); await loadContent(); S.login=null; const a=S.after; S.after=null; S.stack=[];
      if (a && a.route && !["login","me"].includes(a.route)){ S.route=a.route; S.p=a.p||{}; render(); } else go(profileReady()?"me":"profile",{edit:!profileReady()},false);
      toast("Вы вошли"); }).catch(err=>{ L.busy=false; L.err=err.message; render(); });
    return;
  }
  if (e.target.id==="fProfile"){
    syncProfile(); const v=S.p.v, er={};
    if (!v.last) er.last="Укажите фамилию"; if (!v.first) er.first="Укажите имя"; if (!v.dob) er.dob="Укажите дату рождения";
    if (v.phone.replace(/\\D/g,"").length<10) er.phone="Нужен телефон для связи";
    if (v.kids.some(k=>!k.first||!k.last||!k.dob)) er.kids="У каждого ребёнка нужны имя, фамилия и дата рождения";
    if (Object.keys(er).length){ S.p={...S.p,e:er}; return render(); }
    S.p={...S.p,busy:true,e:{}}; render();
    api("PUT","/api/profile",{profile:v,kids:v.kids}).then(r=>{ Object.assign(ME,r.profile); ME.kids=r.kids; USER.profile=r.profile; USER.kids=r.kids; const then=S.p.then; toast("Анкета сохранена"); if (then){ S.stack.pop(); back(); } else go("profile",{},false); })
      .catch(err=>{ S.p={...S.p,busy:false,e:{send:err.message}}; render(); });
    return;
  }''')

# ---------- render: login gate ----------
rep('''function render(){
  const out = allowed(S.route) ? SCREENS[S.route]() : SCREENS.noAccess();''', '''function render(){
  if (!LOADED){ view.innerHTML = `<div class="loading">${LOAD_ERR?esc(LOAD_ERR):"Загружаю…"}</div>`; return; }
  if (LOGIN_ROUTES.includes(S.route) && !USER && S.route!=="me"){ S.after={route:S.route,p:S.p}; S.route="login"; S.p={}; }
  const out = allowed(S.route) ? SCREENS[S.route]() : SCREENS.noAccess();''')
rep('''  if (out.after) out.after();
  if (typeof scheduleSave==="function") scheduleSave();''', '''  if (out.after) out.after();
  scheduleSave();''')
rep('''  if (ds.tabGo){ S.stack=[]; if(ds.sub){ S.route=ds.tabGo; S.p={}; go(ds.sub,{}); } else tab(ds.tabGo); return; }''',
    '''  if (ds.tabGo){ S.stack=[]; if(ds.sub){ S.route=ds.tabGo; S.p={}; if (!USER && ds.sub!=="orders"){ S.login={step:"email",email:"",ok:false,err:"",why:ds.sub==="admin"?"Вход для организаторов: используйте email, на который вам выдали доступ":""}; S.after={route:ds.sub,p:{}}; return go("login",{}); } go(ds.sub,{}); } else tab(ds.tabGo); return; }''')

# ---------- boot ----------
rx(r'const DEMO_JSON = JSON\.stringify\(snapshot\(\)\);\n.*?\nif \(restored\) toast\("Данные восстановлены"\);\n', '''if (location.hash==="#admin") S.route="admin";
if (location.hash==="#comp") S.route="home";
render();
(async()=>{
  try { await loadContent(); }
  catch(e){ LOAD_ERR = "Не получилось загрузить сайт. Обновите страницу через минуту"; render(); return; }
  try { await loadSession(); } catch(_){ USER=null; }
  LOADED = true; render();
})();
''')
rep('''ROOT_TAB = {home:"home",''', '''ROOT_TAB = {login:"me",home:"home",''')

open(P, 'w', encoding='utf-8').write(s)
print('ok', len(s))
