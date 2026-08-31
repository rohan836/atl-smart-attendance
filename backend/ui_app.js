// ============================================================
// ATL Smart Attendance — UI application script (DB-driven)
// Source: backend/ui_app.js  (spliced into the single-file HTML)
// LocalStorage is only an offline cache; SQLite /api is truth.
// ============================================================
const LS = {
  students:"atl_students", attendance:"atl_attendance", holidays:"atl_holidays",
  overrides:"atl_overrides", settings:"atl_settings", classes:"atl_classes",
  audit:"atl_audit", batches:"atl_batches",
  classSchedules:"atl_class_schedules", batchSchedules:"atl_batch_schedules"
};

// ---- state (mirrors backend SQLite) ----
let Students = [];      // mapped: id,name,roll,class,section,parent,phone,address,photo,fid,active,enroll,batch
let Attendance = [];    // mapped: id,studentId,date,time,status(UI),isDuplicate,fingerId
let Unknowns = [];      // {time, finger, note}
let Settings = {
  schoolName:"ATL Model School", academicYear:"", startDate:"", endDate:"",
  lateAfter:"08:30", presentCutoff:"08:00", address:"", workingDays:{0:false,1:true,2:true,3:true,4:true,5:true,6:true}
};
let Classes = [];
let Batches = [];
let Holidays = [];      // backend "YYYY-MM-DD:Reason" -> {start}/{name}
let Overrides = [];
let Audit = [];         // mapped from backend audit
let AllEvents = [];     // full event history (for reports + student detail)
let ClassSchedules = {}; // backend-persisted per-class weekly {class: {workingDays:{0..6}} or {0..6}}
let BatchSchedules = {}; // backend-persisted per-batch { "Grade|Batch": workingDays }
let Daily = [];         // from /api/daily
let Kpis = null;        // from /api/kpis
// backward compat alias for older cache key
let ClassSchedulesUI = ClassSchedules;
let _enrollPoll = null; let _enrollAbort = false; let _enrollCtrl = null;

// ---- helpers ----
function $(id){ return document.getElementById(id); }
function esc(s){ if(s==null) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function todayISO(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,'0')+"-"+String(d.getDate()).padStart(2,'0'); }
function parseISO(s){ return new Date(s+"T00:00:00"); }
function fmtDate(d){ if(!d) return ""; const dt=parseISO(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function inRange(d,a,b){ return d>=a && d<=b; }
async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"Content-Type":"application/json"}, opts.headers||{});
  try{
    const pin = sessionStorage.getItem("atl_admin_pin") || "";
    if(pin) opts.headers["X-Admin-Pin"] = pin;
  }catch(e){}
  opts.cache = "no-store";
  let r = await fetch(path, opts);
  let body = null;
  try{ body = await r.json(); }catch(e){}
  if(!r.ok && r.status===401 && !opts._pinRetry){
    const msg = (body&&(body.error||""))||"";
    if(msg.toLowerCase().includes("admin pin")){
      let pin = null;
      try{ pin = prompt("Admin PIN required"); }catch(e){}
      if(pin){
        try{ sessionStorage.setItem("atl_admin_pin", pin); }catch(e){}
        opts.headers = Object.assign({}, opts.headers, {"X-Admin-Pin": pin});
        opts._pinRetry = true;
        r = await fetch(path, opts);
        try{ body = await r.json(); }catch(e){ body=null; }
        if(r.ok) return body;
      }
    }
  }
  if(!r.ok){ const err = new Error((body&&(body.error||body.detail||body.reason))||("HTTP "+r.status)); err.status=r.status; err.body=body; throw err; }
  return body;
}
function statusUI(backendStatus){
  const m = {"PRESENT":"Present","LATE":"Late","ABSENT":"Absent","DUPLICATE":"Already recorded","UNKNOWN":"Unknown","NOT_SCHEDULED":"Not Scheduled"};
  return m[backendStatus] || backendStatus || "";
}
// ---- persisted cache (offline fallback) ----
function asBool(v){
  if(v===true || v===1) return true;
  if(v===false || v===0 || v==null) return false;
  if(typeof v==="string") return ["1","true","yes","on"].includes(v.trim().toLowerCase());
  return !!v;
}
function cacheSave(){
  try{
    const slim=Students.map(s=>{
      const o={}; for(const k in s){ if(k!=="photo") o[k]=s[k]; }
      return o;
    });
    localStorage.setItem(LS.students, JSON.stringify(slim));
    localStorage.setItem(LS.settings, JSON.stringify(Settings));
    localStorage.setItem(LS.classes, JSON.stringify(Classes));
    localStorage.setItem(LS.batches, JSON.stringify(Batches));
    localStorage.setItem(LS.holidays, JSON.stringify(Holidays));
    localStorage.setItem(LS.overrides, JSON.stringify(Overrides));
    localStorage.setItem(LS.audit, JSON.stringify(Audit));
    localStorage.setItem(LS.attendance, JSON.stringify(Attendance));
    localStorage.setItem(LS.classSchedules, JSON.stringify(ClassSchedules));
    localStorage.setItem(LS.batchSchedules, JSON.stringify(BatchSchedules));
    try{ localStorage.setItem("atl_daily", JSON.stringify(Daily)); }catch(e){}
    try{ localStorage.setItem("atl_kpis", JSON.stringify(Kpis)); }catch(e){}
  }catch(e){}
}
function cacheLoad(){
  try{
    const g=(k,f)=>{ const v=localStorage.getItem(k); if(v){ try{ return f(JSON.parse(v)); }catch(e){} } return null; };
    g(LS.students, v=>Students=v);
    g(LS.settings, v=>Settings=Object.assign(Settings,v));
    g(LS.classes, v=>Classes=v);
    g(LS.batches, v=>Batches=v||[]);
    g(LS.holidays, v=>Holidays=v);
    g(LS.overrides, v=>Overrides=v);
    g(LS.audit, v=>Audit=v);
    g(LS.attendance, v=>Attendance=v);
    g(LS.classSchedules, v=>{ ClassSchedules=v||{}; ClassSchedulesUI=ClassSchedules; });
    g(LS.batchSchedules, v=>BatchSchedules=v||{});
    g("atl_daily", v=>Daily=v||[]);
    g("atl_kpis", v=>Kpis=v);
    // migrate old UI-only key if present
    try{
      const old = localStorage.getItem("atl_class_schedules_ui");
      if(old && (!ClassSchedules || !Object.keys(ClassSchedules).length)){
        const parsed = JSON.parse(old);
        if(parsed && typeof parsed==="object"){ ClassSchedules=parsed; ClassSchedulesUI=parsed; }
      }
    }catch(e){}
  }catch(e){}
}

// ---- backend -> UI mappings ----
function mapStudent(b){
  return {
    id: b.id, name: b.name, roll: b.roll, class: b.grade||"", section: b.section||"",
    parent: b.parent||b.parent_name||"", phone: b.phone||"", address: b.address||"", batch: b.batch||b.group||"",
    photo: b.photo||"",
    fid: (b.fingerId!==null&&b.fingerId!==undefined) ? "F-"+b.fingerId : "",
    active: b.active!==0 && b.active!==false,
    enroll: b.createdAt||b.enroll_date||""
  };
}
function mapEvent(e){
  return {
    id: e.rowid||e.id||String(Math.random()), studentId: e.studentId,
    date: e.date, time: e.time,
    status: statusUI(e.status||e.result), isDuplicate: (e.status==="DUPLICATE"),
    fingerId: e.fingerId
  };
}
function mapHoliday(s){ return mapHolidayFromList(s); }

// ---- data load from backend ----
function mapOverride(s){
  const parts = s.split(":"); const date = parts[0] || "";
  const working = (parts[1] === "1");
  const note = parts.slice(2).join(":") || "";
  return {date, isWorking: working, note};
}
function mapHolidayFromList(s){
  if(s && typeof s === "object"){
    const start=String(s.start||s.date||"").slice(0,10), end=String(s.end||start).slice(0,10);
    return {name:String(s.name||"Holiday"), start, end, category:String(s.category||""), type:String(s.type||"holiday")};
  }
  s=String(s||"");
  const i=s.indexOf(":"), head=i>=0?s.slice(0,i):s, span=head.split(".."), start=span[0].slice(0,10), end=(span[1]||span[0]).slice(0,10);
  const rest=i>=0?s.slice(i+1):"Holiday", parts=rest.split(":");
  const typed=parts.length>1 && ["holiday","vacation","exam"].includes(parts[0].toLowerCase());
  return {name:typed?parts.slice(1).join(":"):(rest||"Holiday"), start, end, category:"", type:typed?parts[0].toLowerCase():"holiday"};
}
async function loadClassesHolidaysSettings(){
  try{
    const st = await api("/api/settings", {method:"GET"});
    Settings.schoolName = st.schoolName || Settings.schoolName;
    Settings.academicYear = st.academicYear || Settings.academicYear;
    Settings.startDate = st.attendanceStartDate || st.schoolOpeningDate || Settings.startDate;
    Settings.endDate = st.endDate || st.academicYearEnd || Settings.endDate;
    Settings.lateAfter = st.lateCutoff || Settings.lateAfter || "08:30";
    Settings.presentCutoff = st.presentCutoff || Settings.presentCutoff || "08:00";
    Settings.lateCutoff = st.lateCutoff || Settings.lateAfter || "08:30";
    Classes = (st.classes&&st.classes.length) ? st.classes.slice() : Classes;
    if(Array.isArray(st.batches)) Batches = st.batches.slice();
    else if(Array.isArray(st.classes)) Batches = Batches || [];
    if(st.classSchedules && typeof st.classSchedules==="object") { ClassSchedules = st.classSchedules; ClassSchedulesUI = ClassSchedules; }
    if(st.batchSchedules && typeof st.batchSchedules==="object") BatchSchedules = st.batchSchedules;
    if(Array.isArray(st.holidays)) Holidays = st.holidays.map(mapHolidayFromList).filter(Boolean);
    if(st.workingDays && typeof st.workingDays==="object"){
      const wd={}; for(let i=0;i<7;i++) wd[i]=asBool(st.workingDays[i] ?? st.workingDays[String(i)]); Settings.workingDays=wd;
    }
    if(Array.isArray(st.overrides)) Overrides = st.overrides.map(mapOverride).filter(o=>o.date);
    Settings.address = st.address || Settings.address;
    if(st.minPercent!=null) Settings.minPercent = st.minPercent;
    // populate settings inputs from the DB (auto-fill)
    const set=(id,v)=>{ const el=$(id); if(el&&v!=null) el.value=v; };
    set("setSchoolName", Settings.schoolName);
    set("setSchoolAddress", Settings.address);
    set("setLateThreshold", Settings.lateAfter);
    set("setAcademicYear", Settings.academicYear);
    set("setAttendanceStart", Settings.startDate);
    // ensure calendars reflect persisted per-class/batch schedules
    cacheSave();
  }catch(e){ /* offline -> cache */ }
}
async function loadStudents(){
  try{
    const list = await api("/api/students?active=all", {method:"GET"});
    if(Array.isArray(list)){
      Students = list.map(mapStudent);
    }
  }catch(e){ /* offline -> cache */ }
}
async function loadHistory(){
  try{
    const ev = await api("/api/attendance", {method:"GET"});
    if(Array.isArray(ev)) AllEvents = ev.map(mapEvent);
  }catch(e){ /* offline */ }
}
async function loadTodayAttendance(){
  const t = todayISO();
  try{
    // reconcile today's attendance (marks ABSENT/NOT_SCHEDULED after lateCutoff; backend guards BEFORE_CUTOFF)
    if(!(typeof document!=="undefined" && document.hidden)){
      try{ await api("/api/reconcile",{method:"POST",body:JSON.stringify({date:t})}); }catch(e){}
    }
    const ev = await api("/api/attendance?date="+t, {method:"GET"});
    if(Array.isArray(ev)){
      Attendance = ev.map(mapEvent).filter(a=>a.studentId||a.status==="Unknown");
      Unknowns = ev.filter(e=>(e.result==="UNKNOWN"||e.status==="UNKNOWN")).map(e=>({time:e.time, finger:(e.fingerId!=null?"F-"+e.fingerId:"-"), note:"Unknown fingerprint"}));
    }
    try{
      const daily = await api("/api/daily?date="+t,{method:"GET"});
      if(Array.isArray(daily)) Daily = daily;
    }catch(e){}
    try{
      const k = await api("/api/kpis?date="+t,{method:"GET"});
      if(k && typeof k==="object" && "scheduled" in k) Kpis = k;
    }catch(e){}
    try{
      const au = await api("/api/audit", {method:"GET"});
      if(Array.isArray(au)) Audit = au.map(a=>({time:a.at, action:a.action, details:a.details, by:"Admin"}));
    }catch(e){}
  }catch(e){ /* offline */ }
}
async function loadAll(){
  await loadClassesHolidaysSettings();
  await loadStudents();
  await loadHistory();
  await loadTodayAttendance();
  cacheSave();
  renderAll();
}
// ---- DOM ----
const promptText=$("promptText"),
  leftClock=$("leftClock"), idleLayer=$("idleLayer"),
  identityLayer=$("identityLayer"), unknownLayer=$("unknownLayer"),
  photoImg=$("photoImg"), photoFallback=$("photoFallback"),
  idName=$("idName"), idSub=$("idSub"), idStatus=$("idStatus"), idTime=$("idTime"),
  idDate=$("idDate"), idConfirm=$("idConfirm"), idConfirmTxt=$("idConfirm"),
  idRoll=$("idRoll"), idClass=$("idClass"), idGroup=$("idGroup"), idSid=$("idSid"),
  unknownTitleEl=$("unknownTitle"),
  adminLayer=$("adminLayer"), adminNav=$("adminNav"), adminTitle=$("adminTitle"),
  studentListEl=$("studentList"), searchInput=$("searchInput"), classFilter=$("classFilter"), batchFilter=$("batchFilter"), studentStatusFilter=$("studentStatusFilter"),
  detailScroll=$("detailScroll"),
  todayDateLabel=$("todayDateLabel"), todayClassFilter=$("todayClassFilter"),
  todayStatusFilter=$("todayStatusFilter"), todaySort=$("todaySort"),
  todayStats=$("todayStats"), todayTableBody=$("todayTableBody"), todayUnknownBody=$("todayUnknownBody"),
  reportScope=$("reportScope"), reportClass=$("reportClass"), reportStudent=$("reportStudent"),
  reportTime=$("reportTime"), reportFrom=$("reportFrom"), reportTo=$("reportTo"),
  reportStats=$("reportStats"), reportBody=$("reportBody"),
  holidayBody=$("holidayBody"), overrideBody=$("overrideBody"),
  calendarGrid=$("calendarGrid"), calMonthLabel=$("calMonthLabel"),
  classBody=$("classBody"), auditBody=$("auditBody"),
  enrollModal=$("enrollModal"), holidayModal=$("holidayModal"),
  overrideModal=$("overrideModal"), correctionModal=$("correctionModal"),
  enrollTitle=$("enrollTitle"), enrollSub=$("enrollSub"), enrollBody=$("enrollBody");

const Timers={ _ids:{}, set(n,id){ this.clear(n); this._ids[n]=id; },
  clear(n){ if(this._ids[n]){ clearTimeout(this._ids[n]); clearInterval(this._ids[n]); } delete this._ids[n]; },
  clearAll(){ Object.keys(this._ids).forEach(k=>{ clearTimeout(this._ids[k]); clearInterval(this._ids[k]); }); this._ids={}; } };
let currentTab="students", selectedStudentId=null, calendarMonth=new Date();

function openModal(m){ m.classList.add("open"); }
function closeModal(m){ m.classList.remove("open"); }
[enrollModal, holidayModal, overrideModal, correctionModal].forEach(m=>{
  if(!m) return;
  m.addEventListener("click", (e)=>{
    if(e.target!==m) return;
    if(m===enrollModal){ _enrollAbort=true; if(_enrollPoll) clearTimeout(_enrollPoll); }
    closeModal(m);
    if(m===enrollModal) resumeSensorScan();
  });
});

// ---- terminal ----
let _resultHold=false;
function setResultVisible(on){
  const t=$("terminal");
  if(t) t.classList.toggle("has-result", !!on);
}
function hidePrompt(){
  if(!promptText) return;
  promptText.classList.remove("scanning","identifying","detecting");
  promptText.classList.add("is-hidden");
  promptText.style.opacity="";
  promptText.style.transform="";
}
function groupLabel(student){
  const parts=[];
  if(student && student.section) parts.push(student.section);
  if(student && student.batch) parts.push(student.batch);
  return parts.length ? parts.join(" · ") : "—";
}
function setState(state){
  if(!promptText) return;
  promptText.classList.remove("scanning","identifying","detecting","is-hidden");
  promptText.style.opacity="";
  promptText.style.transform="";
  if(state==="identifying" || state==="detecting" || state==="scanning"){
    promptText.textContent="IDENTIFYING\u2026";
    promptText.classList.add("identifying");
  } else {
    promptText.textContent="PLACE YOUR FINGER";
  }
}
function showIdentity(student, status, time, dateStr){
  hidePrompt();
  setResultVisible(true);
  _resultHold=true;
  if(_scanLoopTimer){ clearTimeout(_scanLoopTimer); _scanLoopTimer=null; }
  Timers.clear("hold");
  if(idleLayer) idleLayer.classList.add("hidden");
  if(unknownLayer) unknownLayer.classList.remove("visible");
  if(student.photo){ photoImg.src=student.photo; photoImg.style.display="block"; photoFallback.style.display="none"; }
  else { photoImg.style.display="none"; photoFallback.style.display="flex"; photoFallback.textContent=(student.name||"").trim().split(" ").map(w=>w[0]).filter(Boolean).slice(0,2).join("").toUpperCase()||"—"; }
  if(idName) idName.textContent=student.name||"—";
  if(idRoll) idRoll.textContent=student.roll||"—";
  if(idClass) idClass.textContent=student.class||student.grade||"—";
  if(idGroup) idGroup.textContent=groupLabel(student);
  if(idSid) idSid.textContent=student.id!=null?String(student.id):"—";
  const norm = String(status||"").trim().toLowerCase();
  let displayStatus = status;
  let footer = "ATTENDANCE RECORDED";
  let muted = false;
  let holdMs = 4000;
  if(norm==="present"){
    displayStatus="Present";
    footer="ATTENDANCE RECORDED";
  } else if(norm==="late"){
    displayStatus="Late";
    footer="ATTENDANCE RECORDED";
  } else if(norm==="already recorded" || norm==="duplicate"){
    displayStatus="Already recorded";
    footer="ALREADY RECORDED";
    muted=true;
    holdMs=3200;
  } else if(norm==="not scheduled" || norm==="not_scheduled"){
    displayStatus="Not Scheduled";
    footer="NOT SCHEDULED";
    muted=true;
    holdMs=3200;
  } else {
    displayStatus=status||"—";
  }
  if(idStatus){
    idStatus.textContent=displayStatus;
    idStatus.style.color = muted ? "var(--ink-2)" : "var(--ink)";
  }
  if(idTime) idTime.textContent=(time||"").slice(0,5)||"—";
  if(idDate) idDate.textContent=dateStr||"";
  if(idConfirm){
    idConfirm.textContent=footer;
    idConfirm.classList.toggle("is-muted", muted);
    idConfirm.style.color="";
    idConfirm.style.display="";
  }
  identityLayer.classList.add("visible");
  Timers.set("hold", setTimeout(()=>{
    identityLayer.classList.remove("visible");
    if(idleLayer) idleLayer.classList.remove("hidden");
    setResultVisible(false);
    setState("ready");
    _resultHold=false;
    if(_scanLoopActive && adminLayer && !adminLayer.classList.contains("open") && enrollModal && !enrollModal.classList.contains("open")){
      _scanLoopTimer=setTimeout(sensorScanLoop, 180);
    }
  }, holdMs));
}
function showUnknown(){
  hidePrompt();
  setResultVisible(true);
  _resultHold=true;
  if(_scanLoopTimer){ clearTimeout(_scanLoopTimer); _scanLoopTimer=null; }
  Timers.clear("hold");
  if(idleLayer) idleLayer.classList.add("hidden");
  identityLayer.classList.remove("visible");
  const _ut = unknownTitleEl || (unknownLayer && unknownLayer.querySelector(".unknown-title"));
  if(_ut) _ut.textContent="NOT RECOGNIZED";
  unknownLayer.classList.add("visible");
  Timers.set("hold", setTimeout(()=>{
    unknownLayer.classList.remove("visible");
    if(idleLayer) idleLayer.classList.remove("hidden");
    setResultVisible(false);
    setState("ready");
    _resultHold=false;
    if(_scanLoopActive && adminLayer && !adminLayer.classList.contains("open") && enrollModal && !enrollModal.classList.contains("open")){
      _scanLoopTimer=setTimeout(sensorScanLoop, 180);
    }
  }, 2800));
}
function tickClock(){
  if(!leftClock) return;
  const n=new Date();
  leftClock.textContent=n.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+" · "+n.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
}
if(leftClock){ Timers.set("clock", setInterval(tickClock,1000)); tickClock(); }

// Real scan hook (called by the sensor loop and the injected backend bridge)
let _lastHandledScanSeq=0;
function upsertStudent(raw){
  if(!raw || raw.id==null) return null;
  const mapped=mapStudent(raw);
  const idx=Students.findIndex(x=>x.id===mapped.id);
  if(idx>=0){
    const merged=Object.assign({}, Students[idx]);
    Object.keys(mapped).forEach(k=>{
      if(mapped[k]!==undefined && mapped[k]!==null) merged[k]=mapped[k];
    });
    if(!merged.fid && Students[idx].fid) merged.fid=Students[idx].fid;
    if(!merged.photo && Students[idx].photo) merged.photo=Students[idx].photo;
    Students[idx]=merged;
  } else Students.push(mapped);
  return Students.find(x=>x.id===mapped.id);
}
function studentByFid(fid){
  const n=String(fid||"").replace(/^F-/i,"");
  if(!n) return null;
  return Students.find(x=>String(x.fid||"").replace(/^F-/i,"")===n) || null;
}
window.handleRealScan = async function(fid, info){
  info = info || {};
  const seq=Number(info.seq||0);
  if(seq && seq<=_lastHandledScanSeq) return;
  if(seq) _lastHandledScanSeq=seq;
  if(fid && String(fid).indexOf("__unknown__")===0){
    setState("identifying");
    await new Promise(r=>setTimeout(r, 180));
    if(seq && seq < _lastHandledScanSeq) return;
    showUnknown();
    loadTodayAttendance().then(()=>{ if(currentTab==="today") renderToday(); });
    return;
  }
  let s = info.student ? upsertStudent(info.student) : null;
  if(!s) s = studentByFid(fid);
  if(!s){
    try{
      if(!Students.length) await loadStudents();
      s = studentByFid(fid);
      if(!s && fid){
        const last = await api("/api/scan/last",{method:"GET"}).catch(()=>null);
        if(last && last.student) s = upsertStudent(last.student);
      }
    }catch(e){}
  }
  if(!s){
    setState("identifying");
    await new Promise(r=>setTimeout(r, 180));
    if(seq && seq < _lastHandledScanSeq) return;
    showUnknown();
    loadTodayAttendance().then(()=>{ if(currentTab==="today") renderToday(); });
    return;
  }
  setState("identifying");
  await new Promise(r=>setTimeout(r, 180));
  if(seq && seq < _lastHandledScanSeq) return;
  const status = info.status ? statusUI(info.status) : "Present";
  const time = info.time || new Date().toTimeString().slice(0,8);
  showIdentity(s, status, time, info.date ? fmtDate(info.date) : "");
  loadTodayAttendance().then(()=>{ if(currentTab==="today") renderToday(); });
};
let _scanLoopActive=true, _scanRequestInFlight=false, _scanLoopTimer=null;
function pauseSensorScan(){ _scanLoopActive=false; if(_scanLoopTimer){ clearTimeout(_scanLoopTimer); _scanLoopTimer=null; } if(promptText){ promptText.classList.remove("scanning","identifying","detecting","is-hidden"); } }
function resumeSensorScan(){
  _scanLoopActive=true;
  if(!_resultHold) setState("ready");
  if(_scanRequestInFlight){
    if(!_scanLoopTimer) _scanLoopTimer=setTimeout(sensorScanLoop, 400);
    return;
  }
  if(_scanLoopTimer){ clearTimeout(_scanLoopTimer); _scanLoopTimer=null; }
  sensorScanLoop();
}
function finishEnrollUi(){
  _enrollAbort=true;
  if(_enrollPoll){ clearTimeout(_enrollPoll); _enrollPoll=null; }
  if(enrollModal) closeModal(enrollModal);
}
function returnToFrontPage(rawStudent){
  finishEnrollUi();
  if(rawStudent) upsertStudent(rawStudent);
  try{ cacheSave(); }catch(e){}
  if(adminLayer) adminLayer.classList.remove("open");
  resumeSensorScan();
}
async function sensorScanLoop(){
  if(!_scanLoopActive || _scanRequestInFlight) return;
  if(_resultHold){ _scanLoopTimer=setTimeout(sensorScanLoop, 180); return; }
  if(adminLayer && adminLayer.classList.contains("open")){ _scanLoopTimer=setTimeout(sensorScanLoop,500); return; }
  if(enrollModal && enrollModal.classList.contains("open")){ _scanLoopTimer=setTimeout(sensorScanLoop,500); return; }
  _scanRequestInFlight=true;
  let nextDelay=150;
  try{
    const res=await api("/api/scan",{method:"POST",body:JSON.stringify({waitSec:2})});
    if(res && res.seq !== undefined && res.seq !== null){
      if(res.student){
        upsertStudent(res.student);
        cacheSave();
        const fidNum = (res.student.fingerId!=null && res.student.fingerId!==undefined) ? res.student.fingerId : res.fingerId;
        const fid = (fidNum!=null && fidNum!==undefined) ? "F-"+fidNum : ("__stu__"+res.student.id);
        await window.handleRealScan(fid,{status:res.status||res.reason,time:res.time,date:res.date,seq:res.seq,student:res.student});
      } else if(res.reason==="UNKNOWN" || res.status==="UNKNOWN"){
        await window.handleRealScan("__unknown__"+res.seq,{seq:res.seq});
      }
    }
  }catch(err){
    const reason=err.body&&err.body.reason;
    if(reason!=="NO_FINGER") nextDelay=2000;
    if(reason!=="NO_FINGER" && reason!=="SENSOR_BUSY" && reason!=="SENSOR_DISCONNECT") console.warn("Sensor scan:",err.message);
  }finally{
    _scanRequestInFlight=false;
    if(_scanLoopActive){
      if(_resultHold){
        // hold active — result visible, do not overwrite prompt or schedule duplicate
      } else {
        setState("ready");
        _scanLoopTimer=setTimeout(sensorScanLoop,nextDelay);
      }
    }
  }
}
// ---- render: Students ----
function renderClassFilters(){
  const opts=['<option value="">All Classes</option>'].concat(Classes.map(c=>`<option>${esc(c)}</option>`)).join("");
  if(classFilter) classFilter.innerHTML=opts;
  if(todayClassFilter) todayClassFilter.innerHTML=opts;
  reportClass.innerHTML='<option value="">Select class</option>'+Classes.map(c=>`<option>${esc(c)}</option>`).join("");
  if(batchFilter){
    const batches=[...new Set([...(Batches||[]), ...Students.map(s=>s.batch).filter(Boolean)])].sort();
    const cur=batchFilter.value;
    batchFilter.innerHTML='<option value="">All Batches</option>'+batches.map(b=>`<option ${b===cur?'selected':''}>${esc(b)}</option>`).join("");
    if(!batches.includes(cur)) batchFilter.value="";
  }
  // also populate per-class schedule selector
  const calSel=$("calClassSelect");
  if(calSel){
    const cur=calSel.value;
    calSel.innerHTML='<option value="">All classes (global)</option>'+Classes.map(c=>`<option ${c===cur?'selected':''}>${esc(c)}</option>`).join("");
  }
}
function renderStudentList(){
  const q=(searchInput.value||"").toLowerCase(), cf=classFilter?classFilter.value:"", bf=batchFilter?batchFilter.value:"", sf=studentStatusFilter?studentStatusFilter.value:"active";
  let list=Students.filter(s=>{
    if(sf==="active" && !s.active) return false;
    if(sf==="inactive" && s.active) return false;
    if(cf && s.class!==cf) return false;
    if(bf && (s.batch||"")!==bf) return false;
    if(!q) return true;
    return (s.name+" "+s.roll+" "+s.class+" "+(s.batch||"")+" "+s.phone+" "+s.fid+" "+s.id+" "+(s.section||"")+" "+(s.parent||"")).toLowerCase().includes(q);
  });
  list.sort((a,b)=> (b.active - a.active) || a.name.localeCompare(b.name));
  if(!list.length){ studentListEl.innerHTML=`<div class="empty"><b>No students found</b>Try different search or add a new student.</div>`; return; }
  studentListEl.innerHTML=list.map(s=>{
    const initials=s.name.trim().split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
    const thumb=s.photo?`<img src="${esc(s.photo)}" alt="">`:`<div class="student-thumb-fallback">${esc(initials)}</div>`;
    const batchTxt=s.batch?` · ${esc(s.batch)}`:"";
    const inactiveBadge = s.active ? "" : `<span class="badge" style="margin-left:6px">Inactive</span>`;
    const rowStyle = s.active ? "" : ` style="opacity:0.6"`;
    return `<div class="student-row ${selectedStudentId===s.id?"active":""}" data-id="${s.id}"${rowStyle}><div class="student-thumb">${thumb}</div><div class="student-info"><div class="student-name">${esc(s.name)}${inactiveBadge}</div><div class="student-meta"><span>${esc(s.roll)}</span><span>${esc(s.class)}${batchTxt}</span><span class="student-roll">${esc(s.fid||"no fp")}</span></div></div></div>`;
  }).join("");
}
function studentStats(s){
  const start=Settings.startDate||todayISO(), today=todayISO();
  const rows=Attendance.filter(a=>a.studentId===s.id && a.date>=start && a.date<=today);
  const present=rows.filter(a=>a.status==="Present").length;
  const late=rows.filter(a=>a.status==="Late").length;
  const dup=rows.filter(a=>a.isDuplicate).length;
  const workdays=Math.max(1, 30); // backend-computed elsewhere; display today-recent
  const pct=rows.length?Math.round(((present+late)/(present+late+(rows.filter(a=>a.status==="Absent").length||0)))*100):100;
  return {present,late,absent:0,pct,working:workdays};
}
function renderStudentDetail(id){
  const s=Students.find(x=>x.id===id);
  if(!s){ detailScroll.innerHTML=`<div class="empty"><b>No student selected</b>Choose a student.</div>`; return; }
  const initials=s.name.trim().split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();
  const photo=s.photo?`<img src="${esc(s.photo)}" alt="">`:`<div class="detail-photo-fallback">${esc(initials)}</div>`;
  const history=Attendance.filter(a=>a.studentId===s.id).slice(-60).reverse();
  const histRows=history.length?history.map(a=>`<tr><td>${esc(a.date)}</td><td>${esc(a.time)}</td><td><span class="badge ${a.status.toLowerCase().replace(" ","-")}">${esc(a.status)}</span></td><td>${esc(a.fingerId!=null?"F-"+a.fingerId:"")}</td><td><button class="btn" data-correct data-correct-sid="${s.id}" data-correct-date="${esc(a.date)}" data-correct-status="${esc(a.status)}" style="height:22px;padding:0 8px;font-size:9px">Correct</button></td></tr>`).join(""):`<tr><td colspan="5"><div class="empty"><b>No records</b>Scan results will appear here from the sensor.</div></td></tr>`;
  detailScroll.innerHTML=`
    <div class="detail-card">
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div class="detail-photo">${photo}</div>
        <div style="flex:1 1 280px;min-width:0">
          <div style="font-family:var(--serif);font-size:30px;text-transform:uppercase;letter-spacing:-0.02em;line-height:0.95">${esc(s.name)}</div>
          <div style="margin-top:8px"><span class="badge ${s.active?'present':'not-scheduled'}">${esc(s.active?"Active":"Inactive")}</span>${s.batch?` <span class="badge">${esc(s.batch)}</span>`:""}</div>
          <div class="detail-grid">
            <div class="detail-field"><label>Roll</label><span>${esc(s.roll)}</span></div>
            <div class="detail-field"><label>Class</label><span>${esc(s.class)}</span></div>
            <div class="detail-field"><label>Batch / Group</label><span>${esc(s.batch||"—")}</span></div>
            <div class="detail-field"><label>Section</label><span>${esc(s.section||"—")}</span></div>
            <div class="detail-field"><label>Student ID</label><span>${esc(String(s.id))}</span></div>
            <div class="detail-field"><label>Parent</label><span>${esc(s.parent||"—")}</span></div>
            <div class="detail-field"><label>Phone</label><span>${esc(s.phone||"—")}</span></div>
            <div class="detail-field"><label>Address</label><span>${esc(s.address||"—")}</span></div>
            <div class="detail-field"><label>Fingerprint</label><span>${esc(s.fid||"—")} · ${s.active?"Active":"Inactive"}</span></div>
          </div>
          <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" data-action="edit" data-id="${s.id}">Edit information</button>
            <button class="btn" data-action="reenroll" data-id="${s.id}">Re-enroll fingerprint</button>
            ${s.active ? `<button class="btn danger" data-action="delete" data-id="${s.id}">Deactivate</button>` : `<button class="btn primary" data-action="reactivate" data-id="${s.id}">Re-activate</button>`}
            <button class="btn" data-action="print" data-id="${s.id}">Print profile</button>
            <button class="btn" data-correct data-correct-sid="${s.id}" data-correct-date="${esc(todayISO())}" data-correct-status="Present" style="border-style:dashed">Correct today</button>
          </div>
        </div>
      </div>
      <div class="table-wrap"><div style="padding:10px 12px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;border-bottom:1px solid var(--line)"><span>Attendance history — recent scans</span></div><div class="table-scroll large"><table><thead><tr><th>Date</th><th>Time</th><th>Status</th><th>Fingerprint</th><th>Action</th></tr></thead><tbody>${histRows}</tbody></table></div></div>
    </div>`;
}
function selectStudent(id){ selectedStudentId=id; renderStudentList(); renderStudentDetail(id); }
// ---- render: Today ----
function renderToday(){
  const t=todayISO(), cf=todayClassFilter.value, sf=todayStatusFilter.value, sort=todaySort.value;
  const byId=new Map(Students.map(s=>[s.id,s]));
  let rows=Attendance.filter(a=>a.date===t && a.studentId).map(a=>{ const s=byId.get(a.studentId); return s?{a,s}:null; }).filter(Boolean);
  if(cf) rows=rows.filter(r=>r.s.class===cf);
  // backend-persisted schedule: determine scheduled vs not scheduled via per-student precedence
  const allActiveFiltered = Students.filter(s=>s.active && (!cf || s.class===cf));
  const scheduledFiltered = allActiveFiltered.filter(s=> isWorkingDayForStudent(t, s));
  const notScheduledFiltered = allActiveFiltered.filter(s=> !isWorkingDayForStudent(t, s));
  const isGlobalWorking = isWorkingDayUI(t);
  if(sf){
    if(sf==="Duplicate") rows=rows.filter(r=>r.a.isDuplicate);
    else if(sf==="Unknown") rows=rows.filter(r=>false);
    else if(sf==="Not Scheduled"){
      // show not-scheduled students as muted rows (UI preview)
      rows = notScheduledFiltered.map(s=>({a:{status:"Not Scheduled", time:"—", isDuplicate:false, fingerId:s.fid?parseInt(String(s.fid).replace("F-","")):null, date:t}, s}));
    }
    else if(sf==="Absent"){
      const presentIds = new Set(rows.filter(r=>r.a.status==="Present"||r.a.status==="Late").map(r=>r.s.id));
      const absentStudents = scheduledFiltered.filter(s=> !presentIds.has(s.id));
      rows = absentStudents.map(s=>({a:{status:"Absent", time:"—", isDuplicate:false, fingerId:null, date:t}, s}));
    }
    else rows=rows.filter(r=>r.a.status===sf);
  }
  rows.sort((x,y)=>{
    if(sort==="time_desc") return (y.a.time||"").localeCompare(x.a.time||"");
    if(sort==="time_asc") return (x.a.time||"").localeCompare(y.a.time||"");
    if(sort==="name_asc") return x.s.name.localeCompare(y.s.name);
    if(sort==="roll_asc") return x.s.roll.localeCompare(y.s.roll);
    if(sort==="class_asc") return x.s.class.localeCompare(y.s.class);
    return 0;
  });
  const total= allActiveFiltered.length;
  const scheduledTotal = scheduledFiltered.length;
  const notScheduled = notScheduledFiltered.length;
  // Prefer backend KPI if available for authoritative counts (scheduled never includes Not Scheduled)
  let presentAll, lateAll, absentAll, pct;
  if(Kpis && Kpis.date===t && !cf && typeof Kpis.scheduled==="number"){
    presentAll = Kpis.present||0;
    lateAll = Kpis.late||0;
    absentAll = Kpis.absent||Math.max(0, (Kpis.scheduled||scheduledTotal) - presentAll - lateAll);
    pct = Kpis.scheduled ? Math.round((presentAll+lateAll)/Kpis.scheduled*100) : 0;
  } else {
    presentAll = Attendance.filter(a=>a.date===t && a.studentId).map(a=>{const s=byId.get(a.studentId); return s&& (!cf||s.class===cf) && isWorkingDayForStudent(t, s) ? a:null}).filter(a=>a&&a.status==="Present").length;
    lateAll = Attendance.filter(a=>a.date===t && a.studentId).map(a=>{const s=byId.get(a.studentId); return s&& (!cf||s.class===cf) && isWorkingDayForStudent(t, s) ? a:null}).filter(a=>a&&a.status==="Late").length;
    absentAll = Math.max(0, scheduledTotal - presentAll - lateAll);
    pct = scheduledTotal?Math.round((presentAll+lateAll)/scheduledTotal*100):0;
  }
  const present = sf ? rows.filter(r=>r.a.status==="Present").length : presentAll;
  const late = sf ? rows.filter(r=>r.a.status==="Late").length : lateAll;
  const absent = sf ? (sf==="Absent" ? rows.length : (sf==="Not Scheduled" ? 0 : absentAll)) : absentAll;
  const dup=rows.filter(r=>r.a.isDuplicate).length;
  const workingLabel = isGlobalWorking ? "Working day" : "Holiday";
  const schedInfo = cf ? `${cf} — ${scheduledTotal} scheduled, ${notScheduled} not scheduled` : `${scheduledTotal} scheduled, ${notScheduled} not scheduled`;
  todayDateLabel.textContent=`${fmtDate(t)} — ${workingLabel} — ${schedInfo}`;
  todayStats.innerHTML=`
    <div class="stat"><b>${t}</b><label>Date</label></div>
    <div class="stat"><b>${total}</b><label>Total students</label></div>
    <div class="stat"><b>${present}</b><label>Present</label></div>
    <div class="stat"><b>${late}</b><label>Late</label></div>
    <div class="stat"><b>${absent}</b><label>Absent</label></div>
    <div class="stat"><b>${notScheduled}</b><label>Not Scheduled</label></div>
    <div class="stat"><b>${Unknowns.length}</b><label>Unknown scans</label></div>
    <div class="stat"><b>${dup}</b><label>Duplicate scans</label></div>
    <div class="stat"><b>${pct}%</b><label>Attendance %</label></div>`;
  if(!rows.length){ todayTableBody.innerHTML=`<tr><td colspan="6"><div class="empty"><b>No attendance recorded today</b>Place a finger on the scanner — results appear here from the database.</div></td></tr>`; }
  else todayTableBody.innerHTML=rows.map(r=>`<tr data-student="${r.s.id}"><td>${esc(r.a.time)}</td><td>${esc(r.s.name)}</td><td>${esc(r.s.roll)}</td><td>${esc(r.s.class)}</td><td><span class="badge ${r.a.status.toLowerCase().replace(" ","-")}">${esc(r.a.status)}</span>${r.a.isDuplicate?' <span class="badge">Duplicate</span>':''} <button class="btn" data-correct data-correct-sid="${r.s.id}" data-correct-date="${esc(r.a.date||t)}" data-correct-status="${esc(r.a.status)}" style="height:20px;padding:0 6px;font-size:9px;margin-left:6px">Correct</button></td><td>${esc(r.a.fingerId!=null?"F-"+r.a.fingerId:"")}</td></tr>`).join("");
  todayUnknownBody.innerHTML=Unknowns.length?Unknowns.map(u=>`<tr><td>${esc(u.time)}</td><td>${esc(u.finger)}</td><td>${esc(u.note)}</td></tr>`).join(""):`<tr><td colspan="3"><div class="empty"><b>No unknown scans today</b></div></td></tr>`;
}
// ---- render: Reports (backend-aware: handles NOT_SCHEDULED, batch schedules, and per-student KPI) ----
async function renderReports(){
  const scope=reportScope.value, cls=reportClass.value, time=reportTime.value;
  let from,to; const today=todayISO();
  if(time==="today"){from=today;to=today;}
  else if(time==="week"){const d=new Date();d.setDate(d.getDate()-6);from=d.toISOString().slice(0,10);to=today;}
  else if(time==="month"){const d=new Date();d.setDate(1);from=d.toISOString().slice(0,10);to=today;}
  else if(time==="academic"){from=Settings.startDate||today;to=Settings.endDate||today;}
  else if(time==="custom"){
    from=reportFrom.value||""; to=reportTo.value||"";
    if(!from||!to||from>to){ reportStats.innerHTML=`<div class="inline-error">Invalid date range — Start must be before End.</div>`; reportBody.innerHTML=`<tr><td colspan="7"><div class="empty"><b>Invalid range</b>Choose a valid custom range.</div></td></tr>`; return; }
  }
  else {from=Settings.startDate||today;to=today;}
  // For single student scope, fetch authoritative KPI from backend
  if(scope==="student"){
    const sid=parseInt(reportStudent.value);
    if(sid){
      try{
        const rpt = await api("/api/reports?studentId="+sid, {method:"GET"});
        if(rpt && typeof rpt==="object" && "eligible" in rpt){
          reportStats.innerHTML=`<div class="stat"><b>${rpt.eligible}</b><label>Eligible days</label></div><div class="stat"><b>${rpt.attended}</b><label>Attended</label></div><div class="stat"><b>${rpt.present}</b><label>Present</label></div><div class="stat"><b>${rpt.late}</b><label>Late</label></div><div class="stat"><b>${rpt.absent}</b><label>Absent</label></div><div class="stat"><b>${rpt.rate}%</b><label>Rate</label></div><div class="stat"><b>${from} → ${to}</b><label>Range</label></div>`;
        }
      }catch(e){}
    }
  }
  let ev=[]; try{ ev=await api("/api/attendance",{method:"GET"}); }catch(e){ ev=Attendance; }
  let list=ev.filter(a=>a.date>=from&&a.date<=to).map(mapEvent);
  if(scope==="class"&&cls) list=list.filter(a=>{const s=Students.find(x=>x.id===a.studentId); return s&&s.class===cls;});
  if(scope==="student"){const sid=parseInt(reportStudent.value); if(sid) list=list.filter(a=>a.studentId===sid);}
  list.sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)).reverse();
  const present=list.filter(a=>a.status==="Present").length, late=list.filter(a=>a.status==="Late").length;
  const absent=list.filter(a=>a.status==="Absent").length, notScheduled=list.filter(a=>a.status==="Not Scheduled").length;
  const duplicate=list.filter(a=>a.isDuplicate).length;
  // For non-student scope, build stats with backend-aware counts (absent never includes Not Scheduled)
  if(scope!=="student"){
    const rate = (present+late+absent) ? Math.round((present+late)/(present+late+absent)*100) : 0;
    reportStats.innerHTML=`<div class="stat"><b>${list.length}</b><label>Records</label></div><div class="stat"><b>${present}</b><label>Present</label></div><div class="stat"><b>${late}</b><label>Late</label></div><div class="stat"><b>${absent}</b><label>Absent</label></div><div class="stat"><b>${notScheduled}</b><label>Not Scheduled</label></div><div class="stat"><b>${duplicate}</b><label>Duplicate</label></div><div class="stat"><b>${rate}%</b><label>Rate</label></div><div class="stat"><b>${from} → ${to}</b><label>Range</label></div>`;
  }
  if(!list.length){ reportBody.innerHTML=`<tr><td colspan="7"><div class="empty"><b>No records</b>Adjust scope or time range.</div></td></tr>`; return; }
  reportBody.innerHTML=list.map(a=>{
    const s=Students.find(x=>x.id===a.studentId);
    // working-day? column shows scheduled vs not scheduled for that student/date
    let working="—";
    if(s && a.date){
      working = isWorkingDayForStudent(a.date, s) ? "Scheduled" : "Not Scheduled";
      if(a.status==="Not Scheduled") working="Not Scheduled";
      else if(a.status==="Absent" && !isWorkingDayForStudent(a.date, s)) working="Not Scheduled";
    }
    return `<tr><td>${esc(a.date)}</td><td>${esc(a.time)}</td><td>${esc(s?s.name:"Unknown")}</td><td>${esc(s?s.roll:"")}</td><td>${esc(s?s.class:"")}</td><td><span class="badge ${a.status.toLowerCase().replace(" ","-")}">${esc(a.status)}</span></td><td>${esc(working)}${a.isDuplicate?" · Duplicate":""}</td></tr>`;
  }).join("");
}
// ---- render: Calendar (holidays/weekly/overrides persisted in backend settings) ----
function isHoliday(d){ return Holidays.find(h=>inRange(d,h.start,h.end))||null; }
function getOverride(d){ return Overrides.find(o=>o.date===d)||null; }
function isWorkingDayUI(d){
  const ov=getOverride(d);
  if(ov) return ov.isWorking;
  const hol=isHoliday(d);
  if(hol){
    const type=String(hol.type||"holiday").toLowerCase();
    return type==="exam";
  }
  const day=new Date(d+"T00:00:00").getDay();
  return asBool(Settings.workingDays[day] ?? Settings.workingDays[String(day)]);
}
function getWorkingDaysForClass(grade){
  if(grade && ClassSchedules[grade]){
    const v=ClassSchedules[grade];
    if(v && typeof v==="object" && v.workingDays) return v.workingDays;
    if(v && typeof v==="object") return v;
  }
  // fallback to legacy UI key for offline
  if(grade && ClassSchedulesUI && ClassSchedulesUI[grade]){
    const v=ClassSchedulesUI[grade];
    if(v && v.workingDays) return v.workingDays;
    if(v) return v;
  }
  return Settings.workingDays;
}
function getWorkingDaysForStudent(student){
  if(!student) return Settings.workingDays;
  const grade=(student.class||student.grade||"").trim();
  const batch=(student.batch||student.group||"").trim();
  if(grade && batch){
    const key=grade+"|"+batch;
    if(BatchSchedules[key]){
      const v=BatchSchedules[key];
      if(v && v.workingDays) return v.workingDays;
      if(v) return v;
    }
  }
  if(batch && BatchSchedules[batch]){
    const v=BatchSchedules[batch];
    if(v && v.workingDays) return v.workingDays;
    if(v) return v;
  }
  if(grade && ClassSchedules[grade]){
    const v=ClassSchedules[grade];
    if(v && v.workingDays) return v.workingDays;
    if(v) return v;
  }
  return Settings.workingDays;
}
function isWorkingDayForClass(d, grade){
  const ov=getOverride(d);
  if(ov) return ov.isWorking;
  const hol=isHoliday(d);
  if(hol){
    const type=String(hol.type||"holiday").toLowerCase();
    return type==="exam";
  }
  const day=new Date(d+"T00:00:00").getDay();
  const wd=getWorkingDaysForClass(grade);
  return asBool(wd[day] ?? wd[String(day)]);
}
function isWorkingDayForStudent(d, student){
  const ov=getOverride(d);
  if(ov) return ov.isWorking;
  const hol=isHoliday(d);
  if(hol){
    const type=String(hol.type||"holiday").toLowerCase();
    return type==="exam";
  }
  const day=new Date(d+"T00:00:00").getDay();
  const wd=getWorkingDaysForStudent(student);
  return asBool(wd[day] ?? wd[String(day)]);
}
function isScheduledToday(student){
  if(!student) return true;
  return isWorkingDayForStudent(todayISO(), student);
}
function holidaysToBackend(){ return Holidays.map(h=>{
  const span=h.start===h.end?h.start:(h.start+".."+h.end);
  return span+":"+(h.type||"holiday")+":"+(h.name||"Holiday");
}); }
function overridesToBackend(){ return Overrides.map(o=>o.date+(o.isWorking?":1":":0")+":"+o.note); }
function classSchedulesToBackend(){
  // normalize to backend expected format: {class: workingDays} or {class: {workingDays}}
  const out={};
  Object.keys(ClassSchedules).forEach(k=>{
    const v=ClassSchedules[k];
    if(!v) return;
    if(v.workingDays) out[k]={workingDays: v.workingDays};
    else out[k]=v;
  });
  return out;
}
function batchSchedulesToBackend(){
  const out={};
  Object.keys(BatchSchedules).forEach(k=>{
    const v=BatchSchedules[k];
    if(!v) return;
    if(v.workingDays) out[k]={workingDays: v.workingDays};
    else out[k]=v;
  });
  return out;
}
async function persistCalendar(){
  try{
    await api("/api/settings",{method:"POST",body:JSON.stringify({
      holidays: holidaysToBackend(), overrides: overridesToBackend(), workingDays: Settings.workingDays,
      classSchedules: classSchedulesToBackend(), batchSchedules: batchSchedulesToBackend()
    })});
    cacheSave();
    return true;
  }catch(e){ alert("Failed to save calendar: "+e.message); }
  return false;
}
function renderHolidays(){
  if(!Holidays.length){ holidayBody.innerHTML=`<tr><td colspan="6"><div class="empty"><b>No holidays configured</b>Add Independence Day, Diwali Vacation etc.</div></td></tr>`; return; }
  holidayBody.innerHTML=Holidays.map(h=>`<tr><td>${esc(h.name)}</td><td>${esc(h.start)}</td><td>${esc(h.end)}</td><td></td><td><span class="badge">${esc(h.type)}</span></td><td><div style="display:flex;gap:6px"><button class="btn" data-edit-holiday="${esc(h.start)}">Edit</button><button class="btn danger" data-del-holiday="${esc(h.start)}">Remove</button></div></td></tr>`).join("");
}
function renderOverrides(){
  if(!Overrides.length){ overrideBody.innerHTML=`<tr><td colspan="4"><div class="empty"><b>No date overrides</b></div></td></tr>`; return; }
  overrideBody.innerHTML=Overrides.map(o=>`<tr><td>${esc(o.date)}</td><td>${o.isWorking?"Working":"Holiday"}</td><td>${esc(o.note)}</td><td><div style="display:flex;gap:6px"><button class="btn" data-edit-override="${esc(o.date)}">Edit</button><button class="btn danger" data-del-override="${esc(o.date)}">Remove</button></div></td></tr>`).join("");
}
function renderWeekly(){
  const tbody=document.querySelector("#weeklyTable tbody");
  if(!tbody) return;
  const sel=$("calClassSelect");
  const selectedClass = sel ? sel.value : "";
  const wd = selectedClass ? getWorkingDaysForClass(selectedClass) : Settings.workingDays;
  const days=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  tbody.innerHTML=days.map((name,idx)=>{
    const on=asBool(wd[idx] ?? wd[String(idx)]);
    return `<tr><td>${name}</td><td><div class="toggle ${on?"on":""}" data-day="${idx}"></div></td></tr>`;
  }).join("");
  // update selector options if needed (UI-only)
  if(sel && sel.options.length===1 && Classes.length){
    const cur=sel.value;
    sel.innerHTML='<option value="">All classes (global)</option>'+Classes.map(c=>`<option ${c===cur?'selected':''}>${esc(c)}</option>`).join("");
  }
}
function renderCalendarMonth(){
  if(!calendarGrid) return;
  const y=calendarMonth.getFullYear(), m=calendarMonth.getMonth();
  calMonthLabel.textContent=calendarMonth.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const sel=$("calClassSelect");
  const selectedClass = sel ? sel.value : "";
  const first=new Date(y,m,1).getDay(), last=new Date(y,m+1,0).getDate();
  let html=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="calendar-cell head">${d}</div>`).join("");
  for(let i=0;i<first;i++) html+=`<div class="calendar-cell"></div>`;
  for(let d=1;d<=last;d++){
    const iso=new Date(y,m,d).toISOString().slice(0,10);
    const hol=isHoliday(iso), ov=getOverride(iso), todayCls=iso===todayISO()?" today":"";
    const working = selectedClass ? isWorkingDayForClass(iso, selectedClass) : isWorkingDayUI(iso);
    const typeCls=ov?"override":(hol?(hol.type==="vacation"?"vacation":"holiday"):(working?"working":"holiday"));
    const tag=ov?esc(ov.note):hol?esc(hol.name):(working?"Working":"Non-working");
    html+=`<div class="calendar-cell ${typeCls}${todayCls}"><div class="day">${d}</div><div class="tag">${tag}</div></div>`;
  }
  calendarGrid.innerHTML=html;
}
function renderClasses(){
  if(!Classes.length){ classBody.innerHTML=`<tr><td colspan="3"><div class="empty"><b>No classes configured</b></div></td></tr>`; return; }
  classBody.innerHTML=Classes.map(c=>{ const n=Students.filter(s=>s.class===c).length; return `<tr><td>${esc(c)}</td><td>${n}</td><td><span style="font-size:10px;color:var(--ink-3)">—</span></td></tr>`; }).join("");
}
function renderAudit(){
  if(!Audit.length){ auditBody.innerHTML=`<tr><td colspan="4"><div class="empty"><b>No audit history</b>Changes appear here.</div></td></tr>`; return; }
  auditBody.innerHTML=Audit.map(a=>`<tr><td>${esc(a.time)}</td><td>${esc(a.action)}</td><td>${esc(a.details)}</td><td>${esc(a.by)}</td></tr>`).join("");
}
function renderAll(){
  renderClassFilters();
  renderStudentList();
  renderWeekly();
  renderHolidays();
  renderOverrides();
  renderCalendarMonth();
  renderClasses();
  renderAudit();
  if(currentTab==="today") renderToday();
  if(currentTab==="reports") renderReports();
}
// ---- ENROLL: information + real fingerprint scan ----
async function pollEnrollProgress(stepEl, labelEl){
  if(_enrollAbort) return;
  try{
    const p=await api("/api/sensor/progress",{method:"GET"});
    if(p&&labelEl){
      const st=p.state, step=p.step||0;
      if(stepEl) stepEl.textContent=step+"/3";
      if(st==="place") labelEl.textContent="Place your finger — press it flat on the glass";
      else if(st==="hold") labelEl.textContent="Hold still — capturing";
      else if(st==="capturing") labelEl.textContent="Scanning — keep still";
      else if(st==="enroll_1") labelEl.textContent="First capture done — lift your finger";
      else if(st==="enroll_2") labelEl.textContent="Second capture — place the same finger";
      else if(st==="enroll_3") labelEl.textContent="Third capture — place the same finger";
    }
  }catch(e){}
  if(!_enrollAbort) _enrollPoll=setTimeout(()=>pollEnrollProgress(stepEl,labelEl),700);
}
function fingerprintScanUI(title, subtitle, onStart, onSuccess){
  setState("ready");
  enrollTitle.textContent=title;
  enrollSub.textContent=subtitle;
  enrollBody.innerHTML=`
    <div class="enroll-scan-box">
      <div class="enroll-scan-count" id="scanCount">0 / 3</div>
      <div class="enroll-scan-label" id="scanLabel">Place your finger on the sensor</div>
      <div class="finger-visual"><div class="finger-line"></div></div>
      <div class="lift-hint">Keep the same finger flat. The sensor light stays on.</div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:center"><button class="btn primary" id="scanStartBtn">Start scan</button><button class="btn" id="scanCancelBtn">Cancel</button></div>
      <div class="inline-error" id="scanErr" style="display:none"></div>
    </div>`;
  openModal(enrollModal);
  $("scanCancelBtn").onclick=()=>{ finishEnrollUi(); resumeSensorScan(); };
  $("scanStartBtn").onclick=async()=>{
    $("scanStartBtn").disabled=true;
    _enrollAbort=false;
    const stepEl=$("scanCount"), labelEl=$("scanLabel");
    pollEnrollProgress(stepEl,labelEl);
    try{
      const res=await onStart();
      try{ onSuccess(res); }catch(e){}
      returnToFrontPage();
    }catch(err){
      _enrollAbort=true;
      if(_enrollPoll) clearTimeout(_enrollPoll);
      const e=$("scanErr"); e.style.display="block";
      e.textContent=err.message||"Scan failed. Check the sensor and try again.";
      $("scanStartBtn").disabled=false;
    }
  };
}
function openNewStudent(){
  pauseSensorScan();
  enrollTitle.textContent="New student enrollment";
  enrollSub.textContent="Enter the student information. Click Start scan once, then place and lift the same finger three times on the sensor.";
  enrollBody.innerHTML=`
    <div class="form-grid">
      <div class="form-field"><label>Full name *</label><input id="nsName" placeholder="Aarav Sharma"></div>
      <div class="form-field"><label>Roll number *</label><input id="nsRoll" placeholder="10A-08"></div>
      <div class="form-field"><label>Class *</label><select id="nsGrade">${Classes.map(c=>`<option>${esc(c)}</option>`).join("")||'<option>Grade 10-A</option>'}</select></div>
      <div class="form-field"><label>Batch / Group (optional)</label><input id="nsBatch" placeholder="Batch A"></div>
      <div class="form-field"><label>Section</label><input id="nsSection" placeholder="A"></div>
      <div class="form-field"><label>Parent / Guardian</label><input id="nsParent" placeholder="Parent name"></div>
      <div class="form-field"><label>Parent phone</label><input id="nsPhone" placeholder="9876543210"></div>
      <div class="form-field full"><label>Address</label><input id="nsAddress" placeholder="Shikrapur, Pune"></div>
      <div class="form-field full"><label>Photo (optional, max 2MB)</label><input type="file" id="nsPhoto" accept="image/*"></div>
      <div class="inline-error" id="nsErr" style="display:none"></div>
      <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="nsCancel">Cancel</button><button class="btn primary" id="nsSave">Continue to fingerprint scan</button></div>
    </div>`;
  openModal(enrollModal);
  $("nsCancel").onclick=()=>{ if(_enrollPoll) clearTimeout(_enrollPoll); closeModal(enrollModal); resumeSensorScan(); };
  $("nsSave").onclick=()=>{
    const name=$("nsName").value.trim(), roll=$("nsRoll").value.trim(),
          grade=$("nsGrade").value.trim(), batch=$("nsBatch").value.trim(),
          section=$("nsSection").value.trim(), parent=$("nsParent").value.trim(),
          phone=$("nsPhone").value.trim(), address=$("nsAddress").value.trim();
    const err=$("nsErr");
    if(!name||!roll||!grade){ err.textContent="Name, roll and class are required."; err.style.display="block"; return; }
    err.style.display="none";
    const file=$("nsPhoto").files[0];
    const finish=(photo)=>{
      const form={name,roll,grade,batch,section,parent,phone,address,photo:photo||""};
      closeModal(enrollModal);
  fingerprintScanUI("Enroll fingerprint — "+name, "Click Start scan once. Then place and lift the same finger three times; do not click between captures.",
        ()=>apiEnrollStudent(form),
        (res)=>{
          if(res && res.id){
            upsertStudent({
              id:res.id, name:name, roll:roll, grade:grade, batch:batch, section:section,
              parent:parent, phone:phone, address:address, photo:form.photo||"",
              fingerId:res.fingerId, active:1
            });
            cacheSave();
          }
          loadAll();
        });
    };
    if(file){
      if(file.size>2*1024*1024){ err.textContent="Photo max 2MB."; err.style.display="block"; return; }
      const r=new FileReader(); r.onload=e=>finish(e.target.result); r.readAsDataURL(file);
    } else finish("");
  };
}
function openEditStudent(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  enrollTitle.textContent="Edit student information";
  enrollSub.textContent="Changes are saved to the database (SQLite).";
  enrollBody.innerHTML=`
    <div class="form-grid">
      <div class="form-field"><label>Full name</label><input id="edName" value="${esc(s.name)}"></div>
      <div class="form-field"><label>Roll</label><input id="edRoll" value="${esc(s.roll)}"></div>
      <div class="form-field"><label>Class *</label><select id="edGrade">${Classes.map(c=>`<option ${c===s.class?"selected":""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="form-field"><label>Batch / Group</label><input id="edBatch" value="${esc(s.batch||'')}"></div>
      <div class="form-field"><label>Section</label><input id="edSection" value="${esc(s.section||'')}"></div>
      <div class="form-field"><label>Parent / Guardian</label><input id="edParent" value="${esc(s.parent||'')}"></div>
      <div class="form-field"><label>Phone</label><input id="edPhone" value="${esc(s.phone)}"></div>
      <div class="form-field full"><label>Address</label><input id="edAddress" value="${esc(s.address)}"></div>
      <div class="form-field"><label>Photo (max 2MB)</label><input type="file" id="edPhoto" accept="image/*"></div>
      <div class="form-field"><label>Status</label><select id="edActive"><option value="1" ${s.active?"selected":""}>Active</option><option value="0" ${!s.active?"selected":""}>Inactive</option></select></div>
      <div class="form-field full" id="edPhotoPreview" style="${s.photo ? '' : 'display:none'}"><img src="${esc(s.photo)}" style="width:92px;height:92px;object-fit:cover;border:1px solid var(--line);display:block"><div style="font-size:10px;color:var(--ink-3);margin-top:6px">Current photo</div><button class="btn" id="edClearPhoto" style="margin-top:8px">Clear photo</button></div>
      <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="edCancel">Cancel</button><button class="btn primary" id="edSave">Save changes</button></div>
      <div class="inline-error" id="edErr" style="display:none"></div>
    </div>`;
  openModal(enrollModal);
  $("edCancel").onclick=()=>closeModal(enrollModal);
  const edPhotoEl=$("edPhoto");
  if(edPhotoEl) edPhotoEl.onchange=(e)=>{
    const f=e.target.files&&e.target.files[0];
    if(!f) return;
    if(f.size>2*1024*1024){ const er=$("edErr"); er.textContent="Photo max 2MB."; er.style.display="block"; e.target.value=""; return; }
    const r=new FileReader(); r.onload=ev=>{
      const prev=$("edPhotoPreview"); if(prev){ prev.style.display="block"; const img=prev.querySelector("img"); if(img) img.src=ev.target.result; }
    }; r.readAsDataURL(f);
  };
  let edClearRequested=false;
  const edClearBtn=$("edClearPhoto");
  if(edClearBtn) edClearBtn.onclick=(e)=>{ e.preventDefault(); edClearRequested=true; const prev=$("edPhotoPreview"); if(prev){ const img=prev.querySelector("img"); if(img) img.src=""; prev.style.display="none"; } const inp=$("edPhoto"); if(inp) inp.value=""; };
  $("edSave").onclick=async()=>{
    const err=$("edErr");
    const name=$("edName").value.trim(), roll=$("edRoll").value.trim(), grade=$("edGrade").value.trim(),
          batch=$("edBatch").value.trim(), section=$("edSection").value.trim(), parentEl=$("edParent").value.trim(),
          phone=$("edPhone").value.trim(), address=$("edAddress").value.trim(), active=$("edActive").value==="1";
    const file=$("edPhoto").files&&$("edPhoto").files[0];
    const doSave=async(photoData)=>{
      try{
        const payload={name,roll,grade,batch,section,parent:parentEl,phone,address,active};
        if(photoData!==null) payload.photo=photoData;
        await api("/api/students/"+id,{method:"PATCH",body:JSON.stringify(payload)});
        closeModal(enrollModal); await loadAll();
        selectStudent(id);
        alert("Saved.");
      }catch(e){ err.style.display="block"; err.textContent=e.message; }
    };
    if(file){
      if(file.size>2*1024*1024){ err.textContent="Photo max 2MB."; err.style.display="block"; return; }
      const r=new FileReader(); r.onload=e=>doSave(e.target.result); r.readAsDataURL(file);
    } else if(edClearRequested){
      doSave("");
    } else {
      doSave(null);
    }
  };
}
function openReEnroll(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  pauseSensorScan();
  fingerprintScanUI("Re-enroll fingerprint — "+s.name, "Click Start scan once. Then place and lift the same finger three times; do not click between captures.",
    ()=>api("/api/students/"+id+"/reenroll",{method:"POST",body:"{}"}),
    (res)=>{
      const fid = res && res.fingerId!=null ? res.fingerId : null;
      upsertStudent({
        id:s.id, name:s.name, roll:s.roll, grade:s.class||s.grade, batch:s.batch, section:s.section,
        parent:s.parent, phone:s.phone, address:s.address, photo:s.photo||"",
        fingerId:fid, active:1
      });
      cacheSave();
      loadAll();
    });
}
async function deleteStudent(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  if(!confirm("Deactivate "+s.name+"? Their fingerprint slot is freed and roll is released. History is kept.")) return;
  try{ await api("/api/students/"+id,{method:"DELETE"}); await loadAll(); renderStudentDetail(-1); }catch(e){ alert("Failed: "+e.message); }
}
async function reactivateStudent(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  if(!confirm("Re-activate "+s.name+"?")) return;
  try{ await api("/api/students/"+id,{method:"PATCH",body:JSON.stringify({active:1})}); await loadAll(); selectStudent(id); }catch(e){ alert("Failed: "+e.message); }
}
function apiEnrollStudent(form){
  return api("/api/enroll",{method:"POST",body:JSON.stringify(form)});
}
// ---- print / CSV ----
function downloadFile(content, filename, type){
  const blob=new Blob([content],{type:type||'text/plain'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>{ try{URL.revokeObjectURL(url);}catch(e){} },1500);
}
function exportCSV(rows, filename){
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadFile(csv, filename, 'text/csv');
}
function printHTML(htmlContent){
  const w=window.open('','_blank'); if(!w) return;
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Report</title><style>
    body{font-family:Georgia,serif;color:#0A0A0A;padding:32px;max-width:800px;margin:auto}
    h1{font-size:22px;text-transform:uppercase;letter-spacing:0.06em} table{width:100%;border-collapse:collapse;font-size:11px;margin:12px 0}
    th{font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:#6B6B6B;text-align:left;padding:8px;border-bottom:1px solid #E9E6E0}
    td{padding:7px 8px;border-bottom:1px solid #E9E6E0}
  </style></head><body>${htmlContent}<script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}

// ---- events ----
function openAdmin(){
  const titles={students:"Students", today:"Today — Attendance", reports:"Reports", calendar:"Calendar — Schedule", settings:"Settings", backup:"Backup — Audit"};
  if(adminTitle) adminTitle.textContent=titles[currentTab]||"Admin";
  // show loading briefly while data refreshes
  const pane=document.getElementById("pane-"+currentTab);
  if(pane) pane.style.opacity="0.6";
  pauseSensorScan(); adminLayer.classList.add("open"); renderAll();
  setTimeout(()=>{ if(pane) pane.style.opacity=""; updateTabs(); }, 80);
}
function updateTabs(){
  document.querySelectorAll(".admin-pane").forEach(p=>p.classList.add("hidden"));
  const pane=document.getElementById("pane-"+currentTab); if(pane){ pane.classList.remove("hidden"); pane.style.opacity=""; }
  const titles={students:"Students", today:"Today — Attendance", reports:"Reports", calendar:"Calendar — Schedule", settings:"Settings", backup:"Backup — Audit"};
  if(adminTitle) adminTitle.textContent=titles[currentTab]||"Admin";
  if(currentTab==="today") renderToday();
  if(currentTab==="reports") renderReports();
  if(currentTab==="calendar"){ renderHolidays(); renderOverrides(); renderCalendarMonth(); }
  if(currentTab==="settings") renderClasses();
  if(currentTab==="backup") renderAudit();
}
document.getElementById("openAdminBtn").onclick=openAdmin;
const _frontEnrollBtn=document.getElementById("openEnrollBtn"); if(_frontEnrollBtn) _frontEnrollBtn.onclick=openNewStudent;
const _newToolbarBtn=document.getElementById("newStudentToolbarBtn"); if(_newToolbarBtn) _newToolbarBtn.onclick=openNewStudent;
document.getElementById("adminClose").onclick=()=>{
  finishEnrollUi();
  adminLayer.classList.remove("open");
  resumeSensorScan();
};
adminNav.onclick=(e)=>{
  if(e.target.tagName!=="BUTTON") return;
  [...adminNav.children].forEach(b=>b.classList.remove("active")); e.target.classList.add("active");
  currentTab=e.target.dataset.tab; updateTabs();
};
// CSV import (backend) — Import CSV beside Export CSV (static in HTML, dynamic fallback)
(function(){
  const toolbar = document.querySelector('#pane-students .tab-toolbar');
  if(!toolbar) return;
  let impBtn = $("importStudentsBtn");
  if(!impBtn){
    impBtn = document.createElement('button');
    impBtn.className='btn';
    impBtn.id='importStudentsBtn';
    impBtn.textContent='Import CSV';
    const expBtn = $("exportStudentsBtn");
    if(expBtn && expBtn.parentNode===toolbar) toolbar.insertBefore(impBtn, expBtn);
    else toolbar.appendChild(impBtn);
  }
  let fileInput = $("importStudentsFile");
  if(!fileInput){
    fileInput = document.createElement('input');
    fileInput.type='file'; fileInput.accept='.csv,text/csv'; fileInput.style.display='none'; fileInput.id='importStudentsFile';
    toolbar.appendChild(fileInput);
  }
  if(impBtn._csvWired) return;
  impBtn._csvWired = true;
  impBtn.onclick=()=>fileInput.click();
  fileInput.onchange=async(e)=>{
      const file=e.target.files&&e.target.files[0]; if(!file) return;
      const text=await file.text();
      // try backend import via file upload first
      try{
        const form=new FormData(); form.append('file', file);
        const pinHeaders={}; try{ const pin=sessionStorage.getItem("atl_admin_pin")||""; if(pin) pinHeaders["X-Admin-Pin"]=pin; }catch(e){}
        const r=await fetch('/api/import/csv',{method:'POST',body:form,cache:'no-store', headers:pinHeaders});
        const body=await r.json().catch(()=>({}));
        if(!r.ok) throw new Error(body.error||('HTTP '+r.status));
        alert(`Imported ${body.added||0} students, skipped ${body.skipped||0}` + (body.errors&&body.errors.length ? `\n${body.errors.slice(0,3).join('\n')}` : ''));
        await loadAll();
      }catch(err){
        // fallback: try JSON csv text
        try{
          const r2=await api('/api/import/csv',{method:'POST',body:JSON.stringify({csv:text})});
          alert(`Imported ${r2.added||0} students`);
          await loadAll();
        }catch(e2){
          alert('Import failed: '+(err.message||e2.message));
        }
      }
      e.target.value='';
    };
})();
$("exportStudentsBtn").onclick=async()=>{
  // Prefer backend export (includes batch/section/parent/attendance_rate)
  try{
    const r=await fetch('/api/export/csv?type=students',{cache:'no-store'});
    if(r.ok){
      const blob=await r.blob();
      const url=URL.createObjectURL(blob), a=document.createElement('a');
      const cd=r.headers.get('Content-Disposition')||'';
      let fn="students_"+todayISO()+".csv";
      const m=cd.match(/filename="?([^"]+)"?/); if(m) fn=m[1];
      a.href=url; a.download=fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
      return;
    }
  }catch(e){}
  // offline fallback: export currently filtered view
  const q=(searchInput.value||"").toLowerCase(), cf=classFilter?classFilter.value:"", bf=batchFilter?batchFilter.value:"", sf=studentStatusFilter?studentStatusFilter.value:"active";
  let list=Students.filter(s=>{
    if(sf==="active" && !s.active) return false;
    if(sf==="inactive" && s.active) return false;
    if(cf && s.class!==cf) return false;
    if(bf && (s.batch||"")!==bf) return false;
    if(q && !(s.name+" "+s.roll+" "+s.class+" "+(s.batch||"")+" "+s.phone+" "+s.fid+" "+s.id+" "+(s.section||"")+" "+(s.parent||"")).toLowerCase().includes(q)) return false;
    return true;
  });
  const rows=[["ID","Name","Roll","Class","Batch","Section","Parent","Phone","Address","Fingerprint","Status"]].concat(list.map(s=>[s.id,s.name,s.roll,s.class,s.batch||"",s.section||"",s.parent||"",s.phone||"",s.address||"",s.fid||"",s.active?"Active":"Inactive"]));
  exportCSV(rows,"students_"+todayISO()+".csv");
};
$("todayRefreshBtn").onclick=async()=>{
  const btn=$("todayRefreshBtn");
  const prev=btn?btn.textContent:"";
  if(btn){ btn.textContent="Loading…"; btn.disabled=true; }
  try{ await loadTodayAttendance(); renderToday(); }
  finally{ if(btn){ btn.textContent=prev; btn.disabled=false; } }
};
$("todayPrintBtn").onclick=()=>{
  const t=todayISO();
  const school=Settings.schoolName||"ATL Model School";
  const hdr=`<h1>${esc(school)} — Today's Attendance — ${esc(t)}</h1><p style="font-size:11px;color:#6B6B6B">${esc(fmtDate(t))} — ${esc($("todayDateLabel")?$("todayDateLabel").textContent:"")}</p>`;
  const stats=$("todayStats")?$("todayStats").outerHTML:"";
  const tbl=document.querySelector('#pane-today .table-wrap');
  printHTML(hdr+stats+(tbl?tbl.outerHTML:""));
};
$("todayExportBtn").onclick=async()=>{
  const t=todayISO(), cf=todayClassFilter?todayClassFilter.value:"";
  // Prefer backend export (includes reconciled ABSENT/NOT_SCHEDULED)
  try{
    let url="/api/export/csv?type=attendance&date="+encodeURIComponent(t);
    if(cf) url+="&class="+encodeURIComponent(cf);
    const sf=todayStatusFilter?todayStatusFilter.value:"";
    if(sf && ["Present","Late","Absent","Not Scheduled","Duplicate","Unknown"].includes(sf)) url+="&status="+encodeURIComponent(sf.toUpperCase().replace(" ","_"));
    const r=await fetch(url,{cache:"no-store"});
    if(r.ok){
      const blob=await r.blob();
      const url2=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url2; a.download="today-"+t+(cf?"-"+cf:"")+".csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url2),1500);
      return;
    }
  }catch(e){}
  // fallback: include virtual Not Scheduled / Absent rows as shown in UI (backend schedule-aware)
  const allActiveFiltered = Students.filter(s=>s.active && (!cf || s.class===cf));
  const scheduledFiltered = allActiveFiltered.filter(s=> isWorkingDayForStudent(t, s));
  const rowsVisible = (()=> {
    const sf=todayStatusFilter?todayStatusFilter.value:"";
    if(sf==="Not Scheduled"){
      const notSched=allActiveFiltered.filter(s=> !isWorkingDayForStudent(t, s));
      return notSched.map(s=>["—",s.name,s.roll,s.class,"Not Scheduled",s.fid||""]);
    }
    if(sf==="Absent"){
      const presentIds=new Set(Attendance.filter(a=>a.date===t&&(a.status==="Present"||a.status==="Late")).map(a=>a.studentId));
      const abs=scheduledFiltered.filter(s=> !Attendance.some(a=>a.date===t&&a.studentId===s.id&&(a.status==="Present"||a.status==="Late")));
      return abs.map(s=>["—",s.name,s.roll,s.class,"Absent",""]);
    }
    return Attendance.filter(a=>a.date===t&&a.studentId).filter(a=>{ const s=Students.find(x=>x.id===a.studentId); return s&& (!cf||s.class===cf); }).map(a=>{ const s=Students.find(x=>x.id===a.studentId); return [a.time,s?s.name:"",s?s.roll:"",s?s.class:"",a.status,a.fingerId!=null?"F-"+a.fingerId:""]; });
  })();
  const rows=[["Time","Student","Roll","Class","Status","Fingerprint"]].concat(rowsVisible);
  exportCSV(rows,"today-"+t+(cf?"-"+cf:"")+".csv");
};
$("reportApplyBtn").onclick=renderReports;
$("reportPrintBtn").onclick=()=>printHTML(`<h1>Attendance Report</h1>${document.querySelector('#pane-reports .table-wrap').innerHTML}`);
$("reportCsvBtn").onclick=async()=>{
  const scope=reportScope.value, cls=reportClass.value;
  let from,to; const today=todayISO();
  const time=reportTime.value;
  if(time==="today"){from=today;to=today;}
  else if(time==="week"){const d=new Date();d.setDate(d.getDate()-6);from=d.toISOString().slice(0,10);to=today;}
  else if(time==="month"){const d=new Date();d.setDate(1);from=d.toISOString().slice(0,10);to=today;}
  else if(time==="academic"){from=Settings.startDate||today;to=Settings.endDate||today;}
  else if(time==="custom"){from=reportFrom.value||""; to=reportTo.value||"";}
  else {from=Settings.startDate||today;to=today;}
  try{
    let url="/api/export/csv?type=attendance";
    if(from) url+="&start="+encodeURIComponent(from);
    if(to) url+="&end="+encodeURIComponent(to);
    if(scope==="class"&&cls) url+="&class="+encodeURIComponent(cls);
    if(scope==="student"){const sid=parseInt(reportStudent.value); if(sid) url+="&studentId="+encodeURIComponent(sid);}
    const r=await fetch(url,{cache:"no-store"});
    if(r.ok){
      const blob=await r.blob();
      const url2=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url2; a.download="report-"+(from||today)+"_"+(to||today)+".csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url2),1500);
      return;
    }
  }catch(e){}
  const rows=[["Date","Time","Student","Status"]].concat([...reportBody.querySelectorAll("tr")].map(tr=>[...tr.querySelectorAll("td")].map(td=>td.textContent)).filter(r=>r.length>1));
  exportCSV(rows,"report-"+todayISO()+".csv");
};
$("calPrevBtn").onclick=()=>{ calendarMonth.setMonth(calendarMonth.getMonth()-1); renderCalendarMonth(); };
$("calNextBtn").onclick=()=>{ calendarMonth.setMonth(calendarMonth.getMonth()+1); renderCalendarMonth(); };
if($("calTodayBtn")) $("calTodayBtn").onclick=()=>{ calendarMonth=new Date(); renderCalendarMonth(); };
$("addHolidayBtn").onclick=()=>{
  $("holidayModalBody").innerHTML=`<div class="form-grid">
    <div class="form-field full"><label>Name</label><input id="holidayName" placeholder="Diwali vacation"></div>
    <div class="form-field"><label>Start date</label><input type="date" id="holidayStart"></div>
    <div class="form-field"><label>End date</label><input type="date" id="holidayEnd"></div>
    <div class="form-field"><label>Type</label><select id="holidayType"><option value="holiday">Holiday</option><option value="vacation">Vacation</option><option value="exam">Exam day (working)</option></select></div>
    <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="holidayCancel">Cancel</button><button class="btn primary" id="holidaySave">Save holiday</button></div>
    <div class="inline-error" id="holidayErr" style="display:none"></div></div>`;
  openModal(holidayModal);
  $("holidayCancel").onclick=()=>closeModal(holidayModal);
  $("holidaySave").onclick=async()=>{
    const name=$("holidayName").value.trim(), start=$("holidayStart").value, end=$("holidayEnd").value||start, err=$("holidayErr");
    if(!name||!start||!end||start>end){ err.textContent="Name and a valid date range are required."; err.style.display="block"; return; }
    Holidays.push({name,start,end,category:"",type:$("holidayType").value});
    if(await persistCalendar()){ closeModal(holidayModal); renderHolidays(); renderCalendarMonth(); }
  };
};
$("addOverrideBtn").onclick=()=>{
  $("overrideModalBody").innerHTML=`<div class="form-grid">
    <div class="form-field"><label>Date</label><input type="date" id="overrideDate"></div>
    <div class="form-field"><label>Becomes</label><select id="overrideWorking"><option value="1">Working day</option><option value="0">Holiday</option></select></div>
    <div class="form-field full"><label>Note</label><input id="overrideNote" placeholder="Special working Saturday"></div>
    <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="overrideCancel">Cancel</button><button class="btn primary" id="overrideSave">Save override</button></div>
    <div class="inline-error" id="overrideErr" style="display:none"></div></div>`;
  openModal(overrideModal);
  $("overrideCancel").onclick=()=>closeModal(overrideModal);
  $("overrideSave").onclick=async()=>{
    const date=$("overrideDate").value, note=$("overrideNote").value.trim(), err=$("overrideErr");
    if(!date){ err.textContent="A date is required."; err.style.display="block"; return; }
    Overrides=Overrides.filter(o=>o.date!==date);
    Overrides.push({date,isWorking:$("overrideWorking").value==="1",note});
    if(await persistCalendar()){ closeModal(overrideModal); renderOverrides(); renderCalendarMonth(); }
  };
};
$("weeklyTable").addEventListener("click",async(e)=>{
  const toggle=e.target.closest("[data-day]"); if(!toggle) return;
  const day=String(toggle.dataset.day);
  const sel=$("calClassSelect");
  const selectedClass = sel ? sel.value : "";
  if(selectedClass){
    let entry = ClassSchedules[selectedClass];
    let wd;
    if(entry && typeof entry==="object" && entry.workingDays) wd={...entry.workingDays};
    else if(entry && typeof entry==="object") wd={...entry};
    else wd={...Settings.workingDays};
    wd[day]=!wd[day];
    wd[String(day)]=wd[day];
    // persist as {workingDays:{}} to match backend helper
    if(entry && entry.workingDays) ClassSchedules[selectedClass]={workingDays: wd};
    else ClassSchedules[selectedClass]=wd;
    ClassSchedulesUI=ClassSchedules;
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else {
    Settings.workingDays[day]=!Settings.workingDays[day];
    Settings.workingDays[String(day)]=Settings.workingDays[day];
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  }
});
if($("calClassSelect")) $("calClassSelect").onchange=()=>{ renderWeekly(); renderCalendarMonth(); if(currentTab==="today") renderToday(); };
$("calResetWeekBtn").onclick=async()=>{
  const sel=$("calClassSelect");
  const selectedClass = sel ? sel.value : "";
  if(selectedClass){
    ClassSchedules[selectedClass]={workingDays:{0:false,1:true,2:true,3:true,4:true,5:true,6:true}};
    ClassSchedulesUI=ClassSchedules;
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else {
    Settings.workingDays={0:false,1:true,2:true,3:true,4:true,5:true,6:true};
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  }
};
$("holidayBody").addEventListener("click",async(e)=>{
  const edit=e.target.closest("[data-edit-holiday]");
  if(edit){
    const h=Holidays.find(x=>x.start===edit.dataset.editHoliday); if(!h) return;
    $("holidayModalBody").innerHTML=`<div class="form-grid">
      <div class="form-field full"><label>Name</label><input id="holidayName" value="${esc(h.name)}"></div>
      <div class="form-field"><label>Start date</label><input type="date" id="holidayStart" value="${esc(h.start)}"></div>
      <div class="form-field"><label>End date</label><input type="date" id="holidayEnd" value="${esc(h.end)}"></div>
      <div class="form-field"><label>Type</label><select id="holidayType"><option value="holiday" ${h.type==="holiday"?"selected":""}>Holiday</option><option value="vacation" ${h.type==="vacation"?"selected":""}>Vacation</option><option value="exam" ${h.type==="exam"?"selected":""}>Exam day (working)</option></select></div>
      <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="holidayCancel">Cancel</button><button class="btn primary" id="holidaySave">Save holiday</button></div>
      <div class="inline-error" id="holidayErr" style="display:none"></div></div>`;
    const origStart=h.start;
    Holidays=Holidays.filter(x=>x.start!==origStart);
    openModal(holidayModal);
    $("holidayCancel").onclick=()=>{ Holidays.push(h); closeModal(holidayModal); renderHolidays(); renderCalendarMonth(); };
    $("holidaySave").onclick=async()=>{
      const name=$("holidayName").value.trim(), start=$("holidayStart").value, end=$("holidayEnd").value||start, err=$("holidayErr");
      if(!name||!start||!end||start>end){ err.textContent="Name and a valid date range are required."; err.style.display="block"; return; }
      Holidays.push({name,start,end,category:"",type:$("holidayType").value});
      if(await persistCalendar()){ closeModal(holidayModal); renderHolidays(); renderCalendarMonth(); } else Holidays.push(h);
    };
    return;
  }
  const btn=e.target.closest("[data-del-holiday]"); if(!btn) return;
  Holidays=Holidays.filter(h=>h.start!==btn.dataset.delHoliday);
  if(await persistCalendar()){ renderHolidays(); renderCalendarMonth(); }
});
$("overrideBody").addEventListener("click",async(e)=>{
  const edit=e.target.closest("[data-edit-override]");
  if(edit){
    const o=Overrides.find(x=>x.date===edit.dataset.editOverride); if(!o) return;
    $("overrideModalBody").innerHTML=`<div class="form-grid">
      <div class="form-field"><label>Date</label><input type="date" id="overrideDate" value="${esc(o.date)}"></div>
      <div class="form-field"><label>Becomes</label><select id="overrideWorking"><option value="1" ${o.isWorking?"selected":""}>Working day</option><option value="0" ${!o.isWorking?"selected":""}>Holiday</option></select></div>
      <div class="form-field full"><label>Note</label><input id="overrideNote" value="${esc(o.note)}"></div>
      <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="overrideCancel">Cancel</button><button class="btn primary" id="overrideSave">Save override</button></div>
      <div class="inline-error" id="overrideErr" style="display:none"></div></div>`;
    const orig=o.date;
    Overrides=Overrides.filter(x=>x.date!==orig);
    openModal(overrideModal);
    $("overrideCancel").onclick=()=>{ Overrides.push(o); closeModal(overrideModal); renderOverrides(); renderCalendarMonth(); };
    $("overrideSave").onclick=async()=>{
      const date=$("overrideDate").value, note=$("overrideNote").value.trim(), err=$("overrideErr");
      if(!date){ err.textContent="A date is required."; err.style.display="block"; return; }
      Overrides=Overrides.filter(x=>x.date!==date);
      Overrides.push({date,isWorking:$("overrideWorking").value==="1",note});
      if(await persistCalendar()){ closeModal(overrideModal); renderOverrides(); renderCalendarMonth(); } else Overrides.push(o);
    };
    return;
  }
  const btn=e.target.closest("[data-del-override]"); if(!btn) return;
  Overrides=Overrides.filter(o=>o.date!==btn.dataset.delOverride);
  if(await persistCalendar()){ renderOverrides(); renderCalendarMonth(); }
});
$("addClassBtn").onclick=async()=>{
  const input=$("newClassName"), name=input.value.trim();
  if(!name) return;
  if(Classes.some(c=>c.toLowerCase()===name.toLowerCase())){ alert("That class already exists."); return; }
  try{ await api("/api/settings",{method:"POST",body:JSON.stringify({classes:Classes.concat(name)})}); input.value=""; await loadClassesHolidaysSettings(); renderAll(); }
  catch(e){ alert("Failed to add class: "+e.message); }
};
$("settingsSaveBtn").onclick=async()=>{
  try{
    const start=$("setAttendanceStart")?$("setAttendanceStart").value:"";
    await api("/api/settings",{method:"POST",body:JSON.stringify({
      schoolName:$("setSchoolName").value.trim(),
      address:$("setSchoolAddress").value.trim(),
      lateCutoff:$("setLateThreshold").value||"08:30",
      academicYear:$("setAcademicYear").value,
      attendanceStartDate: start || undefined,
      schoolOpeningDate: start || undefined
    })});
    alert("Settings saved to database.");
    await loadClassesHolidaysSettings(); renderAll();
  }catch(e){ alert("Failed: "+e.message); }
};
$("settingsExportBtn").onclick=()=>exportCSV([["Field","Value"],["School name",$("setSchoolName").value],["Address",$("setSchoolAddress").value],["Late threshold",$("setLateThreshold").value],["Academic year",$("setAcademicYear").value]],"school-settings.csv");
$("backupDownloadBtn").onclick=()=>{
  fetch("/api/backup",{cache:"no-store"}).then(r=>{ if(!r.ok) throw 0; return r.blob(); }).then(b=>{
    const url=URL.createObjectURL(b), a=document.createElement('a'); a.href=url; a.download="atl-backup-"+todayISO()+".db"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }).catch(()=>alert("Backup failed"));
};
$("backupFileInput").onchange=async(e)=>{
  const file=e.target.files&&e.target.files[0]; if(!file) return;
  const status=$("backupStatus"); status.textContent="Restoring…";
  try{
    const form=new FormData(); form.append("file",file);
    const r=await fetch("/api/restore",{method:"POST",body:form,cache:"no-store"});
    const body=await r.json(); if(!r.ok) throw new Error(body.error||("HTTP "+r.status));
    status.textContent="Restore complete. Reloading data…"; await loadAll();
  }catch(err){ status.textContent="Restore failed: "+err.message; }
  e.target.value="";
};
if($("auditExportBtn")) $("auditExportBtn").onclick=()=>{
  const rows=[["Time","Action","Details","By"]].concat(Audit.map(a=>[a.time,a.action,a.details,a.by||"Admin"]));
  exportCSV(rows,"audit_"+todayISO()+".csv");
};
$("auditClearBtn").onclick=()=>alert("Clear audit is managed on the backend.");
if($("calSaveBtn")) $("calSaveBtn").onclick=async()=>{
  try{
    const el=(id)=>$(id);
    await api("/api/settings",{method:"POST",body:JSON.stringify({
      schoolName:el("calSchoolName")?el("calSchoolName").value.trim():Settings.schoolName,
      academicYear:el("calAcademicYear")?el("calAcademicYear").value:Settings.academicYear,
      schoolOpeningDate:el("calStart")?el("calStart").value:Settings.startDate,
      attendanceStartDate:el("calStart")?el("calStart").value:Settings.startDate,
      lateCutoff:el("calLateAfter")?(el("calLateAfter").value||"08:30"):Settings.lateAfter
    })});
    await loadClassesHolidaysSettings(); renderAll(); alert("Saved.");
  }catch(e){ alert("Failed: "+e.message); }
};
detailScroll.addEventListener("click",(e)=>{
  const btn=e.target.closest("button"); if(!btn) return;
  const action=btn.dataset.action, id=parseInt(btn.dataset.id||selectedStudentId);
  if(action==="edit") openEditStudent(id);
  else if(action==="reenroll") openReEnroll(id);
  else if(action==="delete") deleteStudent(id);
  else if(action==="reactivate") reactivateStudent(id);
  else if(action==="print"){
    const s=Students.find(x=>x.id===id); if(!s) return;
    const card=document.querySelector('#detailScroll .detail-card');
    const hist=document.querySelector('#detailScroll .table-wrap');
    const hdr=`<h1>${esc(s.name)} — ${esc(s.roll)} — ${esc(s.class)}${s.batch?` — ${esc(s.batch)}`:""}</h1><p style="font-size:11px;color:#6B6B6B">${esc(s.phone||"")} — ${esc(s.address||"")}</p>`;
    printHTML(hdr+(card?card.outerHTML:"")+(hist?hist.outerHTML:""));
  }
});
studentListEl.addEventListener("click",(e)=>{ const row=e.target.closest(".student-row"); if(!row) return; const id=parseInt(row.dataset.id); if(id) selectStudent(id); });
searchInput.addEventListener("input",()=>{ Timers.clear("search"); Timers.set("search", setTimeout(renderStudentList,260)); });
classFilter.addEventListener("change",renderStudentList);
if(batchFilter) batchFilter.addEventListener("change",renderStudentList);
if(studentStatusFilter) studentStatusFilter.addEventListener("change",renderStudentList);
todayClassFilter.addEventListener("change",renderToday);
todayStatusFilter.addEventListener("change",renderToday);
todaySort.addEventListener("change",renderToday);
reportScope.addEventListener("change",()=>{
  const sc=reportScope.value;
  reportClass.style.display=(sc==="class")?"":"none";
  reportStudent.style.display=sc==="student"?"":"none";
  if(sc==="student") reportStudent.innerHTML='<option value="">Select</option>'+Students.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)} — ${esc(s.roll)}</option>`).join("");
});
reportTime.addEventListener("change",()=>{ const show=reportTime.value==="custom"; reportFrom.style.display=show?"":"none"; reportTo.style.display=show?"":"none"; });
todayTableBody.addEventListener("click",(e)=>{
  // if correction badge clicked, handle correction first
  const corr = e.target.closest("[data-correct]");
  if(corr){
    e.stopPropagation();
    const sid=parseInt(corr.dataset.correctSid), date=corr.dataset.correctDate, old=corr.dataset.correctStatus;
    openCorrection(sid, date, old);
    return;
  }
  const tr=e.target.closest("tr"); if(!tr) return; const sid=parseInt(tr.dataset.student);
  if(sid){ adminNav.querySelector('[data-tab="students"]').click(); setTimeout(()=>selectStudent(sid),120); }
});
// ---- correction (POST /api/correction) ----
function openCorrection(studentId, date, oldStatus){
  const s=Students.find(x=>x.id===studentId);
  if(!s) return;
  const body=$("correctionModalBody");
  if(!body) return;
  body.innerHTML=`
    <div class="form-grid">
      <div class="form-field"><label>Student</label><input value="${esc(s.name)} — ${esc(s.roll)} — ${esc(s.class)}" disabled></div>
      <div class="form-field"><label>Date</label><input value="${esc(date)}" disabled></div>
      <div class="form-field"><label>Current status</label><input value="${esc(oldStatus||"—")}" disabled></div>
      <div class="form-field"><label>New status *</label><select id="corrStatus"><option value="PRESENT">Present</option><option value="LATE">Late</option><option value="ABSENT">Absent</option><option value="NOT_SCHEDULED">Not Scheduled</option></select></div>
      <div class="form-field full"><label>Reason * (3-300 chars)</label><textarea id="corrReason" placeholder="e.g., Late arrival verified, fingerprint misread"></textarea></div>
      <div class="form-field full" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="corrCancel">Cancel</button><button class="btn primary" id="corrSave">Save correction</button></div>
      <div class="inline-error" id="corrErr" style="display:none"></div>
    </div>`;
  // preselect oldStatus if matches
  try{ const sel=$("corrStatus"); if(sel && oldStatus) { const up=String(oldStatus).toUpperCase(); for(let o of sel.options){ if(o.value===up) sel.value=o.value; } } }catch(e){}
  openModal(correctionModal);
  $("corrCancel").onclick=()=>closeModal(correctionModal);
  $("corrSave").onclick=async()=>{
    const newStatus=$("corrStatus").value, reason=$("corrReason").value.trim(), err=$("corrErr");
    if(!newStatus || !reason || reason.length<3 || reason.length>300){ err.textContent="Status and reason (3-300 chars) required."; err.style.display="block"; return; }
    err.style.display="none";
    const btn=$("corrSave"); const prev=btn.textContent; btn.textContent="Saving…"; btn.disabled=true;
    try{
      await api("/api/correction",{method:"POST",body:JSON.stringify({date, studentId, status:newStatus, reason})});
      closeModal(correctionModal);
      // reload authoritative data
      await loadTodayAttendance();
      await loadHistory();
      // reload student detail daily for single student
      try{
        const det=await api("/api/students/"+studentId,{method:"GET"});
        if(det && det.daily){ /* update Daily cache for that student if needed */ }
      }catch(e){}
      renderAll();
      if(selectedStudentId) renderStudentDetail(selectedStudentId);
      alert("Correction saved. Audit preserved.");
    }catch(ex){
      err.textContent=ex.message||"Failed to save correction"; err.style.display="block";
    }finally{ btn.textContent=prev; btn.disabled=false; }
  };
}
// allow correction from student history (detailScroll)
detailScroll.addEventListener("click",(e)=>{
  const c=e.target.closest("[data-correct]");
  if(!c) return;
  e.stopPropagation();
  openCorrection(parseInt(c.dataset.correctSid), c.dataset.correctDate, c.dataset.correctStatus);
});
document.addEventListener("keydown",(e)=>{
  if(e.key==="Escape"){
    if(enrollModal && enrollModal.classList.contains("open")){
      finishEnrollUi();
      if(adminLayer && adminLayer.classList.contains("open")) return;
      resumeSensorScan();
    }
    else if(holidayModal && holidayModal.classList.contains("open")) closeModal(holidayModal);
    else if(overrideModal && overrideModal.classList.contains("open")) closeModal(overrideModal);
    else if(correctionModal && correctionModal.classList.contains("open")) closeModal(correctionModal);
    else if(adminLayer && adminLayer.classList.contains("open")){
      finishEnrollUi();
      adminLayer.classList.remove("open");
      resumeSensorScan();
    }
  }
});
// ---- init ----
cacheLoad();
renderAll();
setState("ready");
loadAll().then(()=>{ setTimeout(sensorScanLoop,300); });
setInterval(()=>{
  if(typeof document!=="undefined" && document.hidden) return;
  loadTodayAttendance().then(()=>{ if(currentTab==="today") renderToday(); });
}, 15000);
// alias used by the injected backend bridge
function saveStorage(){ return cacheSave(); }
