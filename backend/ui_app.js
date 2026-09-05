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
function toLocalISO(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,'0')+"-"+String(d.getDate()).padStart(2,'0'); }
function parseISO(s){ return new Date(s+"T00:00:00"); }
function fmtDate(d){ if(!d) return ""; const dt=parseISO(d); return dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}); }
function inRange(d,a,b){ return d>=a && d<=b; }
async function api(path, opts){
  opts = opts || {};
  // Don't set JSON content-type for FormData (browser sets multipart boundary)
  const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if(!isFormData && !opts.headers?.["Content-Type"]){
    opts.headers = Object.assign({"Content-Type":"application/json"}, opts.headers||{});
  } else {
    opts.headers = Object.assign({}, opts.headers||{});
  }
  try{
    const pin = sessionStorage.getItem("atl_admin_pin") || "";
    if(pin) opts.headers["X-Admin-Pin"] = pin;
  }catch(e){}
  opts.cache = "no-store";
  let r = await fetch(path, opts);
  // blob response for backup/download
  if(opts.responseType === 'blob'){
    if(!r.ok && r.status===401 && !opts._pinRetry && !opts._noPrompt){
      let body = null;
      try{ body = await r.clone().json(); }catch(e){}
      const msg = (body&&(body.error||""))||"";
      if(msg.toLowerCase().includes("admin pin")){
        let pin = null;
        try{ pin = prompt("Admin PIN required"); }catch(e){}
        if(pin){
          try{ sessionStorage.setItem("atl_admin_pin", pin); }catch(e){}
          opts.headers = Object.assign({}, opts.headers, {"X-Admin-Pin": pin});
          opts._pinRetry = true;
          r = await fetch(path, opts);
          if(r.ok) return r.blob();
          try{ body = await r.json(); }catch(e){ body=null; }
          if(r.ok) return r.blob();
          const err = new Error((body&&(body.error||body.detail||body.reason))||("HTTP "+r.status)); err.status=r.status; err.body=body; throw err;
        }
      }
    }
    if(!r.ok){
      let body = null;
      try{ body = await r.json(); }catch(e){}
      const err = new Error((body&&(body.error||body.detail||body.reason))||("HTTP "+r.status)); err.status=r.status; err.body=body; throw err;
    }
    return r.blob();
  }
  let body = null;
  try{ body = await r.json(); }catch(e){}
  if(!r.ok && r.status===401 && !opts._pinRetry && !opts._noPrompt){
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
    if(st.classSchedules && typeof st.classSchedules==="object") {
      Object.keys(st.classSchedules).forEach(k => {
        ClassSchedules[k] = Object.assign({}, ClassSchedules[k] || {}, st.classSchedules[k]);
      });
      ClassSchedulesUI = ClassSchedules;
    }
    if(st.batchSchedules && typeof st.batchSchedules==="object") {
      Object.keys(st.batchSchedules).forEach(k => {
        BatchSchedules[k] = Object.assign({}, BatchSchedules[k] || {}, st.batchSchedules[k]);
      });
    }
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
    set("setPresentCutoff", Settings.presentCutoff || "08:00");
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
    // background reconcile must not prompt — use _noPrompt so public idle does not spam PIN
    if(!(typeof document!=="undefined" && document.hidden)){
      try{ await api("/api/reconcile",{method:"POST",body:JSON.stringify({date:t}), _noPrompt:true}); }catch(e){}
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
  ensureFirstStudent();
}
/* First student is always selected — never an empty detail pane */
function ensureFirstStudent(){
  if(!Students.length){ selectedStudentId=null; return; }
  if(!Students.some(s=>s.id===selectedStudentId)){
    const sorted=[...Students].sort((a,b)=>((b.active-a.active)||String(a.name).localeCompare(String(b.name))));
    selectedStudentId=sorted[0].id;
  }
  try{ renderStudentDetail(selectedStudentId); }catch(e){}
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
  attDatePreset=$("attDatePreset"), attSingleDate=$("attSingleDate"),
  attFromDate=$("attFromDate"), attToDate=$("attToDate"), attApplyBtn=$("attApplyBtn"),
  attClassFilter=$("attClassFilter"), attBatchFilter=$("attBatchFilter"), attStudentFilter=$("attStudentFilter"),
  attStatusFilter=$("attStatusFilter"), attSort=$("attSort"),
  attRefreshBtn=$("attRefreshBtn"), attPrintBtn=$("attPrintBtn"), attExportBtn=$("attExportBtn"),
  attDateLabel=$("attDateLabel"), attModeBadge=$("attModeBadge"), attStats=$("attStats"),
  attTableHead=$("attTableHead"), attTableBody=$("attTableBody"),
  attUnknownWrap=$("attUnknownWrap"), attUnknownCount=$("attUnknownCount"), attUnknownBody=$("attUnknownBody"),
  todayDateLabel=$("todayDateLabel"), todayClassFilter=$("todayClassFilter"),
  todayStatusFilter=$("todayStatusFilter"), todaySort=$("todaySort"),
  todayStats=$("todayStats"), todayTableBody=$("todayTableBody"), todayUnknownBody=$("todayUnknownBody"),
  reportScope=$("reportScope"), reportClass=$("reportClass"), reportStudent=$("reportStudent"),
  reportTime=$("reportTime"), reportFrom=$("reportFrom"), reportTo=$("reportTo"),
  reportStats=$("reportStats"), reportBody=$("reportBody"),
  holidayBody=$("holidayBody"), overrideBody=$("overrideBody"),
  calendarGrid=$("calendarGrid"), calMonthLabel=$("calMonthLabel"),
  classBody=$("classBody"), auditBody=$("auditBody"),
  enrollModal=$("enrollModal"),
  correctionModal=$("correctionModal"),
  daySheetModal=$("daySheetModal"), daySheetTitle=$("daySheetTitle"), daySheetBody=$("daySheetBody"),
  enrollTitle=$("enrollTitle"), enrollSub=$("enrollSub"), enrollBody=$("enrollBody");

const Timers={ _ids:{}, set(n,id){ this.clear(n); this._ids[n]=id; },
  clear(n){ if(this._ids[n]){ clearTimeout(this._ids[n]); clearInterval(this._ids[n]); } delete this._ids[n]; },
  clearAll(){ Object.keys(this._ids).forEach(k=>{ clearTimeout(this._ids[k]); clearInterval(this._ids[k]); }); this._ids={}; } };
let currentTab="students", selectedStudentId=null, calendarMonth=new Date();
/* Academic-year override span (null = follow Settings); set by the year popup */
let attAcadFrom=null, attAcadTo=null;

function openModal(m){ m.classList.add("open"); }
function closeModal(m){ m.classList.remove("open"); }
[enrollModal, correctionModal, daySheetModal].forEach(m=>{
  if(!m) return;
  /* Veil dismiss needs press AND release on the veil: a drag that
     starts inside (e.g. finishing a text selection outside the card)
     fires click targeting m but must never close the window. */
  m.addEventListener("mousedown", (e)=>{ m._veilDown=(e.target===m); });
  m.addEventListener("click", (e)=>{
    if(e.target!==m || !m._veilDown) return;
    m._veilDown=false;
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
  const isAdminOpen = typeof adminLayer !== "undefined" && adminLayer && adminLayer.classList.contains("open");
  if(fid && String(fid).indexOf("__unknown__")===0){
    if(!isAdminOpen){
      setState("identifying");
      await new Promise(r=>setTimeout(r, 180));
      if(seq && seq < _lastHandledScanSeq) return;
      showUnknown();
    }
    loadTodayAttendance().then(()=>{ if(currentTab==="attendance" || currentTab==="today") renderAttendance(); });
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
    if(!isAdminOpen){
      setState("identifying");
      await new Promise(r=>setTimeout(r, 180));
      if(seq && seq < _lastHandledScanSeq) return;
      showUnknown();
    }
    loadTodayAttendance().then(()=>{ if(currentTab==="attendance" || currentTab==="today") renderAttendance(); });
    return;
  }
  if(!isAdminOpen){
    setState("identifying");
    await new Promise(r=>setTimeout(r, 180));
    if(seq && seq < _lastHandledScanSeq) return;
    const status = info.status ? statusUI(info.status) : "Present";
    const time = info.time || new Date().toTimeString().slice(0,8);
    showIdentity(s, status, time, info.date ? fmtDate(info.date) : "");
  }
  loadTodayAttendance().then(()=>{ if(currentTab==="attendance" || currentTab==="today") renderAttendance(); });
};
let _scanLoopActive=true, _scanRequestInFlight=false, _scanLoopTimer=null;
function pauseSensorScan(){ _scanLoopActive=false; if(_scanLoopTimer){ clearTimeout(_scanLoopTimer); _scanLoopTimer=null; } if(promptText){ promptText.classList.remove("scanning","identifying","detecting","is-hidden"); } }
function resumeSensorScan(){
  _scanLoopActive=true;
  if(!_resultHold && (!adminLayer || !adminLayer.classList.contains("open"))) setState("ready");
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
  const isEnrollOpen = (enrollModal && enrollModal.classList.contains("open")) || ($("scanModal") && $("scanModal").classList.contains("open"));
  if(isEnrollOpen){ _scanLoopTimer=setTimeout(sensorScanLoop,500); return; }
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
        if(!adminLayer || !adminLayer.classList.contains("open")) setState("ready");
        _scanLoopTimer=setTimeout(sensorScanLoop,nextDelay);
      }
    }
  }
}
// ---- render: Students ----
function renderClassFilters(){
  const opts=['<option value="">All Classes</option>'].concat(Classes.map(c=>`<option>${esc(c)}</option>`)).join("");
  if(classFilter) classFilter.innerHTML=opts;
  if(attClassFilter) attClassFilter.innerHTML=opts;
  if(todayClassFilter) todayClassFilter.innerHTML=opts;
  if(reportClass) reportClass.innerHTML='<option value="">Select class</option>'+Classes.map(c=>`<option>${esc(c)}</option>`).join("");
  const batches=[...new Set([...(Batches||[]), ...Students.map(s=>s.batch).filter(Boolean)])].sort();
  if(batchFilter){
    const cur=batchFilter.value;
    batchFilter.innerHTML='<option value="">All Batches</option>'+batches.map(b=>`<option ${b===cur?'selected':''}>${esc(b)}</option>`).join("");
    if(!batches.includes(cur)) batchFilter.value="";
  }
  if(attBatchFilter){
    const cur=attBatchFilter.value;
    attBatchFilter.innerHTML='<option value="">All Batches</option>'+batches.map(b=>`<option ${b===cur?'selected':''}>${esc(b)}</option>`).join("");
    if(!batches.includes(cur)) attBatchFilter.value="";
  }
  populateAttStudents();
  // also populate schedule context selector (Global, Classes, Batches)
  populateScheduleSelector();
}
function populateAttStudents(){
  if(!attStudentFilter) return;
  const cur = attStudentFilter.value;
  const cf = attClassFilter ? attClassFilter.value : "";
  const bf = attBatchFilter ? attBatchFilter.value : "";
  const inScope = Students.filter(s => s.active && (!cf || s.class === cf) && (!bf || (s.batch || "") === bf));
  inScope.sort((a,b) => (a.name||"").localeCompare(b.name||""));
  let html = '<option value="">All Students</option>';
  html += inScope.map(s => `<option value="${s.id}" ${String(s.id)===cur?'selected':''}>${esc(s.name)} (${esc(s.roll||"—")})</option>`).join("");
  attStudentFilter.innerHTML = html;
  if(cur && !inScope.some(s => String(s.id)===cur)) attStudentFilter.value = "";
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
            ${s.active ? `<button class="btn danger icon-del" data-action="delete" data-id="${s.id}" aria-label="Deactivate">${TRASH_ICON}</button>` : `<button class="btn primary" data-action="reactivate" data-id="${s.id}">Re-activate</button>`}
            <button class="btn" data-action="print" data-id="${s.id}">Print profile</button>
            <button class="btn" data-correct data-correct-sid="${s.id}" data-correct-date="${esc(todayISO())}" data-correct-status="Present" style="border-style:dashed">Correct today</button>
          </div>
        </div>
      </div>
      <div class="table-wrap"><div style="padding:10px 12px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;border-bottom:1px solid var(--line)"><span>Attendance history — recent scans</span></div><div class="table-scroll large"><table><thead><tr><th>Date</th><th>Time</th><th>Status</th><th>Fingerprint</th><th>Action</th></tr></thead><tbody>${histRows}</tbody></table></div></div>
    </div>`;
}
function selectStudent(id){ selectedStudentId=id; renderStudentList(); renderStudentDetail(id); }
// ---- render: Unified Attendance Workspace (Live Today + Historical) ----
async function renderAttendance(){
  const attPane = document.getElementById("pane-attendance");
  if(!attPane) return;
  const preset = (attDatePreset && attDatePreset.value) ? attDatePreset.value : "today";
  const today = todayISO();
  let from = today, to = today;

  if(preset === "today"){
    from = today; to = today;
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  } else if(preset === "yesterday"){
    const d = new Date(); d.setDate(d.getDate() - 1);
    from = toLocalISO(d); to = from;
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  } else if(preset === "custom_day"){
    if(attSingleDate){
      attSingleDate.style.display = "";
      if(!attSingleDate.value) attSingleDate.value = today;
      from = attSingleDate.value; to = from;
    }
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  } else if(preset === "custom_range"){
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "";
    if(attToDate) attToDate.style.display = "";
    from = attFromDate.value || today;
    to = attToDate.value || today;
    if(!attFromDate.value) attFromDate.value = from;
    if(!attToDate.value) attToDate.value = to;
    if(from > to){
      attStats.innerHTML = `<div class="inline-error">Invalid date range — Start date must be before End date.</div>`;
      attTableBody.innerHTML = `<tr><td colspan="7"><div class="empty"><b>Invalid range</b>Choose a valid custom date range.</div></td></tr>`;
      return;
    }
  } else if(preset === "week"){
    const d = new Date(); d.setDate(d.getDate() - 6);
    from = toLocalISO(d); to = today;
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  } else if(preset === "month"){
    const d = new Date(); d.setDate(1);
    from = toLocalISO(d); to = today;
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  } else if(preset === "academic"){
    from = attAcadFrom || Settings.startDate || Settings.schoolOpeningDate || "2026-06-15";
    to = attAcadTo || Settings.endDate || today;
    if(attSingleDate) attSingleDate.style.display = "none";
    if(attFromDate) attFromDate.style.display = "none";
    if(attToDate) attToDate.style.display = "none";
  }

  if(attApplyBtn) attApplyBtn.style.display = (preset === "custom_range" || preset === "custom_day") ? "" : "none";

  const isSingleDay = (from === to);
  const isToday = (from === today);
  const cf = attClassFilter ? attClassFilter.value : "";
  const bf = attBatchFilter ? attBatchFilter.value : "";
  const sf = attStatusFilter ? attStatusFilter.value : "";
  const sort = attSort ? attSort.value : "time_desc";
  const sid = (attStudentFilter && attStudentFilter.value) ? parseInt(attStudentFilter.value) : null;
  const selStudent = sid ? Students.find(s => s.id === sid) : null;

  // Filter active students by class & batch or single student
  const studentsInScope = selStudent ? [selStudent] : Students.filter(s => s.active && (!cf || s.class === cf) && (!bf || (s.batch || "") === bf));
  const totalStudents = studentsInScope.length;
  const byId = new Map(Students.map(s => [s.id, s]));

  // Update mode badge
  if(attModeBadge){
    if(selStudent){
      attModeBadge.textContent = "STUDENT: " + selStudent.name.toUpperCase();
      attModeBadge.style.cssText = "font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:2px 8px;border:1px solid #2F5D34;border-radius:2px;background:#2F5D34;color:#F2F3F6;font-weight:600";
    } else if(isToday){
      attModeBadge.textContent = "Live Today";
      attModeBadge.style.cssText = "font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:2px 8px;border:1px solid #2F5D34;border-radius:2px;background:#2F5D34;color:#F2F3F6;font-weight:600";
    } else if(preset === "yesterday"){
      attModeBadge.textContent = "Yesterday";
      attModeBadge.style.cssText = "font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:2px 8px;border:1px solid var(--line);border-radius:2px;background:var(--paper);color:var(--ink-2)";
    } else if(isSingleDay){
      attModeBadge.textContent = `Date: ${from}`;
      attModeBadge.style.cssText = "font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:2px 8px;border:1px solid var(--line);border-radius:2px;background:var(--paper);color:var(--ink-2)";
    } else {
      let days = 1;
      try {
        const d1 = new Date(from+"T00:00:00"), d2 = new Date(to+"T00:00:00");
        days = Math.round((d2 - d1)/(1000*60*60*24)) + 1;
      }catch(e){}
      attModeBadge.textContent = `Range: ${from} → ${to} (${days}d)`;
      attModeBadge.style.cssText = "font-size:10px;letter-spacing:0.1em;text-transform:uppercase;padding:2px 8px;border:1px solid var(--line);border-radius:2px;background:var(--paper);color:var(--ink-2)";
    }
  }

  // Fetch events
  let ev = [];
  if(isToday && !selStudent){
    ev = Attendance;
  } else {
    try {
      ev = await api("/api/attendance", {method:"GET"});
    } catch(e){
      ev = Attendance;
    }
  }

  // Filter events in date range
  let list = ev.filter(a => a.date >= from && a.date <= to).map(mapEvent);
  if(selStudent) list = list.filter(a => a.studentId === sid);
  else {
    if(cf) list = list.filter(a => { const s = byId.get(a.studentId); return s && s.class === cf; });
    if(bf) list = list.filter(a => { const s = byId.get(a.studentId); return s && (s.batch || "") === bf; });
  }

  // Fetch authoritative metrics for single-student scope
  let rpt = null;
  if(selStudent){
    try {
      rpt = await api("/api/reports?studentId=" + sid, {method: "GET"});
    } catch(e){}
  }

  // Scheduled vs Not Scheduled calculations
  let scheduled = 0;
  let scheduledFiltered = [];
  let notScheduledFiltered = [];

  if(isSingleDay){
    scheduledFiltered = studentsInScope.filter(s => isWorkingDayForStudent(from, s));
    notScheduledFiltered = studentsInScope.filter(s => !isWorkingDayForStudent(from, s));
    scheduled = scheduledFiltered.length;
  } else if(selStudent && rpt && typeof rpt.eligible === "number"){
    scheduled = rpt.eligible;
  } else {
    try {
      let d = parseISO(from), endD = parseISO(to);
      while(d <= endD){
        const iso = toLocalISO(d);
        for(const stu of studentsInScope){
          if(isWorkingDayForStudent(iso, stu)) scheduled++;
        }
        d.setDate(d.getDate() + 1);
      }
    } catch(e){
      scheduled = list.filter(a => a.status === "Present" || a.status === "Late" || a.status === "Absent").length;
    }
  }

  // Filtered rows display
  let rows = [];
  if(isSingleDay){
    rows = list.map(a => { const s = byId.get(a.studentId); return s ? {a, s} : null; }).filter(Boolean);
    if(sf){
      if(sf === "Duplicate") rows = rows.filter(r => r.a.isDuplicate);
      else if(sf === "Unknown") rows = [];
      else if(sf === "Not Scheduled"){
        rows = notScheduledFiltered.map(s => ({a:{status:"Not Scheduled", time:"—", isDuplicate:false, fingerId:s.fid?parseInt(String(s.fid).replace("F-","")):null, date:from}, s}));
      } else if(sf === "Absent"){
        const presentIds = new Set(rows.filter(r => r.a.status === "Present" || r.a.status === "Late").map(r => r.s.id));
        const absentStudents = scheduledFiltered.filter(s => !presentIds.has(s.id));
        rows = absentStudents.map(s => ({a:{status:"Absent", time:"—", isDuplicate:false, fingerId:null, date:from}, s}));
      } else {
        rows = rows.filter(r => r.a.status === sf);
      }
    } else if(selStudent && !rows.length){
      if(scheduledFiltered.length){
        rows = [{a:{status:"Absent", time:"—", isDuplicate:false, fingerId:null, date:from}, s:selStudent}];
      } else {
        rows = [{a:{status:"Not Scheduled", time:"—", isDuplicate:false, fingerId:selStudent.fid?parseInt(String(selStudent.fid).replace("F-","")):null, date:from}, s:selStudent}];
      }
    }
  } else {
    // Multi-day
    rows = list.map(a => { const s = byId.get(a.studentId); return s ? {a, s} : null; }).filter(Boolean);
    if(sf){
      if(sf === "Duplicate") rows = rows.filter(r => r.a.isDuplicate);
      else if(sf === "Unknown") rows = [];
      else rows = rows.filter(r => r.a.status === sf);
    }
  }

  // Sort rows
  rows.sort((x, y) => {
    if(!isSingleDay){
      const dc = (y.a.date || "").localeCompare(x.a.date || "");
      if(dc !== 0) return dc;
    }
    if(sort === "time_desc") return (y.a.time || "").localeCompare(x.a.time || "");
    if(sort === "time_asc") return (x.a.time || "").localeCompare(y.a.time || "");
    if(sort === "name_asc") return x.s.name.localeCompare(y.s.name);
    if(sort === "roll_asc") return x.s.roll.localeCompare(y.s.roll);
    if(sort === "class_asc") return x.s.class.localeCompare(y.s.class);
    if(sort === "status_asc") return (x.a.status || "").localeCompare(y.a.status || "");
    return 0;
  });

  // KPI Calculations
  let presentAll, lateAll, absentAll, pct;
  if(selStudent && rpt && typeof rpt === "object" && "eligible" in rpt){
    presentAll = rpt.present ?? 0;
    lateAll = rpt.late ?? 0;
    absentAll = rpt.absent ?? 0;
    pct = rpt.rate ?? 0;
  } else if(isToday && Kpis && Kpis.date === today && !cf && !bf && !selStudent && typeof Kpis.scheduled === "number"){
    presentAll = Kpis.present ?? 0;
    lateAll = Kpis.late ?? 0;
    absentAll = Kpis.absent ?? Math.max(0, (Kpis.scheduled ?? scheduled) - presentAll - lateAll);
    pct = Kpis.scheduled ? Math.round((presentAll + lateAll)/Kpis.scheduled*100) : 0;
  } else if(isSingleDay){
    presentAll = list.filter(a => a.status === "Present").length;
    lateAll = list.filter(a => a.status === "Late").length;
    absentAll = Math.max(0, scheduled - presentAll - lateAll);
    pct = scheduled ? Math.round((presentAll + lateAll)/scheduled*100) : 0;
  } else {
    presentAll = list.filter(a => a.status === "Present").length;
    lateAll = list.filter(a => a.status === "Late").length;
    absentAll = list.filter(a => a.status === "Absent").length;
    pct = scheduled ? Math.round((presentAll + lateAll)/scheduled*100) : 0;
  }

  const present = sf ? rows.filter(r => r.a.status === "Present").length : presentAll;
  const late = sf ? rows.filter(r => r.a.status === "Late").length : lateAll;
  const absent = sf ? (sf === "Absent" ? rows.length : (sf === "Not Scheduled" ? 0 : absentAll)) : absentAll;
  const notScheduledCount = isSingleDay ? notScheduledFiltered.length : list.filter(a => a.status === "Not Scheduled").length;
  const dup = rows.filter(r => r.a.isDuplicate).length;

  // Unknown scan attempts
  let unks = [];
  try {
    unks = Unknowns.filter(u => (!u.date && isToday) || (u.date >= from && u.date <= to));
    const evUnks = ev.filter(e => {
      const isUnk = e.result === "UNKNOWN" || e.status === "UNKNOWN" || (!e.studentId && e.status === "Unknown");
      return isUnk && (!e.date || (e.date >= from && e.date <= to));
    });
    for(const eu of evUnks){
      if(!unks.some(u => u.time === eu.time && u.finger === (eu.fingerId ? "F-"+eu.fingerId : "—"))){
        unks.push({time: eu.time, finger: eu.fingerId ? "F-"+eu.fingerId : "—", note: "Unknown fingerprint", date: eu.date});
      }
    }
  } catch(e){
    unks = isToday ? Unknowns : [];
  }

  // Update attDateLabel — concise mono readout; never stretches the row
  const _CM=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const _fmtC=iso=>{ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||""); if(!m) return iso||"—"; return (+m[3])+" "+_CM[+m[2]-1]+" "+m[1].slice(2); };
  const _span=(from===to)?_fmtC(from):(_fmtC(from)+" → "+_fmtC(to));
  const workingTag = isWorkingDayUI(from) ? "" : " · Off";
  if(selStudent){
    attDateLabel.textContent = `${selStudent.name} · ${_span}`;
  } else if(isToday){
    attDateLabel.textContent = `Today · ${_fmtC(today)}${workingTag} · ${scheduled} scheduled`;
  } else if(isSingleDay){
    attDateLabel.textContent = `${_fmtC(from)}${workingTag} · ${scheduled} scheduled`;
  } else {
    let dayCount = 1;
    try {
      const d1 = new Date(from+"T00:00:00"), d2 = new Date(to+"T00:00:00");
      dayCount = Math.round((d2 - d1)/(1000*60*60*24)) + 1;
    } catch(e){}
    attDateLabel.textContent = `${_span} · ${dayCount}d`;
  }

  // Render 9 KPI cards (date value stays concise + single-line — never wraps)
  const _isoP=iso=>{ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||""); return m?[m[1],m[2],+m[3]]:null; };
  const _fP=p=>p?p[2]+" "+_CM[+p[1]-1]+" "+p[0].slice(2):"—";
  let dateCardVal;
  if(isSingleDay){ dateCardVal=_fmtC(from); }
  else {
    const a=_isoP(from), b=_isoP(to);
    if(a&&b&&a[0]===b[0]&&a[1]===b[1]) dateCardVal=`${a[2]} | ${b[2]} ${_CM[+a[1]-1]} ${a[0].slice(2)}`;
    else if(a&&b&&a[0]===b[0]) dateCardVal=`${a[2]} ${_CM[+a[1]-1]} | ${b[2]} ${_CM[+b[1]-1]} ${a[0].slice(2)}`;
    else dateCardVal=`${_fmtC(from)} | ${_fmtC(to)}`;
  }
  if(selStudent && rpt && typeof rpt === "object" && "eligible" in rpt){
    attStats.innerHTML = `
      <div class="stat"><b>${esc(selStudent.name)}</b><label>Student</label></div>
      <div class="stat"><b>${rpt.present ?? 0}</b><label>Present</label></div>
      <div class="stat"><b>${rpt.late ?? 0}</b><label>Late</label></div>
      <div class="stat"><b>${rpt.absent ?? 0}</b><label>Absent</label></div>
      <div class="stat"><b>${rpt.eligible ?? 0}</b><label>Eligible days</label></div>
      <div class="stat"><b>${rpt.attended ?? 0}</b><label>Attended</label></div>
      <div class="stat"><b>${dup}</b><label>Duplicate scans</label></div>
      <div class="stat"><b>${rpt.rate ?? 0}%</b><label>Attendance %</label></div>
      <div class="stat"><b>${esc(dateCardVal)}</b><label>Date</label></div>`;
  } else {
    attStats.innerHTML = `
      <div class="stat"><b>${totalStudents}</b><label>Total students</label></div>
      <div class="stat"><b>${present}</b><label>Present</label></div>
      <div class="stat"><b>${late}</b><label>Late</label></div>
      <div class="stat"><b>${absent}</b><label>Absent</label></div>
      <div class="stat"><b>${notScheduledCount}</b><label>Not Scheduled</label></div>
      <div class="stat"><b>${unks.length}</b><label>Unknown scans</label></div>
      <div class="stat"><b>${dup}</b><label>Duplicate scans</label></div>
      <div class="stat"><b>${pct}%</b><label>Attendance %</label></div>
      <div class="stat"><b>${esc(dateCardVal)}</b><label>Date</label></div>`;
  }

  // Render Table Head
  if(isSingleDay){
    attTableHead.innerHTML = `<tr><th>Time</th><th>Student</th><th>Roll</th><th>Class</th><th>Status</th><th>Fingerprint</th></tr>`;
  } else {
    attTableHead.innerHTML = `<tr><th>Date</th><th>Time</th><th>Student</th><th>Roll</th><th>Class</th><th>Status</th><th>Working Day?</th></tr>`;
  }

  // Render Table Body
  if(!rows.length){
    attTableBody.innerHTML = `<tr><td colspan="${isSingleDay ? 6 : 7}"><div class="empty"><b>No attendance records</b>No scans recorded for this selection. Place a finger on the sensor or adjust the filter.</div></td></tr>`;
  } else {
    attTableBody.innerHTML = rows.map(r => {
      const isDupeBadge = r.a.isDuplicate ? ' <span class="badge">Duplicate</span>' : '';
      const correctBtn = `<button class="btn" data-correct data-correct-sid="${r.s.id}" data-correct-date="${esc(r.a.date || from)}" data-correct-status="${esc(r.a.status)}" style="height:20px;padding:0 6px;font-size:9px;margin-left:6px">Correct</button>`;
      if(isSingleDay){
        return `<tr data-student="${r.s.id}">
          <td>${esc(r.a.time)}</td>
          <td>${esc(r.s.name)}</td>
          <td>${esc(r.s.roll)}</td>
          <td>${esc(r.s.class)}</td>
          <td><span class="badge ${r.a.status.toLowerCase().replace(" ","-")}">${esc(r.a.status)}</span>${isDupeBadge} ${correctBtn}</td>
          <td>${esc(r.a.fingerId!=null ? "F-"+r.a.fingerId : "")}</td>
        </tr>`;
      } else {
        let working = "—";
        if(r.s && r.a.date){
          working = isWorkingDayForStudent(r.a.date, r.s) ? "Scheduled" : "Not Scheduled";
          if(r.a.status === "Not Scheduled") working = "Not Scheduled";
          else if(r.a.status === "Absent" && !isWorkingDayForStudent(r.a.date, r.s)) working = "Not Scheduled";
        }
        return `<tr data-student="${r.s.id}">
          <td>${esc(r.a.date)}</td>
          <td>${esc(r.a.time)}</td>
          <td>${esc(r.s.name)}</td>
          <td>${esc(r.s.roll)}</td>
          <td>${esc(r.s.class)}</td>
          <td><span class="badge ${r.a.status.toLowerCase().replace(" ","-")}">${esc(r.a.status)}</span>${isDupeBadge} ${correctBtn}</td>
          <td>${esc(working)}</td>
        </tr>`;
      }
    }).join("");
  }

  // Render Unknown Attempts section
  if(attUnknownCount) attUnknownCount.textContent = `${unks.length} attempt${unks.length === 1 ? "" : "s"}`;
  if(attUnknownBody){
    if(unks.length && !selStudent){
      attUnknownBody.innerHTML = unks.map(u => `<tr><td>${esc(u.time)}</td><td>${esc(u.finger)}</td><td>${esc(u.note)}</td></tr>`).join("");
      if(attUnknownWrap) attUnknownWrap.style.display = "";
    } else if(selStudent){
      if(attUnknownWrap) attUnknownWrap.style.display = "none";
    } else {
      attUnknownBody.innerHTML = `<tr><td colspan="3"><div class="empty" style="padding:16px"><b>No unknown scan attempts</b></div></td></tr>`;
      if(attUnknownWrap) attUnknownWrap.style.display = "";
    }
  }
}

function renderToday(){
  if(attDatePreset) attDatePreset.value = "today";
  renderAttendance();
}
async function renderReports(){
  renderAttendance();
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
    if(v.workingDays) {
      out[k]={workingDays: v.workingDays};
      if(v.presentCutoff) out[k].presentCutoff = v.presentCutoff;
      if(v.lateCutoff) out[k].lateCutoff = v.lateCutoff;
    } else {
      out[k]=v;
    }
  });
  return out;
}
function batchSchedulesToBackend(){
  const out={};
  Object.keys(BatchSchedules).forEach(k=>{
    const v=BatchSchedules[k];
    if(!v) return;
    if(v.workingDays) {
      out[k]={workingDays: v.workingDays};
      if(v.presentCutoff) out[k].presentCutoff = v.presentCutoff;
      if(v.lateCutoff) out[k].lateCutoff = v.lateCutoff;
    } else {
      out[k]=v;
    }
  });
  return out;
}
function parseScheduleContext(val){
  val = String(val||"").trim();
  if(!val) return {type:"global", name:"", key:"", label:"Global (all classes & batches)"};
  if(val.startsWith("class:")) {
    const name = val.slice(6).trim();
    return {type:"class", name, key:name, label:`Class: ${name}`};
  }
  if(val.startsWith("batch:")) {
    const name = val.slice(6).trim();
    return {type:"batch", name, key:name, label:`Batch: ${name}`};
  }
  const allBatches = [...new Set([...(Batches||[]), ...Students.map(s=>s.batch).filter(Boolean)])];
  if(allBatches.includes(val) || val.includes("|")) {
    return {type:"batch", name:val, key:val, label:`Batch: ${val}`};
  }
  return {type:"class", name:val, key:val, label:`Class: ${val}`};
}
function getScheduleContext(){
  const sel = $("calClassSelect");
  return parseScheduleContext(sel ? sel.value : "");
}
function populateScheduleSelector(){
  const sel=$("calClassSelect");
  if(!sel) return;
  const cur = sel.value;
  const batches = [...new Set([...(Batches||[]), ...Students.map(s=>s.batch).filter(Boolean)])].sort();
  let html = '<option value="">Global schedule (all classes & batches)</option>';
  if(Classes && Classes.length){
    html += '<optgroup label="Classes">';
    Classes.forEach(c=>{
      const val = `class:${c}`;
      const isSel = (cur === val || cur === c) ? 'selected' : '';
      html += `<option value="${val}" ${isSel}>${esc(c)}</option>`;
    });
    html += '</optgroup>';
  }
  if(batches && batches.length){
    html += '<optgroup label="Batches">';
    batches.forEach(b=>{
      const val = `batch:${b}`;
      const isSel = (cur === val || cur === b) ? 'selected' : '';
      html += `<option value="${val}" ${isSel}>${esc(b)}</option>`;
    });
    html += '</optgroup>';
  }
  sel.innerHTML = html;
}
function getWorkingDaysForBatch(batchName){
  if(batchName && BatchSchedules[batchName]){
    const v = BatchSchedules[batchName];
    if(v && typeof v==="object" && v.workingDays) return v.workingDays;
    if(v && typeof v==="object") return v;
  }
  if(batchName && batchName.includes("|")){
    const grade = batchName.split("|")[0].trim();
    if(grade && ClassSchedules[grade]){
      const v = ClassSchedules[grade];
      if(v && typeof v==="object" && v.workingDays) return v.workingDays;
      if(v && typeof v==="object") return v;
    }
  }
  return Settings.workingDays;
}
function isWorkingDayForBatch(d, batchName){
  const ov = getOverride(d);
  if(ov) return ov.isWorking;
  const hol = isHoliday(d);
  if(hol){
    const type = String(hol.type||"holiday").toLowerCase();
    return type === "exam";
  }
  const day = new Date(d+"T00:00:00").getDay();
  const wd = getWorkingDaysForBatch(batchName);
  return asBool(wd[day] ?? wd[String(day)]);
}
function isWorkingDayForContext(d, ctx){
  if(!ctx || ctx.type === "global") return isWorkingDayUI(d);
  if(ctx.type === "class") return isWorkingDayForClass(d, ctx.name);
  if(ctx.type === "batch") return isWorkingDayForBatch(d, ctx.name);
  return isWorkingDayUI(d);
}
function getScheduleTiming(ctx){
  const gPresent = Settings.presentCutoff || "08:00";
  const gLate = Settings.lateCutoff || Settings.lateAfter || "08:30";
  if(!ctx || ctx.type === "global"){
    return {
      presentCutoff: gPresent,
      lateCutoff: gLate,
      isInherited: false,
      level: "global"
    };
  }
  if(ctx.type === "class"){
    const entry = ClassSchedules[ctx.name];
    const cp = entry && entry.presentCutoff ? entry.presentCutoff : null;
    const cl = entry && entry.lateCutoff ? entry.lateCutoff : null;
    const hasCustom = Boolean(cp || cl);
    return {
      presentCutoff: cp || gPresent,
      lateCutoff: cl || gLate,
      isInherited: !hasCustom,
      level: "class",
      customPresent: cp,
      customLate: cl
    };
  }
  if(ctx.type === "batch"){
    const entry = BatchSchedules[ctx.name];
    const bp = entry && entry.presentCutoff ? entry.presentCutoff : null;
    const bl = entry && entry.lateCutoff ? entry.lateCutoff : null;
    if(bp || bl){
      return {
        presentCutoff: bp || gPresent,
        lateCutoff: bl || gLate,
        isInherited: false,
        level: "batch",
        customPresent: bp,
        customLate: bl
      };
    }
    if(ctx.name.includes("|")){
      const grade = ctx.name.split("|")[0].trim();
      const cEntry = ClassSchedules[grade];
      if(cEntry && (cEntry.presentCutoff || cEntry.lateCutoff)){
        return {
          presentCutoff: cEntry.presentCutoff || gPresent,
          lateCutoff: cEntry.lateCutoff || gLate,
          isInherited: true,
          level: "class"
        };
      }
    }
    return {
      presentCutoff: gPresent,
      lateCutoff: gLate,
      isInherited: true,
      level: "global"
    };
  }
  return { presentCutoff: gPresent, lateCutoff: gLate, isInherited: false, level: "global" };
}
function renderScheduleTiming(){
  const ctx = getScheduleContext();
  const badge = $("schedContextBadge");
  const notice = $("schedInheritNotice");
  const presentInput = $("schedPresentCutoff");
  const lateInput = $("schedLateCutoff");
  const revertBtn = $("schedRevertTimingBtn");
  if(!notice || !presentInput || !lateInput) return;

  const timing = getScheduleTiming(ctx);
  presentInput.value = timing.presentCutoff;
  lateInput.value = timing.lateCutoff;

  if(ctx.type === "global"){
    if(badge){
      badge.textContent = "GLOBAL SCHEDULE";
      badge.style.background = "var(--ink)";
      badge.style.color = "#fff";
      badge.style.display = "inline-block";
    }
    notice.textContent = "Global fallback (configured in Attendance Rules)";
    notice.style.background = "#fff";
    notice.style.color = "var(--ink)";
    if(revertBtn) revertBtn.style.display = "none";
  } else if(ctx.type === "class"){
    if(badge){
      badge.textContent = `CLASS · ${ctx.name.toUpperCase()}`;
      badge.style.background = timing.isInherited ? "" : "var(--ok)";
      badge.style.color = timing.isInherited ? "" : "#fff";
      badge.style.display = "inline-block";
    }
    if(timing.isInherited){
      notice.textContent = `Inheriting global timings (${timing.presentCutoff} / ${timing.lateCutoff}) — edit below to override`;
      notice.style.background = "#fff";
      notice.style.color = "var(--ink)";
      if(revertBtn) revertBtn.style.display = "none";
    } else {
      notice.textContent = `Custom class timing active for ${ctx.name} — overrides global`;
      notice.style.background = "var(--ok)";
      notice.style.color = "#fff";
      if(revertBtn) revertBtn.style.display = "inline-block";
    }
  } else if(ctx.type === "batch"){
    if(badge){
      badge.textContent = `BATCH · ${ctx.name.toUpperCase()}`;
      badge.style.background = timing.isInherited ? "" : "var(--ok)";
      badge.style.color = timing.isInherited ? "" : "#fff";
      badge.style.display = "inline-block";
    }
    if(timing.isInherited){
      const source = timing.level === "class" ? "class" : "global";
      notice.textContent = `Inheriting ${source} timings (${timing.presentCutoff} / ${timing.lateCutoff}) — edit below to override`;
      notice.style.background = "#fff";
      notice.style.color = "var(--ink)";
      if(revertBtn) revertBtn.style.display = "none";
    } else {
      notice.textContent = `Custom batch timing active for ${ctx.name} — overrides class and global`;
      notice.style.background = "var(--ok)";
      notice.style.color = "#fff";
      if(revertBtn) revertBtn.style.display = "inline-block";
    }
  }
}
async function persistCalendar(){
  try{
    await api("/api/settings",{method:"POST",body:JSON.stringify({
      holidays: holidaysToBackend(), overrides: overridesToBackend(), workingDays: Settings.workingDays,
      classSchedules: classSchedulesToBackend(), batchSchedules: batchSchedulesToBackend()
    })});
    cacheSave();
    return true;
  }catch(e){ await glassAlert("Failed to save calendar: "+e.message); }
  return false;
}
function renderHolidays(){
  const hBadge = $("holidayCountBadge"); if(hBadge) hBadge.textContent = Holidays.length;
  if(!holidayBody) return;
  if(!Holidays.length){
    holidayBody.innerHTML=`<tr><td colspan="5"><div class="empty" style="padding:14px;border:1px dashed var(--line);background:var(--paper);border-radius:2px;font-size:11px;color:var(--ink-2)"><b>No holidays or vacations configured.</b>Click + Add holiday to schedule.</div></td></tr>`;
    return;
  }
  holidayBody.innerHTML=Holidays.map(h=>`<tr><td>${esc(h.name)}</td><td>${esc(h.start)}</td><td>${esc(h.end)}</td><td><span class="badge">${esc(h.type)}</span></td><td style="text-align:right"><div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn" data-edit-holiday="${esc(h.start)}" style="padding:2px 6px;font-size:9px">Edit</button><button class="btn danger icon-del" data-del-holiday="${esc(h.start)}" aria-label="Remove holiday">${TRASH_ICON}</button></div></td></tr>`).join("");
}
function renderOverrides(){
  const oBadge = $("overrideCountBadge"); if(oBadge) oBadge.textContent = Overrides.length;
  if(!overrideBody) return;
  if(!Overrides.length){
    overrideBody.innerHTML=`<tr><td colspan="4"><div class="empty" style="padding:14px;border:1px dashed var(--line);background:var(--paper);border-radius:2px;font-size:11px;color:var(--ink-2)"><b>No date overrides configured.</b>Click + Add override for single-day exceptions.</div></td></tr>`;
    return;
  }
  overrideBody.innerHTML=Overrides.map(o=>`<tr><td>${esc(o.date)}</td><td>${o.isWorking?"Working":"Holiday"}</td><td>${esc(o.note)}</td><td style="text-align:right"><div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn" data-edit-override="${esc(o.date)}" style="padding:2px 6px;font-size:9px">Edit</button><button class="btn danger icon-del" data-del-override="${esc(o.date)}" aria-label="Remove override">${TRASH_ICON}</button></div></td></tr>`).join("");
}
function renderWeekly(){
  populateScheduleSelector();
  renderScheduleTiming();
}
function renderCalendarMonth(){
  if(!calendarGrid) return;
  const y=calendarMonth.getFullYear(), m=calendarMonth.getMonth();
  calMonthLabel.textContent=calendarMonth.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  const ctx = getScheduleContext();
  const monthCtxPill = $("calMonthContextLabel");
  if(monthCtxPill){
    if(ctx.type === "global"){
      monthCtxPill.textContent = "Global";
      monthCtxPill.style.background = "";
      monthCtxPill.style.color = "";
    } else if(ctx.type === "class"){
      monthCtxPill.textContent = `Class: ${ctx.name}`;
      monthCtxPill.style.background = "var(--ink)";
      monthCtxPill.style.color = "#F2F3F6";
    } else if(ctx.type === "batch"){
      monthCtxPill.textContent = `Batch: ${ctx.name}`;
      monthCtxPill.style.background = "var(--ink)";
      monthCtxPill.style.color = "#F2F3F6";
    }
  }
  const first=new Date(y,m,1).getDay(), last=new Date(y,m+1,0).getDate();
  // Phase 1: weekday headers are the recurring-template editor (same source as renderWeekly)
  let tplWd = Settings.workingDays;
  if(ctx.type === "class") tplWd = getWorkingDaysForClass(ctx.name);
  else if(ctx.type === "batch") tplWd = getWorkingDaysForBatch(ctx.name);
  const tplNames=['SUN','MON','TUE','WED','THU','FRI','SAT'];
  let html=tplNames.map((d,idx)=>{
    const on = asBool(tplWd[idx] ?? tplWd[String(idx)]);
    const cls = on ? "weekly-day-card working" : "weekly-day-card off";
    const status = on ? "WORKING" : "OFF";
    return `<div class="${cls}" data-day="${idx}" role="button" tabindex="0" title="Toggle ${d} in recurring template"><div class="w-name">${d}</div><div class="w-status">${status}</div></div>`;
  }).join("");
  let tplLegend=$("calTemplateLegend");
  if(!tplLegend && calendarGrid.parentNode){
    tplLegend=document.createElement("div");
    tplLegend.id="calTemplateLegend";
    tplLegend.style.cssText="font-size:10px;letter-spacing:0.04em;color:var(--ink-2);margin:0 0 6px;";
    calendarGrid.parentNode.insertBefore(tplLegend, calendarGrid);
  }
  if(tplLegend) tplLegend.textContent="Headers edit the recurring weekly template \u00B7 cells show resolved days including overrides and holidays.";
  for(let i=0;i<first;i++) html+=`<div class="calendar-cell" style="background:#F2F3F6"></div>`;
  for(let d=1;d<=last;d++){
    const iso=toLocalISO(new Date(y,m,d));
    const hol=isHoliday(iso), ov=getOverride(iso), todayCls=iso===todayISO()?" today":"";
    const working = isWorkingDayForContext(iso, ctx);
    const typeCls = ov ? "override" : (working ? "working" : "non-working");
    const tag = ov ? esc(ov.note) : (hol ? esc(hol.name) : (working ? "WORKING" : "NON-WORKING"));
    html+=`<div class="calendar-cell ${typeCls}${todayCls}" data-date="${iso}"><div class="day">${d}</div><div class="tag">${tag}</div></div>`;
  }
  calendarGrid.innerHTML=html;
  renderRangeIndex(y);
}
/* Compact range index: read-only count + jump list for the displayed
   year. All editing stays in the day sheet; no new data path. */
let calRangeIndexOpen=false;
function rangesInYear(y){
  const lo=y+"-01-01", hi=y+"-12-31";
  return Holidays.filter(h=>h.start<=hi&&h.end>=lo);
}
function renderRangeIndex(y){
  let wrap=$("calRangeIndex");
  if(!wrap && calendarGrid.parentNode){
    wrap=document.createElement("div");
    wrap.id="calRangeIndex";
    wrap.style.cssText="margin:8px 0 0;font-size:10px;letter-spacing:0.04em;color:var(--ink-2);";
    calendarGrid.parentNode.insertBefore(wrap, calendarGrid.nextSibling);
  }
  if(!wrap) return;
  const rows=rangesInYear(y);
  wrap.innerHTML=
    `<button class="btn" id="calRangeIndexToggle" style="font-size:10px;">Holiday ranges in ${y} (${rows.length})</button>`+
    `<div id="calRangeIndexRows" style="display:${calRangeIndexOpen?"block":"none"};margin-top:4px;">`+
    (rows.length?rows.map(h=>`<div><button class="btn" data-range-start="${esc(h.start)}" style="font-size:10px;">${esc(h.name)} \u00B7 ${_fmtShort(h.start)} \u2192 ${_fmtShort(h.end)} \u00B7 ${esc(h.type)}</button></div>`).join(""):`<div>None configured — add ranges from any day sheet.</div>`)+
    `</div>`;
  $("calRangeIndexToggle").onclick=()=>{ calRangeIndexOpen=!calRangeIndexOpen; renderRangeIndex(y); };
  wrap.querySelectorAll("[data-range-start]").forEach(b=>{ b.onclick=()=>openDaySheet(b.dataset.rangeStart); });
}
function renderClasses(){
  if(!classBody) return;
  if(!Classes.length){ classBody.innerHTML=`<tr><td colspan="3"><div class="empty" style="padding:14px;font-size:10px"><b>No classes configured</b></div></td></tr>`; return; }
  classBody.innerHTML=Classes.map(c=>{
    const n=Students.filter(s=>s.class===c).length;
    return `<tr><td>${esc(c)}</td><td style="text-align:center">${n}</td><td style="text-align:right"><div style="display:flex;gap:4px;justify-content:flex-end"><button class="btn danger icon-del" data-del-class="${esc(c)}" aria-label="Remove class">${TRASH_ICON}</button><button class="btn" data-sched-class="${esc(c)}" style="padding:1px 6px;font-size:9px">Schedule →</button></div></td></tr>`;
  }).join("");
}
function renderBatches(){
  const tbody = $("batchBody");
  if(!tbody) return;
  const allBatches=[...new Set([...(Batches||[]), ...Students.map(s=>s.batch).filter(Boolean)])].sort();
  if(!allBatches.length){
    tbody.innerHTML=`<tr><td colspan="3"><div class="empty"><b>No batches configured</b></div></td></tr>`;
    return;
  }
  tbody.innerHTML=allBatches.map(b=>{
    const n=Students.filter(s=>s.batch===b).length;
    return `<tr><td>${esc(b)}</td><td>${n}</td><td><button class="btn" data-sched-batch="${esc(b)}" style="padding:1px 6px;font-size:10px">Schedule →</button></td></tr>`;
  }).join("");
}
function formatAuditDetails(raw, action){
  if(!raw) return "—";
  const text = String(raw).trim();
  if(!text) return "—";

  // Parse JSON objects or extract key settings if JSON was serialized
  let obj = null;
  if((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))){
    try {
      obj = JSON.parse(text);
    } catch(e) {
      obj = null;
    }
  }

  if(obj && typeof obj === "object" && !Array.isArray(obj)){
    const labelMap = {
      schoolName: "School",
      region: "Region",
      academicYear: "Academic year",
      schoolOpeningDate: "Opening date",
      attendanceStartDate: "Attendance start",
      presentCutoff: "Present cutoff",
      lateCutoff: "Late cutoff",
      lateThreshold: "Late cutoff",
      minPercent: "Min attendance"
    };
    const parts = [];
    const priorityKeys = [
      "schoolName", "region", "academicYear", "schoolOpeningDate",
      "presentCutoff", "lateCutoff"
    ];
    for(const k of priorityKeys){
      if(obj[k] !== undefined && obj[k] !== null && obj[k] !== ""){
        parts.push(`${labelMap[k]}: ${obj[k]}`);
      }
    }
    // Include other simple settings
    for(const [k, v] of Object.entries(obj)){
      if(!priorityKeys.includes(k) && labelMap[k] && v !== undefined && v !== null && v !== "" && typeof v !== "object"){
        const val = (k === "minPercent") ? `${v}%` : v;
        parts.push(`${labelMap[k]}: ${val}`);
      }
    }
    if(parts.length > 0){
      return parts.join(" · ");
    }
  }

  // Handle truncated JSON strings (e.g. [:500] from backend)
  if(text.startsWith("{") && (text.includes('"schoolName"') || text.includes('"presentCutoff"'))){
    const labelMap = {
      schoolName: "School",
      region: "Region",
      academicYear: "Academic year",
      schoolOpeningDate: "Opening date",
      presentCutoff: "Present cutoff",
      lateCutoff: "Late cutoff"
    };
    const parts = [];
    for(const [k, label] of Object.entries(labelMap)){
      const re = new RegExp(`"${k}"\\s*:\\s*"([^"\\\\]*)"`);
      const m = text.match(re);
      if(m && m[1]){
        parts.push(`${label}: ${m[1]}`);
      }
    }
    if(parts.length > 0){
      return parts.join(" · ");
    }
  }

  return text;
}

function renderAudit(){
  if(!Audit.length){ auditBody.innerHTML=`<tr><td colspan="4"><div class="empty"><b>No audit history</b>Changes appear here.</div></td></tr>`; return; }
  auditBody.innerHTML=Audit.map(a=>`<tr><td>${esc(a.time)}</td><td>${esc(a.action)}</td><td>${esc(formatAuditDetails(a.details, a.action))}</td><td>${esc(a.by)}</td></tr>`).join("");
}
function renderAll(){
  renderClassFilters();
  renderStudentList();
  renderWeekly();
  renderHolidays();
  renderOverrides();
  renderCalendarMonth();
  renderClasses();
  renderBatches();
  renderAudit();
  if(currentTab==="attendance" || currentTab==="today" || currentTab==="reports") renderAttendance();
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
  try{ enhancePhotoField($("nsPhoto")); }catch(e){}
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
      <div class="form-field full"><label>Photo (max 2MB)</label><input type="file" id="edPhoto" accept="image/*"></div>
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
        await glassAlert("Saved.");
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
  try{
    enhancePhotoField($("edPhoto"));
    const _ec=$("edClearPhoto"); if(_ec) _ec.addEventListener('click',()=>{ const _i=$("edPhoto"); if(_i&&_i._photoRefresh) setTimeout(_i._photoRefresh,0); });
  }catch(e){}
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
/* Shared outline trash glyph (stroke=currentColor → ink-aware by construction) */
const TRASH_ICON='<svg class="del-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><rect x="6" y="7" width="12" height="13" rx="1.5"/><path d="M10 11v6M14 11v6"/></svg>';
async function deleteStudent(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  if(!(await glassConfirm("Deactivate "+s.name+"? Their fingerprint slot is freed and roll is released. History is kept.",{title:"Deactivate student",okText:"Deactivate",danger:true}))) return;
  pauseSensorScan();
  try{ await api("/api/students/"+id,{method:"DELETE"}); await loadAll(); renderStudentDetail(-1); }catch(e){ await glassAlert("Failed: "+e.message); }
  finally{ resumeSensorScan(); }
}
async function reactivateStudent(id){
  const s=Students.find(x=>x.id===id); if(!s) return;
  if(!(await glassConfirm("Re-activate "+s.name+"?",{title:"Re-activate student",okText:"Re-activate"}))) return;
  try{ await api("/api/students/"+id,{method:"PATCH",body:JSON.stringify({active:1})}); await loadAll(); selectStudent(id); }catch(e){ await glassAlert("Failed: "+e.message); }
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
function printHTML(htmlContent, docTitle){
  const w=window.open('','_blank'); if(!w) return;
  const t = docTitle ? esc(docTitle) : "Report";
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${t}</title><style>
    @page {
      size: auto;
      margin: 12mm 15mm;
    }
    *, *:before, *:after {
      box-sizing: border-box;
    }
    html, body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #181A20;
      background: #F2F3F6;
      padding: 24px;
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.4;
    }
    .report-header {
      border-bottom: 2px solid #181A20;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    h1 {
      font-family: "Newsreader", Georgia, serif;
      font-size: 20px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 6px 0;
      color: #181A20;
    }
    .report-subtitle {
      font-size: 11px;
      letter-spacing: 0.03em;
      color: #6B6B6B;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .report-meta-tag {
      display: inline-block;
      padding: 2px 7px;
      background: #F6F4EF;
      border: 1px solid #E9E6E0;
      border-radius: 2px;
      font-size: 10px;
      font-weight: 500;
      color: #181A20;
    }
    .stats-row {
      display: flex !important;
      flex-wrap: wrap !important;
      gap: 8px !important;
      margin: 14px 0 20px 0 !important;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .stat {
      border: 1px solid #E9E6E0 !important;
      background: #FCFBF7 !important;
      padding: 8px 12px !important;
      min-width: 85px !important;
      flex: 1 1 0% !important;
      box-sizing: border-box !important;
    }
    .stat b {
      display: block !important;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
      font-size: 16px !important;
      font-weight: 600 !important;
      color: #181A20 !important;
      letter-spacing: -0.02em !important;
      line-height: 1.2 !important;
    }
    .stat label {
      display: block !important;
      font-size: 8.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.12em !important;
      text-transform: uppercase !important;
      color: #6B6B6B !important;
      margin-top: 4px !important;
      line-height: 1.2 !important;
    }
    .table-wrap {
      border: 1px solid #E9E6E0 !important;
      background: #F2F3F6 !important;
      margin: 14px 0 20px 0 !important;
      overflow: visible !important;
      contain: none !important;
    }
    .table-scroll {
      max-height: none !important;
      overflow: visible !important;
    }
    table {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      border-collapse: collapse !important;
      font-size: 10.5px !important;
      table-layout: auto !important;
    }
    thead {
      display: table-header-group !important;
    }
    tr {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    th {
      font-size: 8.5px !important;
      font-weight: 600 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.12em !important;
      color: #6B6B6B !important;
      text-align: left !important;
      padding: 8px 10px !important;
      border-bottom: 1.5px solid #181A20 !important;
      background: #F6F4EF !important;
      white-space: nowrap !important;
    }
    td {
      padding: 7px 10px !important;
      border-bottom: 1px solid #E9E6E0 !important;
      color: #181A20 !important;
      vertical-align: middle !important;
      font-variant-numeric: tabular-nums !important;
      white-space: normal !important;
      word-break: break-word !important;
      max-width: none !important;
    }
    tr:nth-child(even) td {
      background: #FAFAF7 !important;
    }
    .badge {
      display: inline-block !important;
      font-size: 8.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.08em !important;
      text-transform: uppercase !important;
      padding: 2px 6px !important;
      border: 1px solid #E9E6E0 !important;
      background: #F2F3F6 !important;
      border-radius: 2px !important;
      white-space: nowrap !important;
    }
    .badge.present {
      color: #2F5D34 !important;
      border-color: #2F5D34 !important;
      background: #F3F8F4 !important;
    }
    .badge.late {
      color: #8A6A2A !important;
      border-color: #C7B07A !important;
      background: #FAF7F0 !important;
    }
    .badge.absent {
      color: #8A3A3A !important;
      border-color: #8A3A3A !important;
      background: #FDF4F4 !important;
    }
    .badge.not-scheduled {
      color: #6B6B6B !important;
      border-color: #E9E6E0 !important;
      background: #F6F4EF !important;
    }
    .badge.duplicate {
      color: #6B6B6B !important;
      border-color: #E9E6E0 !important;
    }
    .report-section {
      margin-top: 22px !important;
      page-break-inside: auto !important;
      break-inside: auto !important;
    }
    .section-title {
      font-family: "Newsreader", Georgia, serif !important;
      font-size: 13px !important;
      font-weight: 600 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.08em !important;
      margin-bottom: 8px !important;
      color: #181A20 !important;
      border-bottom: 1px solid #E9E6E0 !important;
      padding-bottom: 4px !important;
    }
    .detail-card {
      border: 1px solid #E9E6E0 !important;
      background: #F2F3F6 !important;
      padding: 16px !important;
      margin: 12px 0 !important;
      display: flex !important;
      gap: 20px !important;
    }
    .detail-photo {
      width: 140px !important;
      height: 180px !important;
      border: 1px solid #181A20 !important;
      background: #F6F4EF !important;
      overflow: hidden !important;
      flex-shrink: 0 !important;
    }
    .detail-photo img {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
    }
    .detail-photo-fallback {
      width: 100% !important;
      height: 100% !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-family: "Newsreader", Georgia, serif !important;
      font-size: 54px !important;
      color: #181A20 !important;
    }
    .detail-grid {
      display: grid !important;
      grid-template-columns: repeat(2, 1fr) !important;
      gap: 10px !important;
      flex: 1 !important;
    }
    .detail-field label {
      display: block !important;
      font-size: 8.5px !important;
      font-weight: 600 !important;
      letter-spacing: 0.12em !important;
      text-transform: uppercase !important;
      color: #6B6B6B !important;
      margin-bottom: 2px !important;
    }
    .detail-field span {
      display: block !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      color: #181A20 !important;
    }
    .empty {
      padding: 16px !important;
      text-align: center !important;
      font-size: 10px !important;
      color: #6B6B6B !important;
    }
    button, .btn {
      display: none !important;
    }
    @media print {
      body {
        padding: 0 !important;
        max-width: none !important;
      }
      .no-print {
        display: none !important;
      }
    }
  </style></head><body>${htmlContent}<script>window.addEventListener('DOMContentLoaded',()=>{ setTimeout(()=>{ try{ window.print(); }catch(e){} }, 100); }); if(document.readyState==='complete'){ setTimeout(()=>{ try{ window.print(); }catch(e){} }, 100); }<\/script></body></html>`);
  w.document.close();
}

// ---- events ----
async function openAdmin(){
  // require admin auth when PIN configured — use safe header-only check that does not need sensor
  try{
    await api("/api/audit", {method:"GET"});
  }catch(e){
    if(e.status===401) return;
    // for other errors (e.g., network when PIN empty), still allow open to preserve offline admin when no PIN
    const pin = (()=>{ try{ return sessionStorage.getItem("atl_admin_pin") || ""; }catch(_e){ return ""; }})();
    if(!pin){
    } else {
      return;
    }
  }
  const titles={
    students: "Students",
    attendance: "Today — Attendance",
    today: "Today — Attendance",
    reports: "Attendance",
    setup: "Setup — School Configuration & Schedule",
    calendar: "Setup — School Configuration & Schedule",
    settings: "Setup — School Configuration & Schedule",
    backup: "Backup — Audit"
  };
  if(adminTitle) adminTitle.textContent=titles[currentTab]||"Admin";
  // show loading briefly while data refreshes
  let activeTabName = currentTab;
  if(activeTabName === "calendar" || activeTabName === "settings") activeTabName = "setup";
  if(activeTabName === "today" || activeTabName === "reports") activeTabName = "attendance";
  const pane=document.getElementById("pane-"+activeTabName);
  if(pane) pane.style.opacity="0.6";
  adminLayer.classList.add("open"); renderAll();
  setTimeout(()=>{ if(pane) pane.style.opacity=""; updateTabs(); }, 80);
}
function updateTabs(){
  document.querySelectorAll(".admin-pane").forEach(p=>p.classList.add("hidden"));
  let tab = currentTab;
  if(tab === "calendar" || tab === "settings") tab = "setup";
  if(tab === "today" || tab === "reports") tab = "attendance";
  const pane = document.getElementById("pane-" + tab);
  if(pane){ pane.classList.remove("hidden"); pane.style.opacity = ""; }
  const pToday = document.getElementById("pane-today");
  const pReports = document.getElementById("pane-reports");
  if(tab === "attendance"){
    if(pToday) pToday.classList.remove("hidden");
    if(pReports) pReports.classList.remove("hidden");
  }
  const pCal = document.getElementById("pane-calendar");
  const pSet = document.getElementById("pane-settings");
  if(tab === "setup"){
    if(pCal) pCal.classList.remove("hidden");
    if(pSet) pSet.classList.remove("hidden");
  }
  const titles = {
    students: "Students",
    attendance: "Today — Attendance",
    today: "Today — Attendance",
    reports: "Attendance",
    setup: "Setup — School Configuration & Schedule",
    calendar: "Setup — School Configuration & Schedule",
    settings: "Setup — School Configuration & Schedule",
    backup: "Backup — Audit"
  };
  if(adminTitle) adminTitle.textContent = titles[currentTab] || "Admin";
  if(tab === "attendance" || tab === "today" || tab === "reports"){
    if(currentTab === "attendance" && attDatePreset && !attDatePreset.value) attDatePreset.value = "today";
    renderAttendance();
  }
  if(tab === "setup"){
    populateScheduleSelector();
    renderClasses();
    renderBatches();
    renderWeekly();
    renderHolidays();
    renderOverrides();
    renderCalendarMonth();
  }
  if(tab === "backup"){ renderAudit(); loadBackupManagerStatus(); }
}
document.getElementById("openAdminBtn").onclick=openAdmin;
const _frontEnrollBtn=document.getElementById("openEnrollBtn"); if(_frontEnrollBtn) _frontEnrollBtn.onclick=openNewStudent;
const _newToolbarBtn=document.getElementById("newStudentToolbarBtn"); if(_newToolbarBtn) _newToolbarBtn.onclick=openNewStudent;
document.getElementById("adminClose").onclick=()=>{
  finishEnrollUi();
  adminLayer.classList.remove("open");
  resumeSensorScan();
};
// Ink toggle: white ⇄ black interface text only (nothing else changes)
(function(){
  const b=document.getElementById("inkToggleBtn"); if(!b) return;
  const apply=v=>{ const el=document.documentElement; el.classList.add("ink-switching"); el.dataset.ink=v; try{localStorage.setItem("atl_ink",v);}catch(e){} b.innerHTML=v==="dark"?'<span class="ink-moon"></span>':"\u2600"; clearTimeout(apply._t); apply._t=setTimeout(()=>el.classList.remove("ink-switching"), 220); };
  let cur="white"; try{cur=localStorage.getItem("atl_ink")||"white";}catch(e){}
  apply(cur==="dark"?"dark":"white");
  b.onclick=()=>apply(document.documentElement.dataset.ink==="dark"?"white":"dark");
})();
adminNav.onclick=(e)=>{
  const btn = e.target.closest("button");
  if(!btn) return;
  [...adminNav.children].forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  currentTab = btn.dataset.tab;
  if(currentTab === "calendar" || currentTab === "settings"){
    const setupBtn = adminNav.querySelector("button[data-tab='setup']");
    if(setupBtn) setupBtn.classList.add("active");
  }
  if(currentTab === "today" || currentTab === "reports"){
    const attBtn = adminNav.querySelector("button[data-tab='attendance']");
    if(attBtn) attBtn.classList.add("active");
  }
  if(currentTab === "attendance" || currentTab === "today"){
    if(attDatePreset) attDatePreset.value = "today";
  }
  updateTabs();
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
    const file=e.target.files?.[0]; if(!file) return;
    fileInput.value='';
    const prev=impBtn.textContent; impBtn.textContent='Importing…'; impBtn.disabled=true;
    try{
      const fd=new FormData(); fd.append('file',file);
      const r=await api('/api/students/import',{method:'POST',body:fd});
      await glassAlert(`Import complete: ${r.created||0} created, ${r.updated||0} updated${r.errors?.length?` (${r.errors.length} errors)`:''}`);
      await loadAll();
    }catch(err){ await glassAlert('Import failed: '+(err.message||err)); }
    finally{ impBtn.textContent=prev; impBtn.disabled=false; }
  };
})();
// Unified Attendance toolbar actions & event listeners
const handleAttendancePrint = () => {
  const school = Settings.schoolName || "ATL Model School";
  const preset = attDatePreset ? attDatePreset.value : "today";
  const today = todayISO();
  let from = today, to = today;
  if(preset === "today"){ from = today; to = today; }
  else if(preset === "yesterday"){ const d = new Date(); d.setDate(d.getDate()-1); from = toLocalISO(d); to = from; }
  else if(preset === "custom_day"){ from = (attSingleDate && attSingleDate.value) || today; to = from; }
  else if(preset === "custom_range"){ from = (attFromDate && attFromDate.value) || today; to = (attToDate && attToDate.value) || today; }
  else if(preset === "week"){ const d = new Date(); d.setDate(d.getDate()-6); from = toLocalISO(d); to = today; }
  else if(preset === "month"){ const d = new Date(); d.setDate(1); from = toLocalISO(d); to = today; }
  else if(preset === "academic"){ from = Settings.startDate || Settings.schoolOpeningDate || "2026-06-15"; to = Settings.endDate || today; }

  const isSingleDay = (from === to);
  const cf = attClassFilter ? attClassFilter.value : "";
  const bf = attBatchFilter ? attBatchFilter.value : "";
  const sid = (attStudentFilter && attStudentFilter.value) ? parseInt(attStudentFilter.value) : null;
  const stu = sid ? Students.find(s => s.id === sid) : null;

  let scopeLabel = "Entire School";
  if(stu) scopeLabel = `Student: ${stu.name} (Roll: ${stu.roll||"—"}, Class: ${stu.class||"—"}${stu.batch ? " · Batch: " + stu.batch : ""})`;
  else if(cf && bf) scopeLabel = `Class: ${cf} · Batch: ${bf}`;
  else if(cf) scopeLabel = `Class: ${cf}`;
  else if(bf) scopeLabel = `Batch: ${bf}`;

  let dateDesc = "";
  if(isSingleDay){
    dateDesc = (from === today) ? `Today — ${fmtDate(from)} (${from})` : `Date: ${fmtDate(from)} (${from})`;
  } else {
    let dayCount = 1;
    try {
      const d1 = new Date(from+"T00:00:00"), d2 = new Date(to+"T00:00:00");
      dayCount = Math.round((d2 - d1)/(1000*60*60*24)) + 1;
    } catch(e){}
    dateDesc = `Date Range: ${fmtDate(from)} to ${fmtDate(to)} (${from} → ${to}, ${dayCount} days)`;
  }

  const generated = new Date().toLocaleString();
  const titleText = stu ? `${school} — Student Attendance (${stu.name})` : (isSingleDay ? `${school} — Attendance (${from})` : `${school} — Attendance Report`);

  const hdr = `
    <div class="report-header">
      <h1>${esc(titleText)}</h1>
      <div class="report-subtitle">
        <div><strong>${esc(dateDesc)}</strong> &nbsp;·&nbsp; <span>${esc(scopeLabel)}</span></div>
        <div><span class="report-meta-tag">Generated: ${esc(generated)}</span></div>
      </div>
    </div>`;

  const stats = (attStats && attStats.children.length) ? `<div class="stats-row">${attStats.innerHTML}</div>` : "";
  const mainTbl = document.querySelector('#pane-attendance .table-wrap:first-of-type') || document.querySelector('#pane-today .table-wrap:first-of-type');
  const tblHtml = mainTbl ? mainTbl.outerHTML : "";

  let unknownsHtml = "";
  const unkRows = attUnknownBody ? attUnknownBody.querySelectorAll("tr") : [];
  const hasUnks = unkRows.length && !attUnknownBody.querySelector(".empty") && !stu;
  if(hasUnks){
    unknownsHtml = `
      <div class="report-section">
        <div class="section-title">Unknown Scan Attempts (${unkRows.length})</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Fingerprint</th><th>Note</th></tr></thead>
            <tbody>
              ${attUnknownBody.innerHTML}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  printHTML(hdr + stats + tblHtml + unknownsHtml, `${school} — Attendance (${from}${from!==to?" to "+to:""})`);
};

const handleAttendanceExport = async () => {
  const preset = attDatePreset ? attDatePreset.value : "today";
  const today = todayISO();
  let from = today, to = today;
  if(preset === "today"){ from = today; to = today; }
  else if(preset === "yesterday"){ const d = new Date(); d.setDate(d.getDate()-1); from = toLocalISO(d); to = from; }
  else if(preset === "custom_day"){ from = (attSingleDate && attSingleDate.value) || today; to = from; }
  else if(preset === "custom_range"){ from = (attFromDate && attFromDate.value) || today; to = (attToDate && attToDate.value) || today; }
  else if(preset === "week"){ const d = new Date(); d.setDate(d.getDate()-6); from = toLocalISO(d); to = today; }
  else if(preset === "month"){ const d = new Date(); d.setDate(1); from = toLocalISO(d); to = today; }
  else if(preset === "academic"){ from = Settings.startDate || Settings.schoolOpeningDate || "2026-06-15"; to = Settings.endDate || today; }

  const isSingleDay = (from === to);
  const cf = attClassFilter ? attClassFilter.value : "";
  const bf = attBatchFilter ? attBatchFilter.value : "";
  const sf = attStatusFilter ? attStatusFilter.value : "";
  const sid = (attStudentFilter && attStudentFilter.value) ? parseInt(attStudentFilter.value) : null;
  const stu = sid ? Students.find(s => s.id === sid) : null;

  // Prefer backend CSV streaming export for all date ranges
  try {
    let url = "/api/export/csv?type=attendance";
    if(isSingleDay){
      url += "&date=" + encodeURIComponent(from);
    } else {
      url += "&start=" + encodeURIComponent(from) + "&end=" + encodeURIComponent(to);
    }
    if(cf) url += "&class=" + encodeURIComponent(cf);
    if(bf) url += "&batch=" + encodeURIComponent(bf);
    if(sid) url += "&studentId=" + encodeURIComponent(sid);
    if(sf && sf !== "All" && sf !== "Unknown"){
      url += "&status=" + encodeURIComponent(sf.toUpperCase().replace(" ","_"));
    }

    const pinHeaders = {};
    try { const p = sessionStorage.getItem("atl_admin_pin"); if(p) pinHeaders["X-Admin-Pin"] = p; }catch(_e){}

    const r = await fetch(url, {cache: "no-store", headers: pinHeaders});
    if(r.ok){
      const blob = await r.blob();
      const url2 = URL.createObjectURL(blob), a = document.createElement('a');
      let baseName = stu ? `attendance_${stu.roll || stu.name}` : `attendance_${from}${from!==to ? "_to_"+to : ""}${cf ? "_"+cf : ""}${bf ? "_"+bf : ""}`;
      if(stu && from !== to) baseName += `_${from}_to_${to}`;
      a.href = url2;
      a.download = (baseName + ".csv").replace(/[\s\/\\:]+/g, "_");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url2), 1500);
      return;
    }
  } catch(e){}

  // Fallback / offline frontend CSV export
  const rows = [["Date", "Time", "Student", "Roll", "Class", "Batch", "Status", "Fingerprint"]];
  const trs = attTableBody ? attTableBody.querySelectorAll("tr") : [];
  trs.forEach(tr => {
    if(tr.querySelector(".empty")) return;
    const tds = [...tr.querySelectorAll("td")].map(td => {
      const clone = td.cloneNode(true);
      clone.querySelectorAll("button").forEach(b => b.remove());
      return clone.textContent.trim().replace(/\s+/g, " ");
    });
    const trSid = tr.getAttribute("data-student");
    const trStu = trSid ? Students.find(s => s.id === parseInt(trSid)) : null;
    if(isSingleDay && tds.length >= 6){
      rows.push([from, tds[0], tds[1], tds[2], tds[3], trStu ? (trStu.batch||"") : "", tds[4], tds[5]]);
    } else if(tds.length >= 7){
      rows.push([tds[0], tds[1], tds[2], tds[3], tds[4], trStu ? (trStu.batch||"") : "", tds[5], tds[6]]);
    }
  });
  const filename = `attendance-${from}${from!==to ? "-to-"+to : ""}${cf?"-"+cf:""}.csv`;
  exportCSV(rows, filename);
};

const handleAttendanceRefresh = async () => {
  const btn = attRefreshBtn || $("todayRefreshBtn");
  if(btn){ btn.disabled = true; }
  try {
    await loadTodayAttendance();
    await renderAttendance();
  } finally {
    if(btn){ btn.disabled = false; }
  }
};

if(attRefreshBtn) attRefreshBtn.onclick = handleAttendanceRefresh;
if(attPrintBtn) attPrintBtn.onclick = handleAttendancePrint;
if(attExportBtn) attExportBtn.onclick = handleAttendanceExport;
if(attApplyBtn) attApplyBtn.onclick = renderAttendance;

// Connect legacy button aliases
if($("todayRefreshBtn")) $("todayRefreshBtn").onclick = handleAttendanceRefresh;
if($("todayPrintBtn")) $("todayPrintBtn").onclick = handleAttendancePrint;
if($("todayExportBtn")) $("todayExportBtn").onclick = handleAttendanceExport;
if($("reportApplyBtn")) $("reportApplyBtn").onclick = renderAttendance;
if($("reportPrintBtn")) $("reportPrintBtn").onclick = handleAttendancePrint;
if($("reportCsvBtn")) $("reportCsvBtn").onclick = handleAttendanceExport;

if(attDatePreset) attDatePreset.addEventListener("change", () => {
  const v = attDatePreset.value;
  const isCustom = (v === "custom_day" || v === "custom_range");
  if(attSingleDate) attSingleDate.style.display = (v === "custom_day") ? "" : "none";
  if(attFromDate) attFromDate.style.display = (v === "custom_range") ? "" : "none";
  if(attToDate) attToDate.style.display = (v === "custom_range") ? "" : "none";
  if(attApplyBtn) attApplyBtn.style.display = isCustom ? "" : "none";
  renderAttendance();
});
if(attSingleDate) attSingleDate.addEventListener("change", renderAttendance);
if(attFromDate) attFromDate.addEventListener("change", renderAttendance);
if(attToDate) attToDate.addEventListener("change", renderAttendance);
if(attClassFilter) attClassFilter.addEventListener("change", () => {
  populateAttStudents();
  renderAttendance();
});
if(attBatchFilter) attBatchFilter.addEventListener("change", () => {
  populateAttStudents();
  renderAttendance();
});
if(attStudentFilter) attStudentFilter.addEventListener("change", renderAttendance);
if(attStatusFilter) attStatusFilter.addEventListener("change", renderAttendance);
if(attSort) attSort.addEventListener("change", renderAttendance);
/* Section Clear: full attendance reset — preset Today, dates emptied,
   year override dropped, all filters to All, shell shut, table reloaded */
function clearAttendanceSection(){
  try{ closeDtPops(); }catch(e){ console.error(e); }
  try{ attAcadFrom=attAcadTo=null; }catch(e){ console.error(e); }
  try{ if(attSingleDate) attSingleDate.value=""; }catch(e){ console.error(e); }
  try{ if(attFromDate) attFromDate.value=""; }catch(e){ console.error(e); }
  try{ if(attToDate) attToDate.value=""; }catch(e){ console.error(e); }
  ["attClassFilter","attBatchFilter","attStudentFilter","attStatusFilter"].forEach(id=>{
    try{ const el=$(id); if(el) el.value=""; }catch(e){ console.error(e); }
  });
  try{ if(attSort) attSort.value="time_desc"; }catch(e){ console.error(e); }
  try{ populateAttStudents(); }catch(e){ console.error(e); }
  try{ _dtCommitPreset("today"); }catch(e){ console.error(e); }
  try{ renderAttendance(); }catch(e){ console.error(e); }
}

$("calPrevBtn").onclick=()=>{ calendarMonth.setMonth(calendarMonth.getMonth()-1); renderCalendarMonth(); };
$("calNextBtn").onclick=()=>{ calendarMonth.setMonth(calendarMonth.getMonth()+1); renderCalendarMonth(); };
if($("calTodayBtn")) $("calTodayBtn").onclick=()=>{ calendarMonth=new Date(); renderCalendarMonth(); };
/* Day sheet: resolution read ONLY from the shared truth functions —
   override → holiday (exam = working) → active-context template.
   Overrides and holidays are global; only the template follows context. */
function daySheetSource(iso, ctx){
  const ov=getOverride(iso);
  if(ov) return {badge:ov.isWorking?"WORKING":"NON-WORKING",
    text:"Date override (global) — "+(ov.isWorking?"working":"non-working")+(ov.note?": "+ov.note:"")};
  const hol=isHoliday(iso);
  if(hol){
    const type=String(hol.type||"holiday").toLowerCase();
    const exam=type==="exam";
    return {badge:exam?"WORKING":"NON-WORKING",
      text:"Holiday range (global) — "+hol.name+" ("+hol.type+")"+(exam?", counts as working":"")};
  }
  const w=isWorkingDayForContext(iso, ctx);
  const ctxName=(!ctx||ctx.type==="global")?"Global":(ctx.type==="class"?"Class: "+ctx.name:"Batch: "+ctx.name);
  return {badge:w?"WORKING":"NON-WORKING",
    text:"Weekly template ("+ctxName+") — "+(w?"working":"non-working")};
}
function openDaySheet(iso){
  const ctx=getScheduleContext();
  const src=daySheetSource(iso, ctx);
  const ov=getOverride(iso);
  const hol=isHoliday(iso);
  const resolvedWorking=src.badge==="WORKING";
  const dt=new Date(iso+"T00:00:00");
  const sep=`<div style="height:1px;background:var(--hairline);margin:14px 0;"></div>`;
  const secLbl=`font-size:10px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-2);margin-bottom:10px;`;
  daySheetTitle.textContent=dt.toLocaleDateString("en-GB",{weekday:"long"})+", "+_fmtShort(iso);
  daySheetBody.innerHTML=
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="setup-legend-context">${esc(src.badge)}</span></div>`+
    `<div style="font-size:11px;color:var(--ink-2);line-height:1.5;">${esc(src.text)}</div>`+
    sep+
    `<div style="${secLbl}">Day status</div>`+
    `<div class="form-grid">`+
    `<div class="form-field full"><label>Note</label><input id="dsNote" placeholder="Note (optional)" value="${esc(ov?ov.note:"")}"></div>`+
    `<div class="form-field full" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">`+
    `<button class="btn" id="dsFlip">${resolvedWorking?"Mark non-working":"Mark working"}</button>`+
    (ov?`<button class="btn danger" id="dsClear">Clear override</button>`:"")+
    `</div></div>`+
    sep+
    `<div style="${secLbl}">Holiday range</div>`+
    (hol?`<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px">`+
    `<button class="btn danger" id="dsDelHol">Remove ${esc(hol.name)} range</button></div>`:"")+
    `<div class="form-grid">`+
    `<div class="form-field full"><label>Name</label><input id="dsHolName" placeholder="Diwali vacation" value="${esc(hol?hol.name:"")}"></div>`+
    `<div class="form-field"><label>Start date</label><input type="date" id="dsHolStart" value="${esc(hol?hol.start:iso)}"></div>`+
    `<div class="form-field"><label>End date</label><input type="date" id="dsHolEnd" value="${esc(hol?hol.end:iso)}"></div>`+
    `<div class="form-field"><label>Type</label><select id="dsHolType"><option value="holiday"${!hol||hol.type==="holiday"?" selected":""}>Holiday</option><option value="vacation"${hol&&hol.type==="vacation"?" selected":""}>Vacation</option><option value="exam"${hol&&hol.type==="exam"?" selected":""}>Exam day (working)</option></select></div>`+
    `<div class="form-field full" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center"><button class="btn primary" id="dsHolSave">Save holiday</button><button class="btn" id="dsClose">Close</button></div>`+
    `<div class="inline-error" id="dsHolErr" style="display:none"></div></div>`;
  openModal(daySheetModal);
  $("dsFlip").onclick=async()=>{
    const note=$("dsNote").value.trim();
    Overrides=Overrides.filter(o=>o.date!==iso);
    Overrides.push({date:iso,isWorking:!resolvedWorking,note});
    if(await persistCalendar()){ renderOverrides(); renderCalendarMonth(); openDaySheet(iso); }
  };
  if(ov) $("dsClear").onclick=async()=>{
    Overrides=Overrides.filter(o=>o.date!==iso);
    if(await persistCalendar()){ renderOverrides(); renderCalendarMonth(); openDaySheet(iso); }
  };
  if(hol){
    $("dsDelHol").onclick=async()=>{
      if(!(await glassConfirm(`Remove holiday range "${hol.name}" (${hol.start}..${hol.end})? Days fall back to the weekly template.`,{title:"Remove holiday range",okText:"Remove",danger:true}))) return;
      Holidays=Holidays.filter(h=>h.start!==hol.start);
      if(await persistCalendar()){ renderHolidays(); renderCalendarMonth(); openDaySheet(iso); }
    };
  }
  const editStart=hol?hol.start:null;
  $("dsHolSave").onclick=async()=>{
    const name=$("dsHolName").value.trim(), start=$("dsHolStart").value, end=$("dsHolEnd").value||start, err=$("dsHolErr");
    if(!name||!start||!end||start>end){ err.textContent="Name and a valid date range are required."; err.style.display="block"; return; }
    Holidays=Holidays.filter(h=>h.start!==start&&h.start!==editStart);
    Holidays.push({name,start,end,category:"",type:$("dsHolType").value});
    if(await persistCalendar()){ renderHolidays(); renderCalendarMonth(); openDaySheet(iso); }
  };
  $("dsClose").onclick=()=>closeModal(daySheetModal);
}
async function onDayToggleClick(e){
  const cell=e.target.closest("[data-date]");
  if(cell){ openDaySheet(cell.dataset.date); return; }
  const toggle=e.target.closest("[data-day]"); if(!toggle) return;
  const day=String(toggle.dataset.day);
  const ctx=getScheduleContext();
  if(ctx.type === "class"){
    let entry = ClassSchedules[ctx.name];
    let wd;
    if(entry && typeof entry==="object" && entry.workingDays) wd={...entry.workingDays};
    else if(entry && typeof entry==="object" && !entry.workingDays && Object.keys(entry).some(k=>k in [0,1,2,3,4,5,6])) wd={...entry};
    else wd={...Settings.workingDays};
    wd[day]=!asBool(wd[day] ?? wd[String(day)]);
    wd[String(day)]=wd[day];
    ClassSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {workingDays: wd});
    ClassSchedulesUI=ClassSchedules;
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else if(ctx.type === "batch"){
    let entry = BatchSchedules[ctx.name];
    let wd;
    if(entry && typeof entry==="object" && entry.workingDays) wd={...entry.workingDays};
    else if(entry && typeof entry==="object" && !entry.workingDays && Object.keys(entry).some(k=>k in [0,1,2,3,4,5,6])) wd={...entry};
    else wd={...Settings.workingDays};
    wd[day]=!asBool(wd[day] ?? wd[String(day)]);
    wd[String(day)]=wd[day];
    BatchSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {workingDays: wd});
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else {
    Settings.workingDays[day]=!asBool(Settings.workingDays[day] ?? Settings.workingDays[String(day)]);
    Settings.workingDays[String(day)]=Settings.workingDays[day];
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  }
}
if($("calendarGrid")){
  $("calendarGrid").addEventListener("click", onDayToggleClick);
  $("calendarGrid").addEventListener("keydown", (e)=>{
    if(e.key !== "Enter" && e.key !== " ") return;
    const t = e.target && e.target.closest ? e.target.closest("[data-day]") : null;
    if(!t) return;
    e.preventDefault();
    onDayToggleClick(e);
  });
}
if($("calClassSelect")) $("calClassSelect").onchange=()=>{ renderWeekly(); renderCalendarMonth(); if(currentTab==="attendance" || currentTab==="today") renderAttendance(); };
$("calResetWeekBtn").onclick=async()=>{
  const ctx=getScheduleContext();
  const defWd={0:false,1:true,2:true,3:true,4:true,5:true,6:true};
  if(ctx.type === "class"){
    let entry = ClassSchedules[ctx.name] || {};
    ClassSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {workingDays: defWd});
    ClassSchedulesUI=ClassSchedules;
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else if(ctx.type === "batch"){
    let entry = BatchSchedules[ctx.name] || {};
    BatchSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {workingDays: defWd});
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  } else {
    Settings.workingDays=defWd;
    if(await persistCalendar()){ renderWeekly(); renderCalendarMonth(); renderToday(); renderReports(); }
  }
};
if($("schedSaveTimingBtn")) $("schedSaveTimingBtn").onclick=async()=>{
  const ctx = getScheduleContext();
  const pVal = $("schedPresentCutoff") ? $("schedPresentCutoff").value : "08:00";
  const lVal = $("schedLateCutoff") ? $("schedLateCutoff").value : "08:30";
  if(!pVal || !lVal){ await glassAlert("Both Present and Late cutoffs are required."); return; }
  if(pVal > lVal){ await glassAlert("Present cutoff must be before or equal to Late cutoff."); return; }

  if(ctx.type === "global"){
    Settings.presentCutoff = pVal;
    Settings.lateCutoff = lVal;
    Settings.lateAfter = lVal;
    if($("setLateThreshold")) $("setLateThreshold").value = lVal;
    if($("setPresentCutoff")) $("setPresentCutoff").value = pVal;
    try {
      await api("/api/settings", {method: "POST", body: JSON.stringify({
        presentCutoff: pVal, lateCutoff: lVal
      })});
      await persistCalendar();
      await glassAlert("Global timings saved.");
    } catch(e){ await glassAlert("Failed to save timings: "+e.message); }
  } else if(ctx.type === "class"){
    let entry = ClassSchedules[ctx.name] || {};
    ClassSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {
      workingDays: entry.workingDays || getWorkingDaysForClass(ctx.name),
      presentCutoff: pVal,
      lateCutoff: lVal
    });
    ClassSchedulesUI = ClassSchedules;
    cacheSave();
    if(await persistCalendar()){
      await glassAlert(`Timings saved for class ${ctx.name}.`);
    }
  } else if(ctx.type === "batch"){
    let entry = BatchSchedules[ctx.name] || {};
    BatchSchedules[ctx.name] = Object.assign({}, typeof entry==="object"?entry:{}, {
      workingDays: entry.workingDays || getWorkingDaysForBatch(ctx.name),
      presentCutoff: pVal,
      lateCutoff: lVal
    });
    cacheSave();
    if(await persistCalendar()){
      await glassAlert(`Timings saved for batch ${ctx.name}.`);
    }
  }
  renderScheduleTiming();
};
if($("schedRevertTimingBtn")) $("schedRevertTimingBtn").onclick=async()=>{
  const ctx = getScheduleContext();
  if(ctx.type === "class" && ClassSchedules[ctx.name]){
    delete ClassSchedules[ctx.name].presentCutoff;
    delete ClassSchedules[ctx.name].lateCutoff;
    ClassSchedulesUI = ClassSchedules;
    cacheSave();
    if(await persistCalendar()){
      await glassAlert(`Class ${ctx.name} reverted to global timings.`);
    }
  } else if(ctx.type === "batch" && BatchSchedules[ctx.name]){
    delete BatchSchedules[ctx.name].presentCutoff;
    delete BatchSchedules[ctx.name].lateCutoff;
    cacheSave();
    if(await persistCalendar()){
      await glassAlert(`Batch ${ctx.name} reverted to inherited timings.`);
    }
  }
  renderScheduleTiming();
};
/* Old modals + table listeners retired with the list sections (Phases 2-3):
   the day editor is the only schedule writer now — flip/note/Clear,
   section-3 save, Edit-prefill, Remove-confirm. renderHolidays/
   renderOverrides stay as early-returning no-ops while their bodies
   are absent. */
if(classBody) classBody.addEventListener("click", async e=>{
  const delBtn = e.target.closest("[data-del-class]");
  if(delBtn){
    const c = delBtn.dataset.delClass;
    if(!(await glassConfirm(`Remove class "${c}"?`,{title:"Remove class",okText:"Remove",danger:true}))) return;
    try{
      const next = Classes.filter(x=>x!==c);
      await api("/api/settings",{method:"POST",body:JSON.stringify({classes:next})});
      await loadClassesHolidaysSettings();
      renderAll();
    }catch(err){ await glassAlert("Failed to remove class: "+err.message); }
    return;
  }
  const btn = e.target.closest("[data-sched-class]");
  if(!btn) return;
  const c = btn.dataset.schedClass;
  currentTab = "setup";
  [...adminNav.children].forEach(b=>b.classList.toggle("active", b.dataset.tab==="setup"));
  updateTabs();
  const sel = $("calClassSelect");
  if(sel){
    sel.value = `class:${c}`;
    if(!sel.value) sel.value = c;
    renderWeekly();
    renderCalendarMonth();
  }
});
const batchBodyEl = $("batchBody");
if(batchBodyEl) batchBodyEl.addEventListener("click", async e=>{
  const delBtn = e.target.closest("[data-del-batch]");
  if(delBtn){
    const b = delBtn.dataset.delBatch;
    if(!(await glassConfirm(`Remove batch "${b}"?`,{title:"Remove batch",okText:"Remove",danger:true}))) return;
    try{
      const next = (Batches||[]).filter(x=>x!==b);
      await api("/api/settings",{method:"POST",body:JSON.stringify({batches:next})});
      await loadClassesHolidaysSettings();
      renderAll();
    }catch(err){ await glassAlert("Failed to remove batch: "+err.message); }
    return;
  }
  const btn = e.target.closest("[data-sched-batch]");
  if(!btn) return;
  const b = btn.dataset.schedBatch;
  currentTab = "setup";
  [...adminNav.children].forEach(b=>b.classList.toggle("active", b.dataset.tab==="setup"));
  updateTabs();
  const sel = $("calClassSelect");
  if(sel){
    sel.value = `batch:${b}`;
    renderWeekly();
    renderCalendarMonth();
  }
});
$("addClassBtn").onclick=async()=>{
  const input=$("newClassName"), name=input.value.trim();
  if(!name) return;
  if(Classes.some(c=>c.toLowerCase()===name.toLowerCase())){ await glassAlert("That class already exists."); return; }
  try{ await api("/api/settings",{method:"POST",body:JSON.stringify({classes:Classes.concat(name)})}); input.value=""; await loadClassesHolidaysSettings(); renderAll(); }
  catch(e){ await glassAlert("Failed to add class: "+e.message); }
};
if($("addBatchBtn")) $("addBatchBtn").onclick=async()=>{
  const input=$("newBatchName"), name=input.value.trim();
  if(!name) return;
  if((Batches||[]).some(b=>b.toLowerCase()===name.toLowerCase())){ await glassAlert("That batch already exists."); return; }
  try{
    const next = (Batches||[]).concat(name);
    await api("/api/settings",{method:"POST",body:JSON.stringify({batches:next})});
    input.value="";
    await loadClassesHolidaysSettings();
    renderAll();
  }catch(e){ await glassAlert("Failed to add batch: "+e.message); }
};
$("settingsSaveBtn").onclick=async()=>{
  try{
    const start=$("setAttendanceStart")?$("setAttendanceStart").value:"";
    const pVal=$("setPresentCutoff")?$("setPresentCutoff").value:"08:00";
    const lVal=$("setLateThreshold")?$("setLateThreshold").value:"08:30";
    await api("/api/settings",{method:"POST",body:JSON.stringify({
      schoolName:$("setSchoolName").value.trim(),
      address:$("setSchoolAddress").value.trim(),
      presentCutoff: pVal,
      lateCutoff: lVal,
      academicYear:$("setAcademicYear").value,
      attendanceStartDate: start || undefined,
      schoolOpeningDate: start || undefined
    })});
    Settings.presentCutoff = pVal;
    Settings.lateCutoff = lVal;
    Settings.lateAfter = lVal;
    await glassAlert("Settings saved to database.");
    await loadClassesHolidaysSettings(); renderAll();
  }catch(e){ await glassAlert("Failed: "+e.message); }
};
$("settingsExportBtn").onclick=()=>exportCSV([["Field","Value"],["School name",$("setSchoolName").value],["Address",$("setSchoolAddress").value],["Late threshold",$("setLateThreshold").value],["Academic year",$("setAcademicYear").value]],"school-settings.csv");
$("backupDownloadBtn").onclick=async()=>{
  try{
    const b = await api("/api/backup", {method:"GET", responseType:"blob"});
    const url=URL.createObjectURL(b), a=document.createElement('a'); a.href=url; a.download="atl-backup-"+todayISO()+".db"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }catch(e){
    await glassAlert("Backup failed: "+(e.message||(e.body&&e.body.error)||e.status));
  }
};
$("backupFileInput").onchange=async(e)=>{
  const file=e.target.files&&e.target.files[0]; if(!file) return;
  const status=$("backupStatus"); status.textContent="Restoring…";
  pauseSensorScan();
  try{
    const form=new FormData(); form.append("file",file);
    const body = await api("/api/restore", {method:"POST", body:form});
    status.textContent="Restore complete. Reloading data…"; await loadAll();
  }catch(err){
    const msg = err.message || (err.body && err.body.error) || err.status;
    status.textContent="Restore failed: "+msg;
    try{ await glassAlert("Restore failed: "+msg); }catch(_e){}
  }finally{
    resumeSensorScan();
  }
  e.target.value="";
};
if($("auditExportBtn")) $("auditExportBtn").onclick=()=>{
  const rows=[["Time","Action","Details","By"]].concat(Audit.map(a=>[a.time,a.action,a.details,a.by||"Admin"]));
  exportCSV(rows,"audit_"+todayISO()+".csv");
};
$("auditClearBtn").onclick=()=>{ try{ glassAlert("Clear audit is managed on the backend."); }catch(e){} };

// --- Unified Backup Manager Controller ---
let _gdrivePollTimer = null;
let _unifiedActiveWeekdays = [0, 1, 2, 3, 4, 5, 6];
let _destStates = {
  gdrive: null,
  telegram: null,
  usb: null
};

function stopGDrivePolling(){
  if(_gdrivePollTimer){
    clearInterval(_gdrivePollTimer);
    _gdrivePollTimer = null;
  }
}

function renderDeviceCodeBox(df){
  const codeBox = $("gdriveDeviceCodeBox");
  const initBox = $("gdriveInitBox");
  const authBox = $("gdriveAuthBox");
  if(!codeBox) return;
  if(df && df.userCode){
    if(authBox) authBox.style.display = "block";
    if(initBox) initBox.style.display = "none";
    codeBox.style.display = "block";
    if($("gdriveUserCodeDisplay")) $("gdriveUserCodeDisplay").textContent = df.userCode;
    const link = $("gdriveDeviceUrlLink");
    if(link){
      link.href = df.verificationUrlComplete || df.verificationUrl || "https://www.google.com/device";
    }
    if($("gdriveDevicePollStatus")) $("gdriveDevicePollStatus").textContent = "Waiting for approval…";
  } else {
    if(initBox) initBox.style.display = "flex";
    codeBox.style.display = "none";
  }
}

function startGDrivePolling(intervalSec){
  stopGDrivePolling();
  const pollInterval = Math.max((intervalSec || 5) * 1000, 3000);
  _gdrivePollTimer = setInterval(async () => {
    try {
      const res = await api("/api/backup/gdrive/device-poll", { method: "POST" });
      if(res && res.status === "success"){
        stopGDrivePolling();
        renderDeviceCodeBox(null);
        await glassAlert("Connected to Google Drive successfully!");
        await loadBackupManagerStatus();
      } else if(res && (res.status === "pending" || res.status === "slow_down")){
        if($("gdriveDevicePollStatus")) $("gdriveDevicePollStatus").textContent = "Waiting for approval…";
      } else if(res && res.status === "expired"){
        stopGDrivePolling();
        renderDeviceCodeBox(null);
        if($("gdriveDevicePollStatus")) $("gdriveDevicePollStatus").textContent = "Session expired.";
        await loadBackupManagerStatus();
      }
    } catch(e){
      stopGDrivePolling();
      const m = (e.body && e.body.error) || e.message || "Polling stopped";
      if($("gdriveDevicePollStatus")) $("gdriveDevicePollStatus").textContent = m;
    }
  }, pollInterval);
}

async function startDeviceFlow(){
  const btn = $("gdriveDeviceStartBtn");
  try {
    if(btn){ btn.disabled = true; btn.textContent = "Connecting…"; }
    const res = await api("/api/backup/gdrive/device-start", { method: "POST" });
    if(res && res.ok){
      renderDeviceCodeBox(res);
      startGDrivePolling(res.interval || 5);
      if(res.verificationUrlComplete){
        window.open(res.verificationUrlComplete, "_blank");
      }
    } else {
      await glassAlert((res && res.error) || "Failed to start Google authorization");
    }
  } catch(err){
    const m = (err.body && err.body.error) || err.message || "Failed to start Google authorization";
    await glassAlert("Google Drive: " + m);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = "Pair with Google"; }
  }
}

async function cancelDeviceFlow(){
  stopGDrivePolling();
  renderDeviceCodeBox(null);
  try {
    await api("/api/backup/gdrive/device-cancel", { method: "POST" });
  } catch(_){}
  await loadBackupManagerStatus();
}

function updateUnifiedLastBackupInfo(dests){
  const infoEl = $("backupLastInfo");
  if(!infoEl) return;
  let newestStr = null;
  let newestDest = null;
  let newestName = null;
  const labels = ["Google Drive", "Telegram", "USB Drive"];

  dests.forEach((d, idx) => {
    if(d && d.lastBackup){
      if(!newestStr || d.lastBackup > newestStr){
        newestStr = d.lastBackup;
        newestName = d.lastBackupName || "";
        newestDest = labels[idx];
      }
    }
  });

  if(newestStr){
    infoEl.textContent = `Last backup: ${newestStr}${newestName ? ` (${newestName})` : ""} · ${newestDest}`;
  } else {
    infoEl.textContent = "Last backup: Never";
  }
}

function renderUnifiedSchedule(sched){
  if(!$("backupSchedEnabled")) return;
  const enabled = sched.enabled !== false;
  $("backupSchedEnabled").checked = enabled;
  const label = $("backupSchedToggleLabel");
  if(label) label.textContent = enabled ? "ON" : "OFF";
  if($("backupSchedTime")) $("backupSchedTime").value = sched.time || "18:30";
  if($("backupSchedFreq")) $("backupSchedFreq").value = sched.frequency || "daily";
  if($("backupSchedInterval")) $("backupSchedInterval").value = sched.intervalDays || 1;

  _unifiedActiveWeekdays = Array.isArray(sched.weekdays) ? [...sched.weekdays] : [0, 1, 2, 3, 4, 5, 6];
  updateUnifiedScheduleVisibility();
  updateUnifiedWeekdayButtons();
}

function updateUnifiedScheduleVisibility(){
  const freq = $("backupSchedFreq") ? $("backupSchedFreq").value : "daily";
  const intervalWrap = $("backupSchedIntervalWrap");
  const daysWrap = $("backupSchedDaysWrap");
  if(intervalWrap) intervalWrap.style.display = (freq === "interval") ? "block" : "none";
  if(daysWrap) daysWrap.style.display = (freq === "weekdays") ? "block" : "none";
}

function updateUnifiedWeekdayButtons(){
  const container = $("backupSchedDays");
  if(!container) return;
  const btns = container.querySelectorAll("button[data-day]");
  btns.forEach(btn => {
    const day = parseInt(btn.dataset.day, 10);
    if(_unifiedActiveWeekdays.includes(day)){
      btn.classList.add("primary");
    } else {
      btn.classList.remove("primary");
    }
  });
}

async function loadBackupManagerStatus(){
  if(!$("backupManagerCard")) return;
  try{
    const [gdRes, tgRes, usbRes] = await Promise.allSettled([
      api("/api/backup/gdrive/status"),
      api("/api/backup/telegram/status"),
      api("/api/backup/usb/status")
    ]);

    const gd = gdRes.status === "fulfilled" ? gdRes.value : null;
    const tg = tgRes.status === "fulfilled" ? tgRes.value : null;
    const usb = usbRes.status === "fulfilled" ? usbRes.value : null;

    _destStates.gdrive = gd;
    _destStates.telegram = tg;
    _destStates.usb = usb;

    // 1. Google Drive Row
    const gdCheck = $("destCheckGdrive");
    const gdStatus = $("destStatusGdrive");
    const gdAuthBox = $("gdriveAuthBox");
    const gdActionBox = $("gdriveActionBox");
    if(gdCheck && gd) gdCheck.checked = gd.enabled !== false;
    if(gdStatus){
      if(!gd){
        gdStatus.textContent = "Offline"; gdStatus.className = "pill";
        if(gdActionBox) gdActionBox.style.display = "none";
      } else if(!gd.enabled){
        gdStatus.textContent = "Disabled"; gdStatus.className = "pill";
        if(gdAuthBox) gdAuthBox.style.display = "none";
        if(gdActionBox) gdActionBox.style.display = "none";
      } else if(!gd.configured){
        gdStatus.textContent = "Disabled"; gdStatus.className = "pill";
        if(gdAuthBox) gdAuthBox.style.display = "none";
        if(gdActionBox) gdActionBox.style.display = "none";
      } else if(!gd.authenticated){
        gdStatus.textContent = "Not paired"; gdStatus.className = "pill danger";
        if(gdActionBox) gdActionBox.style.display = "none";
        if(gdAuthBox) gdAuthBox.style.display = "block";
        if(gd.deviceFlow){
          renderDeviceCodeBox(gd.deviceFlow);
          if(!_gdrivePollTimer) startGDrivePolling(gd.deviceFlow.interval || 5);
        } else {
          renderDeviceCodeBox(null);
        }
      } else {
        gdStatus.textContent = "Ready"; gdStatus.className = "pill active";
        if(gdAuthBox) gdAuthBox.style.display = "none";
        if(gdActionBox){
          gdActionBox.style.display = "block";
          loadGDriveList();
        }
      }
    }

    // 2. Telegram Row
    const tgCheck = $("destCheckTelegram");
    const tgStatus = $("destStatusTelegram");
    if(tgCheck && tg) tgCheck.checked = tg.enabled !== false;
    if(tgStatus){
      if(!tg){
        tgStatus.textContent = "Offline"; tgStatus.className = "pill";
      } else if(!tg.enabled){
        tgStatus.textContent = "Disabled"; tgStatus.className = "pill";
      } else if(!tg.configured){
        tgStatus.textContent = "Not configured"; tgStatus.className = "pill";
      } else if(tg.lastStatus === "ERROR"){
        tgStatus.textContent = "Error"; tgStatus.className = "pill danger";
      } else {
        tgStatus.textContent = "Ready"; tgStatus.className = "pill active";
      }
    }
    if($("telegramChatId")){
      $("telegramChatId").textContent = (tg && tg.chatId) ? tg.chatId : "Not configured";
    }
    if($("telegramLastError")){
      if(tg && tg.lastError){
        $("telegramLastError").textContent = tg.lastError;
        $("telegramLastError").style.display = "block";
      } else {
        $("telegramLastError").textContent = "";
        $("telegramLastError").style.display = "none";
      }
    }

    // 3. USB Row
    const usbCheck = $("destCheckUsb");
    const usbStatus = $("destStatusUsb");
    if(usbCheck && usb) usbCheck.checked = usb.enabled !== false;
    if(usbStatus){
      if(!usb){
        usbStatus.textContent = "Offline"; usbStatus.className = "pill";
      } else if(!usb.connected){
        usbStatus.textContent = "Not connected"; usbStatus.className = "pill";
      } else if(!usb.enabled){
        usbStatus.textContent = "Disabled"; usbStatus.className = "pill";
      } else if(usb.lastStatus === "ERROR"){
        usbStatus.textContent = "Error"; usbStatus.className = "pill danger";
      } else {
        usbStatus.textContent = "Ready"; usbStatus.className = "pill active";
      }
    }
    if($("usbMountPath")){
      $("usbMountPath").textContent = (usb && usb.mountPath) ? usb.mountPath : "Not detected";
    }
    if($("usbFreeSpace")){
      $("usbFreeSpace").textContent = (usb && usb.freeBytes) ? (usb.freeBytes / (1024*1024*1024)).toFixed(1) + " GB free" : "--";
    }
    if($("usbLastError")){
      if(usb && usb.lastError){
        $("usbLastError").textContent = usb.lastError;
        $("usbLastError").style.display = "block";
      } else {
        $("usbLastError").textContent = "";
        $("usbLastError").style.display = "none";
      }
    }

    // 4. Shared Schedule
    const activeSched = (gd && gd.schedule) || (tg && tg.schedule) || (usb && usb.schedule);
    if(activeSched) renderUnifiedSchedule(activeSched);

    // 5. Last Backup Info
    updateUnifiedLastBackupInfo([gd, tg, usb]);

  }catch(err){
    console.warn("loadBackupManagerStatus error:", err);
  }
}

// Backward-compatibility aliases
function loadGDriveStatus(){ return loadBackupManagerStatus(); }
function loadTelegramStatus(){ return loadBackupManagerStatus(); }
function loadUsbStatus(){ return loadBackupManagerStatus(); }

// Schedule Event Listeners
if($("backupSchedFreq")) $("backupSchedFreq").onchange = updateUnifiedScheduleVisibility;

if($("backupSchedEnabled")) $("backupSchedEnabled").onchange = function(){
  const label = $("backupSchedToggleLabel");
  if(label) label.textContent = this.checked ? "ON" : "OFF";
};

if($("backupSchedDays")) $("backupSchedDays").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-day]");
  if(!btn) return;
  const day = parseInt(btn.dataset.day, 10);
  if(_unifiedActiveWeekdays.includes(day)){
    if(_unifiedActiveWeekdays.length > 1){
      _unifiedActiveWeekdays = _unifiedActiveWeekdays.filter(d => d !== day);
    }
  } else {
    _unifiedActiveWeekdays.push(day);
  }
  updateUnifiedWeekdayButtons();
});

if($("backupSchedSaveBtn")) $("backupSchedSaveBtn").onclick = async () => {
  const btn = $("backupSchedSaveBtn");
  const statusEl = $("backupSchedStatus");
  try {
    btn.disabled = true;
    btn.textContent = "Saving…";
    if(statusEl) statusEl.textContent = "";

    const payload = {
      enabled: $("backupSchedEnabled") ? $("backupSchedEnabled").checked : true,
      time: $("backupSchedTime") ? $("backupSchedTime").value : "18:30",
      frequency: $("backupSchedFreq") ? $("backupSchedFreq").value : "daily",
      intervalDays: $("backupSchedInterval") ? parseInt($("backupSchedInterval").value, 10) || 1 : 1,
      weekdays: _unifiedActiveWeekdays
    };

    const saves = [
      api("/api/backup/gdrive/schedule", { method: "POST", body: JSON.stringify(payload) }),
      api("/api/backup/telegram/schedule", { method: "POST", body: JSON.stringify(payload) }),
      api("/api/backup/usb/schedule", { method: "POST", body: JSON.stringify(payload) })
    ];

    await Promise.allSettled(saves);

    if(statusEl) statusEl.textContent = "Schedule saved.";
    setTimeout(() => { if(statusEl) statusEl.textContent = ""; }, 3000);
    await loadBackupManagerStatus();
  } catch(e){
    await glassAlert("Save schedule failed: " + (e.message || (e.body && e.body.error) || "error"));
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Schedule";
  }
};

// Destination Toggles
if($("destCheckGdrive")) $("destCheckGdrive").onchange = async function(){
  try{
    await api("/api/backup/gdrive/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled: this.checked })
    });
  }catch(e){
    console.warn("Failed to toggle Google Drive:", e);
  }
  await loadBackupManagerStatus();
};

if($("destCheckTelegram")) $("destCheckTelegram").onchange = async function(){
  try{
    await api("/api/backup/telegram/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled: this.checked })
    });
  }catch(e){
    await glassAlert("Failed to toggle Telegram backup: " + (e.message || "error"));
  }
  await loadBackupManagerStatus();
};

if($("destCheckUsb")) $("destCheckUsb").onchange = async function(){
  try{
    await api("/api/backup/usb/toggle", {
      method: "POST",
      body: JSON.stringify({ enabled: this.checked })
    });
  }catch(e){
    await glassAlert("Failed to toggle USB backup: " + (e.message || "error"));
  }
  await loadBackupManagerStatus();
};

// Select All Destinations Button
if($("backupSelectAllBtn")) $("backupSelectAllBtn").onclick = async () => {
  const gd = $("destCheckGdrive");
  const tg = $("destCheckTelegram");
  const usb = $("destCheckUsb");
  const allChecked = (gd && gd.checked) && (tg && tg.checked) && (usb && usb.checked);
  const targetState = !allChecked;

  const toggles = [];
  if(gd && gd.checked !== targetState){
    gd.checked = targetState;
    toggles.push(api("/api/backup/gdrive/toggle", { method: "POST", body: JSON.stringify({ enabled: targetState }) }));
  }
  if(tg && tg.checked !== targetState){
    tg.checked = targetState;
    toggles.push(api("/api/backup/telegram/toggle", { method: "POST", body: JSON.stringify({ enabled: targetState }) }));
  }
  if(usb && usb.checked !== targetState){
    usb.checked = targetState;
    toggles.push(api("/api/backup/usb/toggle", { method: "POST", body: JSON.stringify({ enabled: targetState }) }));
  }
  await Promise.allSettled(toggles);
  await loadBackupManagerStatus();
};

// Back Up Now Button
if($("backupNowBtn")) $("backupNowBtn").onclick = async () => {
  const btn = $("backupNowBtn");
  const statusEl = $("backupNowStatus");
  const isGd = $("destCheckGdrive") && $("destCheckGdrive").checked;
  const isTg = $("destCheckTelegram") && $("destCheckTelegram").checked;
  const isUsb = $("destCheckUsb") && $("destCheckUsb").checked;

  if(!isGd && !isTg && !isUsb){
    await glassAlert("Please select at least one backup destination.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Backing up…";
  if(statusEl) statusEl.textContent = "Starting backups…";

  const tasks = [];
  const taskNames = [];

  if(isGd){
    taskNames.push("Google Drive");
    tasks.push(api("/api/backup/gdrive/backup", { method: "POST" }));
  }
  if(isTg){
    taskNames.push("Telegram");
    tasks.push(api("/api/backup/telegram/backup", { method: "POST" }));
  }
  if(isUsb){
    taskNames.push("USB");
    tasks.push(api("/api/backup/usb/backup", { method: "POST" }));
  }

  const results = await Promise.allSettled(tasks);
  const summaries = [];

  results.forEach((r, idx) => {
    const name = taskNames[idx];
    if(r.status === "fulfilled" && r.value && r.value.ok !== false){
      summaries.push(`${name}: OK`);
    } else {
      const err = (r.reason && ((r.reason.body && r.reason.body.error) || r.reason.message)) || (r.value && r.value.error) || "Failed";
      summaries.push(`${name}: ${err}`);
    }
  });

  const summaryText = summaries.join("; ");
  if(statusEl) statusEl.textContent = summaryText;
  await glassAlert(summaryText);

  await loadBackupManagerStatus();
  btn.disabled = false;
  btn.textContent = "Back Up Now";
};

// Refresh Button
if($("backupRefreshBtn")) $("backupRefreshBtn").onclick = async () => {
  const btn = $("backupRefreshBtn");
  try{
    btn.disabled = true;
    btn.innerHTML = "<span>↻</span> Checking…";
    await loadBackupManagerStatus();
  }finally{
    btn.disabled = false;
    btn.innerHTML = "<span>↻</span> Refresh";
  }
};

// Google Device Flow Event Listeners
if($("gdriveDeviceStartBtn")) $("gdriveDeviceStartBtn").onclick = startDeviceFlow;
if($("gdriveDeviceCancelBtn")) $("gdriveDeviceCancelBtn").onclick = cancelDeviceFlow;

// Google Drive Management
if($("gdriveDisconnectBtn")) {
  $("gdriveDisconnectBtn").onclick = async () => {
    if(!(await glassConfirm("Disconnect Google Drive cloud backup?",{title:"Disconnect Drive",okText:"Disconnect",danger:true}))) return;
    try {
      await api("/api/backup/gdrive/disconnect", {method: "POST"});
      await loadBackupManagerStatus();
    } catch(e) {
      await glassAlert("Disconnect failed: " + (e.message || "error"));
    }
  };
}

if($("gdriveRefreshListBtn")) {
  $("gdriveRefreshListBtn").onclick = () => loadGDriveList();
}

async function loadGDriveList() {
  const tbody = $("gdriveFilesBody");
  if(!tbody) return;
  try {
    const res = await api("/api/backup/gdrive/list");
    const files = (res && res.files) || [];
    if(!files.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--ink-3);padding:6px;font-size:10px">No cloud snapshots found</td></tr>';
      return;
    }
    tbody.innerHTML = files.map(f => {
      const sz = f.size ? `${(f.size / 1024).toFixed(1)} KB` : "";
      return `<tr>
        <td style="font-size:10px;padding:3px 6px">${esc(f.name)}</td>
        <td style="font-size:10px;color:var(--ink-2);padding:3px 6px">${sz}</td>
        <td style="padding:3px 6px"><button class="btn" style="padding:1px 6px;font-size:9px" data-gdrive-restore="${esc(f.id)}" data-gdrive-name="${esc(f.name)}">Restore</button></td>
      </tr>`;
    }).join("");
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--danger);padding:6px;font-size:10px">Failed to list: ${esc(e.message || "error")}</td></tr>`;
  }
}

if($("gdriveFilesBody")) {
  $("gdriveFilesBody").onclick = async (e) => {
    const btn = e.target.closest("button[data-gdrive-restore]");
    if(!btn) return;
    const fileId = btn.dataset.gdriveRestore;
    const name = btn.dataset.gdriveName || "cloud backup";
    if(!(await glassConfirm(`Restore database from cloud backup "${name}"?\n\nWARNING: Current database will be safely backed up to .pre_restore.bak before replacement.`,{title:"Restore from cloud",okText:"Restore",danger:true}))) return;
    pauseSensorScan();
    try {
      btn.disabled = true;
      btn.textContent = "Restoring…";
      await api("/api/backup/gdrive/restore", {method: "POST", body: JSON.stringify({fileId: fileId})});
      await glassAlert(`Database restored successfully from "${name}". Page will now reload.`);
      window.location.reload();
    } catch(err) {
      resumeSensorScan();
      await glassAlert("Restore failed: " + (err.message || "error"));
      btn.disabled = false;
      btn.textContent = "Restore";
    }
  };
}

// Telegram Management
if($("telegramBackupNowBtn")) {
  $("telegramBackupNowBtn").onclick = async () => {
    const btn = $("telegramBackupNowBtn");
    try {
      btn.disabled = true;
      btn.textContent = "Sending…";
      const res = await api("/api/backup/telegram/backup", {method: "POST"});
      await glassAlert("Backup sent to Telegram successfully: " + (res.name || "complete"));
      await loadBackupManagerStatus();
    } catch(e) {
      await glassAlert("Telegram backup failed: " + (e.message || "error"));
    } finally {
      btn.disabled = false;
      btn.textContent = "Send backup now";
    }
  };
}

if($("telegramClearStatusBtn")) {
  $("telegramClearStatusBtn").onclick = async () => {
    try {
      await api("/api/backup/telegram/clear-status", {method: "POST"});
      await loadBackupManagerStatus();
    } catch(e) {
      await glassAlert("Failed to clear status: " + (e.message || "error"));
    }
  };
}

// USB Management
if($("usbBackupNowBtn")) {
  $("usbBackupNowBtn").onclick = async () => {
    const btn = $("usbBackupNowBtn");
    try {
      btn.disabled = true;
      btn.textContent = "Backing up…";
      const res = await api("/api/backup/usb/backup", {method: "POST"});
      await glassAlert("Backup written to USB drive successfully: " + (res.name || "complete"));
      await loadBackupManagerStatus();
    } catch(e) {
      await glassAlert("USB backup failed: " + (e.message || "error"));
    } finally {
      btn.disabled = false;
      btn.textContent = "Backup to USB now";
    }
  };
}

if($("usbRefreshBtn")) {
  $("usbRefreshBtn").onclick = async () => {
    const btn = $("usbRefreshBtn");
    try {
      btn.disabled = true;
      btn.textContent = "Checking…";
      await loadBackupManagerStatus();
    } finally {
      btn.disabled = false;
      btn.textContent = "Check USB";
    }
  };
}

if($("usbClearStatusBtn")) {
  $("usbClearStatusBtn").onclick = async () => {
    try {
      await api("/api/backup/usb/clear-status", {method: "POST"});
      await loadBackupManagerStatus();
    } catch(e) {
      await glassAlert("Failed to clear status: " + (e.message || "error"));
    }
  };
}

// Window Focus & Routing
function checkAdminRoute(){
  const h = window.location.hash || "";
  const s = window.location.search || "";
  if(h.includes("admin=backup") || s.includes("admin=backup")){
    openAdmin();
    const btn = document.querySelector('nav.admin-nav button[data-tab="backup"]');
    if(btn){
      [...adminNav.children].forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      currentTab="backup";
      updateTabs();
    }
  }
}
window.addEventListener("load", checkAdminRoute);
window.addEventListener("hashchange", checkAdminRoute);
window.addEventListener("focus", ()=>{
  if(currentTab==="backup" && adminLayer && adminLayer.classList.contains("open")){
    loadBackupManagerStatus();
  }
});
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
    await loadClassesHolidaysSettings(); renderAll(); await glassAlert("Saved.");
  }catch(e){ await glassAlert("Failed: "+e.message); }
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
if(todayClassFilter) todayClassFilter.addEventListener("change",renderToday);
if(todayStatusFilter) todayStatusFilter.addEventListener("change",renderToday);
if(todaySort) todaySort.addEventListener("change",renderToday);
if(reportScope) reportScope.addEventListener("change",()=>{
  const sc=reportScope.value;
  if(reportClass) reportClass.style.display=(sc==="class")?"":"none";
  if(reportStudent) {
    reportStudent.style.display=sc==="student"?"":"none";
    if(sc==="student") reportStudent.innerHTML='<option value="">Select</option>'+Students.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)} — ${esc(s.roll)}</option>`).join("");
  }
});
if(reportTime) reportTime.addEventListener("change",()=>{ const show=reportTime.value==="custom"; if(reportFrom) reportFrom.style.display=show?"":"none"; if(reportTo) reportTo.style.display=show?"":"none"; });
const handleTableClick = (e)=>{
  const corr = e.target.closest("[data-correct]");
  if(corr){
    e.stopPropagation();
    const sid=parseInt(corr.dataset.correctSid), date=corr.dataset.correctDate, old=corr.dataset.correctStatus;
    openCorrection(sid, date, old);
    return;
  }
  const tr=e.target.closest("tr"); if(!tr) return; const sid=parseInt(tr.dataset.student);
  if(sid){ adminNav.querySelector('[data-tab="students"]').click(); setTimeout(()=>selectStudent(sid),120); }
};
if(attTableBody) attTableBody.addEventListener("click", handleTableClick);
if(todayTableBody && todayTableBody !== attTableBody) todayTableBody.addEventListener("click", handleTableClick);
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
      await glassAlert("Correction saved. Audit preserved.");
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
    else if(correctionModal && correctionModal.classList.contains("open")) closeModal(correctionModal);
    else if(adminLayer && adminLayer.classList.contains("open")){
      finishEnrollUi();
      adminLayer.classList.remove("open");
      resumeSensorScan();
    }
  }
});
// ---- init ----
function bootFail(e){ console.error(e); document.body.insertAdjacentHTML("afterbegin",'<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#8A3A3A;color:#fff;font:12px sans-serif;padding:8px 12px">Boot failed: '+String((e&&e.message)||e)+'</div>'); }
cacheLoad();
try{ renderAll(); }catch(e){ bootFail(e); }
setState("ready");
loadAll().then(()=>{ setTimeout(sensorScanLoop,300); }, bootFail);
setInterval(()=>{
  if(typeof document!=="undefined" && document.hidden) return;
  loadTodayAttendance().then(()=>{ if(currentTab==="attendance" || currentTab==="today") renderAttendance(); });
}, 15000);
// alias used by the injected backend bridge
function saveStorage(){ return cacheSave(); }
/* Glass confirm/alert — frosted replacement for native confirm()/alert() (Promise-based) */
function glassDialog(opts){
  opts=opts||{};
  return new Promise((resolve)=>{
    const prevFocus=(typeof document!=='undefined'&&document.activeElement)||null;
    const ov=document.createElement('div'); ov.className='gconfirm-ov';
    const card=document.createElement('div'); card.className='gconfirm'; card.setAttribute('role','alertdialog'); card.setAttribute('aria-modal','true');
    const h=document.createElement('h3'); h.textContent=opts.title||'Confirm'; card.appendChild(h);
    const p=document.createElement('p'); p.textContent=opts.message||''; card.appendChild(p);
    const row=document.createElement('div'); row.className='gconfirm-row';
    let done=false;
    const cleanup=()=>{ ov.remove(); document.removeEventListener('keydown',onKey,true); if(prevFocus&&prevFocus.focus){ try{ prevFocus.focus(); }catch(e){} } };
    const finish=(v)=>{ if(done) return; done=true; cleanup(); resolve(v); };
    if(opts.cancelText!==null&&opts.cancelText!==undefined){
      const c=document.createElement('button'); c.type='button'; c.className='gconfirm-cancel'; c.textContent=opts.cancelText||'Cancel';
      c.addEventListener('click',()=>finish(false)); row.appendChild(c);
    }
    const ok=document.createElement('button'); ok.type='button'; ok.className='gconfirm-ok'+(opts.danger?' danger':''); ok.textContent=opts.okText||'Confirm';
    ok.addEventListener('click',()=>finish(true)); row.appendChild(ok);
    card.appendChild(row); ov.appendChild(card); document.body.appendChild(ov);
    const btns=Array.from(row.querySelectorAll('button'));
    const onKey=(e)=>{
      if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); finish(false); }
      else if(e.key==='Enter'){ e.preventDefault(); e.stopPropagation(); finish(true); }
      else if(e.key==='Tab'){ e.preventDefault(); e.stopPropagation(); const i=btns.indexOf(document.activeElement); const n=e.shiftKey?(i<=0?btns.length-1:i-1):(i===btns.length-1?0:i+1); btns[n].focus(); }
    };
    document.addEventListener('keydown',onKey,true);
    try{ ok.focus(); }catch(e){}
  });
}
function glassConfirm(message,opts){ opts=opts||{}; opts.message=message; if(opts.cancelText===undefined) opts.cancelText='Cancel'; if(!opts.okText) opts.okText='Confirm'; return glassDialog(opts); }
function glassAlert(message,okText){ return glassDialog({title:'Notice',message:message,okText:okText||'OK',cancelText:null}); }
/* Photo dropzone — re-skins native file input, preserves files[0] read path + validation */
function enhancePhotoField(input){
  if(!input||input.tagName!=='INPUT'||input.type!=='file'||input.dataset.ph) return;
  input.dataset.ph='1';
  const drop=document.createElement('div'); drop.className='photo-drop';
  input.parentNode.insertBefore(drop,input); drop.appendChild(input);
  try{ input.tabIndex=-1; }catch(e){}
  const thumb=document.createElement('div'); thumb.className='photo-thumb'; thumb.innerHTML='<span>Photo</span>';
  const meta=document.createElement('div'); meta.className='photo-meta';
  const nm=document.createElement('div'); nm.className='photo-name'; nm.textContent='No photo yet';
  const sz=document.createElement('div'); sz.className='photo-sub'; sz.textContent='Optional · max 2MB · drag & drop';
  meta.appendChild(nm); meta.appendChild(sz);
  const acts=document.createElement('div'); acts.className='photo-acts';
  const choose=document.createElement('button'); choose.type='button'; choose.className='photo-choose'; choose.textContent='Choose';
  const rm=document.createElement('button'); rm.type='button'; rm.className='photo-remove'; rm.textContent='Remove'; rm.style.display='none';
  acts.appendChild(choose); acts.appendChild(rm);
  drop.appendChild(thumb); drop.appendChild(meta); drop.appendChild(acts);
  let objUrl=null;
  const refresh=()=>{
    const f=input.files&&input.files[0];
    if(objUrl){ try{ URL.revokeObjectURL(objUrl); }catch(e){} objUrl=null; }
    if(f){
      try{ objUrl=URL.createObjectURL(f); thumb.innerHTML=''; const im=document.createElement('img'); im.alt=''; im.src=objUrl; thumb.appendChild(im); }catch(e){}
      nm.textContent=f.name; sz.textContent=fmtPhotoSize(f.size)+' · kept on save'; rm.style.display='';
    }else{
      thumb.innerHTML='<span>Photo</span>'; nm.textContent='No photo yet'; sz.textContent='Optional · max 2MB · drag & drop'; rm.style.display='none';
    }
  };
  const changed=()=>refresh();
  input.addEventListener('change',changed);
  input._photoRefresh=refresh;
  choose.addEventListener('click',()=>{ try{ input.click(); }catch(e){} });
  rm.addEventListener('click',(e)=>{
    e.preventDefault();
    if(input.id==='edPhoto'){ const clr=document.getElementById('edClearPhoto'); if(clr){ clr.click(); } }
    else{ try{ input.value=''; }catch(_e){} }
    refresh();
  });
  drop.addEventListener('dragover',(e)=>{ e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',(e)=>{
    e.preventDefault(); drop.classList.remove('over');
    const fs=e.dataTransfer&&e.dataTransfer.files;
    if(fs&&fs.length){ try{ input.files=fs; }catch(_e){} refresh(); try{ input.dispatchEvent(new Event('change',{bubbles:true})); }catch(_e2){} }
  });
  refresh();
}
/* Glass dropdowns — custom translucent popups for native <select> (native stays truth, fires change) */
(function(){
  if(window.__glassSelectInit) return; window.__glassSelectInit=true;
  let openWrap=null, popEl=null, hiIdx=-1;
  function rows(){ return popEl ? Array.from(popEl.querySelectorAll('.gsel-opt:not([aria-disabled="true"])')) : []; }
  function setHi(i){
    const rs=rows(); if(!rs.length) return;
    hiIdx=(i+rs.length)%rs.length;
    rs.forEach((r,j)=>r.classList.toggle('hi', j===hiIdx));
    try{ rs[hiIdx].scrollIntoView({block:'nearest'}); }catch(e){}
  }
  function closePop(refocus){
    if(popEl){ popEl.remove(); popEl=null; }
    const w=openWrap; openWrap=null; hiIdx=-1;
    if(w){ w.classList.remove('open'); const b=w.querySelector('.gsel-btn'); if(b){ b.setAttribute('aria-expanded','false'); if(refocus) b.focus(); } }
    document.removeEventListener('pointerdown',onDocDown,true);
    document.removeEventListener('keydown',onKeyDown,true);
    window.removeEventListener('resize',onCloseOnly,true);
    window.removeEventListener('scroll',onScrollClose,true);
  }
  function onCloseOnly(){ closePop(false); }
  /* Inner list scrolls bubble to window: only an OUTER scroll closes */
  function onScrollClose(e){ if(popEl && e.target && !popEl.contains(e.target)) closePop(false); }
  /* Hover closes only once the cursor has left BOTH the control and the list */
  let hoverT=null;
  function schedHoverClose(){
    clearTimeout(hoverT);
    hoverT=setTimeout(()=>{
      try{
        const hw=openWrap&&openWrap.matches&&openWrap.matches(':hover');
        const hp=popEl&&popEl.matches&&popEl.matches(':hover');
        if(!hw&&!hp) closePop(false);
      }catch(e){ closePop(false); }
    },140);
  }
  function onDocDown(e){
    if(!openWrap) return;
    if(openWrap.contains(e.target)) return;
    if(popEl && popEl.contains(e.target)) return;
    closePop(false);
  }
  function onKeyDown(e){
    if(!openWrap || !popEl) return;
    if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); closePop(true); }
    else if(e.key==='ArrowDown'){ e.preventDefault(); e.stopPropagation(); setHi(hiIdx+1); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); e.stopPropagation(); setHi(hiIdx-1); }
    else if(e.key==='Enter'||e.key===' '){ const rs=rows(); if(rs.length && hiIdx>=0){ e.preventDefault(); e.stopPropagation(); rs[hiIdx].click(); } }
    else if(e.key==='Tab'){ closePop(false); }
  }
  function labelOf(sel){
    const o=sel.options[sel.selectedIndex];
    return o ? o.textContent : '';
  }
  function pick(sel,btn,v){
    if(sel.value!==v){ sel.value=v; try{ sel.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){ const ev=document.createEvent('HTMLEvents'); ev.initEvent('change',true,false); sel.dispatchEvent(ev); } }
    syncBtn(sel,btn); closePop(false); try{ btn.focus(); }catch(e){}
  }
  function syncBtn(sel,btn){
    const lab=btn.querySelector('.gsel-lab'); if(lab) lab.textContent=labelOf(sel);
    btn.disabled=!!sel.disabled;
  }
  function openPop(wrap,sel,btn){
    closePop(false);
    openWrap=wrap; wrap.classList.add('open'); btn.setAttribute('aria-expanded','true');
    popEl=document.createElement('div'); popEl.className='gsel-pop'; popEl.setAttribute('role','listbox');
    const map=[];
    const addOpt=(o)=>{
      const r=document.createElement('div'); r.className='gsel-opt'; r.setAttribute('role','option');
      r.textContent=o.textContent; r.dataset.v=o.value;
      if(o.disabled){ r.setAttribute('aria-disabled','true'); }
      else{
        if(o.value===sel.value){ r.classList.add('sel'); r.setAttribute('aria-selected','true'); }
        r.addEventListener('click',()=>pick(sel,btn,o.value));
        map.push(r);
      }
      popEl.appendChild(r);
    };
    Array.from(sel.children).forEach(ch=>{
      if(ch.tagName==='OPTGROUP'){
        const g=document.createElement('div'); g.className='gsel-grp'; g.textContent=ch.label||''; popEl.appendChild(g);
        Array.from(ch.children).forEach(o=>{ if(o.tagName==='OPTION') addOpt(o); });
      }else if(ch.tagName==='OPTION'){ addOpt(ch); }
    });
    document.body.appendChild(popEl);
    popEl.addEventListener('mouseleave',schedHoverClose);
    const rc=wrap.getBoundingClientRect();
    popEl.style.minWidth=Math.max(rc.width,140)+'px';
    popEl.style.maxWidth=Math.max(140,window.innerWidth-16)+'px';
    const h=Math.min(260,popEl.offsetHeight||260);
    let top=rc.bottom+4;
    if(top+h>window.innerHeight-8) top=Math.max(8,rc.top-4-h);
    /* Left-align to the control; if the popup would spill past the
       viewport's right edge, right-align to the control instead */
    let left=rc.left;
    if(left+popEl.offsetWidth>window.innerWidth-8) left=Math.max(8,rc.right-popEl.offsetWidth);
    popEl.style.top=top+'px'; popEl.style.left=Math.max(8,left)+'px';
    hiIdx=map.findIndex(r=>r.classList.contains('sel')); if(hiIdx<0) hiIdx=0;
    map.forEach((r,j)=>r.classList.toggle('hi',j===hiIdx));
    const cur=map[hiIdx]; if(cur){ try{cur.scrollIntoView({block:'nearest'});}catch(e){} }
    document.addEventListener('pointerdown',onDocDown,true);
    document.addEventListener('keydown',onKeyDown,true);
    window.addEventListener('resize',onCloseOnly,true);
    window.addEventListener('scroll',onScrollClose,true);
  }
  function enhance(sel){
    if(!sel||sel.tagName!=='SELECT'||sel.dataset.gsel) return;
    if(sel.id==='attDatePreset') return; /* segmented strip owns this one */
    sel.dataset.gsel='1';
    const wrap=document.createElement('span'); wrap.className='gsel';
    try{
      if(sel.style.width) wrap.style.width=sel.style.width;
      if(sel.style.maxWidth) wrap.style.maxWidth=sel.style.maxWidth;
      ['height','minHeight','padding','border','background','fontSize','borderRadius','outline'].forEach(k=>{ sel.style[k]=''; });
    }catch(e){}
    if(sel.closest && sel.closest('.form-field')) wrap.classList.add('gsel-form');
    sel.parentNode.insertBefore(wrap,sel); wrap.appendChild(sel);
    try{ sel.tabIndex=-1; sel.setAttribute('aria-hidden','true'); }catch(e){}
    const btn=document.createElement('button'); btn.type='button'; btn.className='gsel-btn';
    btn.setAttribute('aria-haspopup','listbox'); btn.setAttribute('aria-expanded','false');
    const lab=document.createElement('span'); lab.className='gsel-lab'; btn.appendChild(lab);
    const ch=document.createElement('span'); ch.className='gsel-chev'; ch.textContent='\u25BE'; btn.appendChild(ch);
    wrap.appendChild(btn);
    const sync=()=>syncBtn(sel,btn); sel.addEventListener('change',sync); sync();
    try{ new MutationObserver(sync).observe(sel,{childList:true}); }catch(e){}
    /* Hover owns open/close (click toggle retired — it fought the hover);
       keyboard Enter/Space/Arrows still open for accessibility. */
    wrap.addEventListener('mouseenter',()=>{ if(sel.disabled) return; if(openWrap!==wrap) openPop(wrap,sel,btn); });
    wrap.addEventListener('mouseleave',schedHoverClose);
    btn.addEventListener('keydown',(e)=>{
      if(sel.disabled) return;
      if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Enter'||e.key===' '){ e.preventDefault(); if(openWrap!==wrap) openPop(wrap,sel,btn); }
    });
  }
  function enhanceAll(root){
    try{ (root||document).querySelectorAll('select').forEach(enhance); }catch(e){}
  }
  enhanceAll(document);
  try{
    new MutationObserver((muts)=>{
      muts.forEach(m=>{ m.addedNodes.forEach(n=>{ if(!n||!n.querySelectorAll) return; if(n.tagName==='SELECT') enhance(n); enhanceAll(n); }); });
    }).observe(document.body,{childList:true,subtree:true});
  }catch(e){}
})();
/* Date preset segmented strip — inline replacement for the
   attDatePreset dropdown popup (no window; options flow left→right).
   Native select stays hidden truth; clicks write its value and fire
   change so the existing preset/custom/Apply flow runs untouched. */
(function(){
  function build(){
    const sel=document.getElementById("attDatePreset"); if(!sel||sel.dataset.seg) return;
    sel.dataset.seg="1";
    const strip=document.createElement("span"); strip.className="seg-strip"; strip.setAttribute("role","group"); strip.setAttribute("aria-label","Date range");
    const btns=[];
    Array.from(sel.options).forEach(o=>{
      const b=document.createElement("button"); b.type="button"; b.className="seg-btn"; b.textContent=o.textContent; b.dataset.v=o.value;
      b.setAttribute("aria-pressed",o.value===sel.value?"true":"false");
      b.addEventListener("click",()=>{
        if(sel.value!==o.value){
          sel.value=o.value;
          /* Drive the flow directly (never rely on event delivery alone) */
          try{
            const v=o.value, isCustom=(v==="custom_day"||v==="custom_range");
            if(v!=="academic"){ attAcadFrom=attAcadTo=null; }
            if(typeof attSingleDate!=="undefined"&&attSingleDate) attSingleDate.style.display=(v==="custom_day")?"":"none";
            if(typeof attFromDate!=="undefined"&&attFromDate) attFromDate.style.display=(v==="custom_range")?"":"none";
            if(typeof attToDate!=="undefined"&&attToDate) attToDate.style.display=(v==="custom_range")?"":"none";
            if(typeof attApplyBtn!=="undefined"&&attApplyBtn) attApplyBtn.style.display=isCustom?"":"none";
            if(typeof renderAttendance==="function") renderAttendance();
          }catch(e){}
          try{ sel.dispatchEvent(new Event("change",{bubbles:true})); }catch(e){ try{ const ev=document.createEvent("HTMLEvents"); ev.initEvent("change",true,false); sel.dispatchEvent(ev); }catch(_){} }
        }
        sync();
      });
      strip.appendChild(b); btns.push(b);
      if(o.value==="academic"||o.value==="custom_range"){
        b.addEventListener("mouseenter",()=>{ try{ if(o.value==="academic") openAcadPop(b); else openRangePop(b); }catch(e){} });
        /* Re-click toggles the shell shut (outside-press ignores anchor) */
        b.addEventListener("click",()=>{ try{ if(_dtOpenFor===(o.value==="academic"?"A:":"R:")+o.value) closeDtPops(); }catch(e){ console.error(e); } });
      }
    });
    function sync(){ btns.forEach(b=>{ const on=b.dataset.v===sel.value; b.classList.toggle("active",on); b.setAttribute("aria-pressed",on?"true":"false"); }); }
    sel.addEventListener("change",sync); sync();
    /* Section Clear: last item of the preset bar, parted by a hairline */
    try{
      const sep=document.createElement("span"); sep.className="seg-sep"; sep.setAttribute("aria-hidden","true");
      strip.appendChild(sep);
      const c=document.createElement("button"); c.type="button"; c.className="seg-btn seg-clear"; c.textContent="Clear";
      c.setAttribute("aria-label","Clear attendance filters");
      c.addEventListener("click",()=>{ try{ clearAttendanceSection(); }catch(e){ console.error(e); } });
      strip.appendChild(c);
    }catch(e){}
    try{ sel.parentNode.insertBefore(strip,sel); }catch(e){}
  }
  if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",build); } else { build(); }
})();
/* Academic-year + custom-range frost popups for the preset strip.
   Year spans anchor to Settings.startDate month/day (no invented
   cutoffs); range Apply auto-orders. Both write through the existing
   custom_range machinery (attFromDate/attToDate + renderAttendance). */
const MONTHS_S=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_L=["January","February","March","April","May","June","July","August","September","October","November","December"];
function _pad2(n){ return (n<10?"0":"")+n; }
function _iso(y,m,d){ return y+"-"+_pad2(m)+"-"+_pad2(d); }
function _fmtShort(iso){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||""); if(!m) return iso||"—"; return (+m[3])+" "+MONTHS_S[+m[2]-1]+" "+m[1]; }
function _dtShell(){
  closeDtPops();
  const box=document.createElement("div"); box.className="dt-pop"; box.setAttribute("role","dialog");
  box.id="dtRangeAcadPop";
  document.body.appendChild(box);
  return box;
}
let _dtOpenFor=null;
function closeDtPops(){
  _dtOpenFor=null;
  const old=document.getElementById("dtRangeAcadPop"); if(old){ try{old.remove();}catch(e){} }
  document.removeEventListener("pointerdown",_dtDocDown,true);
  document.removeEventListener("keydown",_dtKey,true);
  window.removeEventListener("scroll",_dtScroll,true);
  window.removeEventListener("resize",closeDtPops);
}
function _dtDocDown(e){ const box=document.getElementById("dtRangeAcadPop"); if(box&&!box.contains(e.target)&&!(box._dtAnchor&&box._dtAnchor.contains&&box._dtAnchor.contains(e.target))) closeDtPops(); }
function _dtKey(e){ if(e.key==="Escape"){ e.preventDefault(); closeDtPops(); } }
function _dtScroll(e){ const box=document.getElementById("dtRangeAcadPop"); if(box&&e.target&&!box.contains(e.target)) closeDtPops(); }
function _dtPlace(box,anchor){
  const r=anchor.getBoundingClientRect();
  box.style.visibility="hidden"; box.style.left="0px"; box.style.top="0px";
  const w=box.offsetWidth,h=box.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;
  let left=Math.min(Math.max(8,r.left),Math.max(8,vw-w-8));
  let top=r.bottom+6; if(top+h>vh-8) top=Math.max(8,r.top-h-6);
  box.style.left=left+"px"; box.style.top=top+"px"; box.style.visibility="";
}
function _dtWire(box,anchor){
  _dtPlace(box,anchor);
  document.addEventListener("pointerdown",_dtDocDown,true);
  document.addEventListener("keydown",_dtKey,true);
  window.addEventListener("scroll",_dtScroll,true);
  window.addEventListener("resize",closeDtPops);
  /* No auto-close timer: hover OPENS, explicit acts CLOSE (Apply /
     Clear / Done / year pick / outside press / Esc / scroll / resize /
     anchor re-click). A grace timer can never tell "reading the calendar"
     from "walked away" — so it kept murdering slow picks mid-flow. */
}
function _dtCommitPreset(v){
  /* Arm the hidden preset select so renderAttendance honors the pick,
     then fire change so the existing reveal/sync/render flow runs. */
  try{
    const sel=document.getElementById("attDatePreset");
    if(sel){
      if(sel.value!==v) sel.value=v;
      try{ sel.dispatchEvent(new Event("change",{bubbles:true})); }
      catch(e){ try{ const ev=document.createEvent("HTMLEvents"); ev.initEvent("change",true,false); sel.dispatchEvent(ev); }catch(_){} }
    }
  }catch(e){}
}
function acadYearOptions(){
  const out=[];
  const m=/^(\d{4})/.exec((typeof Settings!=="undefined"&&Settings&&Settings.academicYear)||"");
  const y0=m?+m[1]:new Date().getFullYear();
  const sm=/^(\d{4})-(\d{2})-(\d{2})$/.exec((typeof Settings!=="undefined"&&Settings&&Settings.startDate)||"");
  const mo=sm?+sm[2]:8, dy=sm?+sm[3]:14;
  for(let y=y0;y>y0-3;y--){
    const e=new Date(y+1,mo-1,dy); e.setDate(e.getDate()-1);
    out.push({label:y+"–"+String(y+1).slice(2),from:_iso(y,mo,dy),to:_iso(e.getFullYear(),e.getMonth()+1,e.getDate())});
  }
  return out;
}
function openAcadPop(anchor){
  const key="A:"+((anchor&&anchor.dataset&&anchor.dataset.v)||"");
  if(_dtOpenFor===key) return; _dtOpenFor=key;
  const box=_dtShell(); box._dtAnchor=anchor;
  const head=document.createElement("div"); head.className="dt-head";
  const title=document.createElement("div"); title.className="dt-title"; title.textContent="Academic year";
  head.appendChild(title); box.appendChild(head);
  const curLbl=String((typeof Settings!=="undefined"&&Settings&&Settings.academicYear)||"");
  acadYearOptions().forEach(opt=>{
    const b=document.createElement("button"); b.type="button"; b.className="dt-acad-btn";
    const cur=(attAcadFrom===opt.from&&attAcadTo===opt.to)||(!attAcadFrom&&curLbl.indexOf(String(opt.label).slice(0,4))===0);
    if(cur) b.classList.add("sel");
    const m1=document.createElement("span"); m1.className="dt-acad-main"; m1.textContent=opt.label;
    const m2=document.createElement("span"); m2.className="dt-acad-sub"; m2.textContent=_fmtShort(opt.from)+" → "+_fmtShort(opt.to);
    b.appendChild(m1); b.appendChild(m2);
    b.addEventListener("click",()=>{ attAcadFrom=opt.from; attAcadTo=opt.to; _dtCommitPreset("academic"); try{renderAttendance();}catch(e){ console.error(e); } closeDtPops(); });
    box.appendChild(b);
  });
  const foot=document.createElement("div"); foot.className="dt-foot";
  const clear=document.createElement("button"); clear.type="button"; clear.textContent="Clear";
  clear.addEventListener("click",()=>{ attAcadFrom=attAcadTo=null; try{renderAttendance();}catch(e){ console.error(e); } closeDtPops(); });
  const done=document.createElement("button"); done.type="button"; done.textContent="Done";
  done.addEventListener("click",closeDtPops);
  foot.appendChild(clear); foot.appendChild(done); box.appendChild(foot);
  _dtWire(box,anchor);
}
function _monthGrid(box,label,view,onPick,isSel){
  if(label){ const sec=document.createElement("div"); sec.className="dt-sec"; sec.textContent=label; box.appendChild(sec); }
  const head=document.createElement("div"); head.className="dt-head";
  const title=document.createElement("div"); title.className="dt-title"; title.style.fontSize="10.5px";
  const nav=document.createElement("div"); nav.className="dt-nav";
  const prev=document.createElement("button"); prev.type="button"; prev.textContent="‹";
  const next=document.createElement("button"); next.type="button"; next.textContent="›";
  nav.appendChild(prev); nav.appendChild(next); head.appendChild(title); head.appendChild(nav); box.appendChild(head);
  const grid=document.createElement("div"); grid.className="dt-grid"; box.appendChild(grid);
  function draw(){
    title.textContent=MONTHS_L[view.m]+" "+view.y;
    grid.innerHTML="";
    ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d=>{ const s=document.createElement("div"); s.className="dt-dow"; s.textContent=d; grid.appendChild(s); });
    const first=new Date(view.y,view.m,1).getDay(), dim=new Date(view.y,view.m+1,0).getDate(), dpm=new Date(view.y,view.m,0).getDate();
    for(let i=first-1;i>=0;i--) addDay(dpm-i,true);
    for(let d=1;d<=dim;d++) addDay(d,false);
    const tail=(7-((first+dim)%7))%7;
    for(let d=1;d<=tail;d++) addDay(d,true);
  }
  function addDay(d,out){
    const b=document.createElement("button"); b.type="button"; b.className="dt-day"+(out?" out":""); b.textContent=d;
    const dt=new Date(view.y,view.m+(out?(d>15?-1:1):0),d);
    const iso=_iso(dt.getFullYear(),dt.getMonth()+1,dt.getDate());
    if(isSel(iso)) b.classList.add("sel");
    b.addEventListener("click",()=>{ onPick(iso); });
    grid.appendChild(b);
  }
  prev.addEventListener("click",()=>{ view.m--; if(view.m<0){view.m=11;view.y--;} draw(); });
  next.addEventListener("click",()=>{ view.m++; if(view.m>11){view.m=0;view.y++;} draw(); });
  draw();
  return draw;
}
function openRangePop(anchor){
  const key="R:"+((anchor&&anchor.dataset&&anchor.dataset.v)||"");
  if(_dtOpenFor===key) return; _dtOpenFor=key;
  const t=new Date();
  let from=(typeof attFromDate!=="undefined"&&attFromDate&&attFromDate.value)||"", to=(typeof attToDate!=="undefined"&&attToDate&&attToDate.value)||"";
  let pickingTo=!!(from&&!to);
  const box=_dtShell(); box._dtAnchor=anchor;
  const head=document.createElement("div"); head.className="dt-head";
  const title=document.createElement("div"); title.className="dt-title"; title.textContent="Custom range";
  head.appendChild(title); box.appendChild(head);
  const hint=document.createElement("div"); hint.className="dt-sec"; hint.style.marginTop="0";
  box.appendChild(hint);
  const base=from||_iso(t.getFullYear(),t.getMonth()+1,t.getDate());
  const bm=/^(\d{4})-(\d{2})-(\d{2})$/.exec(base)||[0,t.getFullYear(),t.getMonth()+1,t.getDate()];
  const view={y:+bm[1],m:+bm[2]-1};
  function paintHint(){
    hint.textContent=!from?"Tap the start day":(!to?"Tap the end day":_fmtShort(from)+" → "+_fmtShort(to));
  }
  const inSel=iso=>((from&&to&&iso>=from&&iso<=to)||(from&&!to&&iso===from)||(!from&&to&&iso===to));
  const redraw=_monthGrid(box,"",view,iso=>{
    if(!pickingTo){ from=iso; to=""; pickingTo=true; }
    else { to=iso; if(from>to){ const x=from; from=to; to=x; } pickingTo=false; }
    paintHint(); redraw();
  },inSel);
  paintHint();
  const foot=document.createElement("div"); foot.className="dt-foot";
  const clear=document.createElement("button"); clear.type="button"; clear.textContent="Clear";
  clear.addEventListener("click",()=>{ try{ if(attFromDate)attFromDate.value=""; if(attToDate)attToDate.value=""; renderAttendance(); }catch(e){ console.error(e); } closeDtPops(); });
  const apply=document.createElement("button"); apply.type="button"; apply.textContent="Apply";
  apply.addEventListener("click",()=>{
    if(!from) from=_iso(t.getFullYear(),t.getMonth()+1,t.getDate());
    if(!to) to=from;
    if(from>to){ const x=from; from=to; to=x; }
    try{ if(attFromDate)attFromDate.value=from; if(attToDate)attToDate.value=to; _dtCommitPreset("custom_range"); try{renderAttendance();}catch(e){ console.error(e); } }catch(e){ console.error(e); }
    closeDtPops();
  });
  foot.appendChild(clear); foot.appendChild(apply); box.appendChild(foot);
  _dtWire(box,anchor);
}
/* Frosted tooltip engine — RETIRED per user call (no hover warnings
   anywhere). Kept as a no-op shell so nothing references missing code. */
/* Custom frost date/time picker — replaces native popups (browser chrome
   can never wear the theme). Trigger glyph + portalled popup, same
   architecture as the gsel dropdowns. Typing stays native; the picker
   only writes well-formed values (date YYYY-MM-DD, time HH:MM 24h)
   and fires input+change so all existing save flows keep working. */
(function(){
  if(window.__frostDtInit) return; window.__frostDtInit=true;
  let popEl=null, popInput=null, popType=null;
  const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const pad=n=>(n<10?"0":"")+n;
  const viewKey={};
  function closePop(){
    if(popEl){ try{ popEl.remove(); }catch(e){} popEl=null; popInput=null; popType=null; }
    document.removeEventListener("pointerdown",onDocDown,true);
    document.removeEventListener("keydown",onKey,true);
    window.removeEventListener("scroll",onScroll,true);
    window.removeEventListener("resize",closePop);
  }
  function onDocDown(e){ if(popEl && !popEl.contains(e.target) && !(popInput&&popInput._dtTrig&&popInput._dtTrig.contains(e.target))) closePop(); }
  /* Column scrolls bubble to window: only a scroll OUTSIDE the popup closes */
  function onScroll(e){ if(popEl && e.target && !popEl.contains(e.target)) closePop(); }
  function onKey(e){ if(e.key==="Escape"){ e.preventDefault(); closePop(); if(popInput){ try{ popInput.focus(); }catch(_){} } } }
  function commit(input,val){
    input.value=val;
    try{ input.dispatchEvent(new Event("input",{bubbles:true})); }catch(e){}
    try{ input.dispatchEvent(new Event("change",{bubbles:true})); }catch(e){}
  }
  function place(input){
    if(!popEl) return;
    const r=input.getBoundingClientRect();
    popEl.style.visibility="hidden"; popEl.style.left="0px"; popEl.style.top="0px";
    const w=popEl.offsetWidth, h=popEl.offsetHeight, vw=window.innerWidth, vh=window.innerHeight;
    let left=Math.min(Math.max(8,r.left),Math.max(8,vw-w-8));
    let top=r.bottom+6; if(top+h>vh-8) top=Math.max(8,r.top-h-6);
    popEl.style.left=left+"px"; popEl.style.top=top+"px"; popEl.style.visibility="";
  }
  function openPop(input,type){
    if(popEl && popInput===input && popType===type){ closePop(); return; }
    closePop();
    popInput=input; popType=type;
    popEl=document.createElement("div"); popEl.className="dt-pop"; popEl.setAttribute("role","dialog");
    if(type==="date") buildDate(popEl,input); else buildTime(popEl,input);
    document.body.appendChild(popEl); place(input);
    document.addEventListener("pointerdown",onDocDown,true);
    document.addEventListener("keydown",onKey,true);
    window.addEventListener("scroll",onScroll,true);
    window.addEventListener("resize",closePop);
  }
  function parseDate(v){ const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(v||""); if(!m) return null; const d=new Date(+m[1],+m[2]-1,+m[3]); return isNaN(d)?null:d; }
  function buildDate(box,input){
    const today=new Date(); today.setHours(0,0,0,0);
    let sel=parseDate(input.value);
    let vk=input.id||input.name||"dt";
    let view=viewKey[vk];
    if(!view){ const base=sel||today; view={y:base.getFullYear(),m:base.getMonth()}; }
    const head=document.createElement("div"); head.className="dt-head";
    const title=document.createElement("div"); title.className="dt-title";
    const nav=document.createElement("div"); nav.className="dt-nav";
    const prev=document.createElement("button"); prev.type="button"; prev.textContent="‹ Prev";
    const next=document.createElement("button"); next.type="button"; next.textContent="Next ›";
    prev.addEventListener("click",()=>{ view.m--; if(view.m<0){view.m=11;view.y--;} draw(); });
    next.addEventListener("click",()=>{ view.m++; if(view.m>11){view.m=0;view.y++;} draw(); });
    nav.appendChild(prev); nav.appendChild(next); head.appendChild(title); head.appendChild(nav); box.appendChild(head);
    const grid=document.createElement("div"); grid.className="dt-grid"; box.appendChild(grid);
    const foot=document.createElement("div"); foot.className="dt-foot";
    const clear=document.createElement("button"); clear.type="button"; clear.textContent="Clear";
    const tBtn=document.createElement("button"); tBtn.type="button"; tBtn.textContent="Today";
    clear.addEventListener("click",()=>{ viewKey[vk]=view; commit(input,""); closePop(); });
    tBtn.addEventListener("click",()=>{ const t=new Date(); view={y:t.getFullYear(),m:t.getMonth()}; viewKey[vk]=view; commit(input,t.getFullYear()+"-"+pad(t.getMonth()+1)+"-"+pad(t.getDate())); closePop(); });
    foot.appendChild(clear); foot.appendChild(tBtn); box.appendChild(foot);
    function draw(){
      viewKey[vk]=view;
      title.textContent=MONTHS[view.m]+" "+view.y;
      grid.innerHTML="";
      ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(d=>{ const s=document.createElement("div"); s.className="dt-dow"; s.textContent=d; grid.appendChild(s); });
      const first=new Date(view.y,view.m,1).getDay(), dim=new Date(view.y,view.m+1,0).getDate(), dpm=new Date(view.y,view.m,0).getDate();
      for(let i=first-1;i>=0;i--) addDay(dpm-i,true);
      for(let d=1;d<=dim;d++) addDay(d,false);
      const tail=(7-((first+dim)%7))%7;
      for(let d=1;d<=tail;d++) addDay(d,true);
    }
    function addDay(d,out){
      const b=document.createElement("button"); b.type="button"; b.className="dt-day"+(out?" out":""); b.textContent=d;
      const dt=new Date(view.y,view.m+(out?(d>15?-1:1):0),d);
      if(dt.getTime()===today.getTime()) b.classList.add("today");
      if(sel&&dt.getFullYear()===sel.getFullYear()&&dt.getMonth()===sel.getMonth()&&dt.getDate()===sel.getDate()) b.classList.add("sel");
      b.addEventListener("click",()=>{ viewKey[vk]={y:dt.getFullYear(),m:dt.getMonth()}; commit(input,dt.getFullYear()+"-"+pad(dt.getMonth()+1)+"-"+pad(dt.getDate())); closePop(); });
      grid.appendChild(b);
    }
    draw();
  }
  function parseTime(v){ const m=/^(\d{1,2}):(\d{2})/.exec(v||""); if(!m) return null; const h=+m[1],mi=+m[2]; if(h>23||mi>59) return null; return {h:h,mi:mi}; }
  function buildTime(box,input){
    let cur=parseTime(input.value)||{h:8,mi:0};
    const head=document.createElement("div"); head.className="dt-head";
    const title=document.createElement("div"); title.className="dt-title"; title.textContent="Time";
    head.appendChild(title); box.appendChild(head);
    const cols=document.createElement("div"); cols.className="dt-cols"; box.appendChild(cols);
    const hCol=document.createElement("div"); hCol.className="dt-col";
    const mCol=document.createElement("div"); mCol.className="dt-col";
    const aCol=document.createElement("div"); aCol.className="dt-col";
    cols.appendChild(hCol); cols.appendChild(mCol); cols.appendChild(aCol);
    const foot=document.createElement("div"); foot.className="dt-foot";
    const clear=document.createElement("button"); clear.type="button"; clear.textContent="Clear";
    const done=document.createElement("button"); done.type="button"; done.textContent="Done";
    clear.addEventListener("click",()=>{ commit(input,""); closePop(); });
    done.addEventListener("click",closePop);
    foot.appendChild(clear); foot.appendChild(done); box.appendChild(foot);
    function h12(){ const h=cur.h%12; return h===0?12:h; }
    function isPM(){ return cur.h>=12; }
    function apply(){ commit(input,pad(cur.h)+":"+pad(cur.mi)); }
    function fill(col,items,selVal,onPick){
      col.innerHTML="";
      items.forEach(v=>{
        const b=document.createElement("button"); b.type="button"; b.textContent=v.label; if(v.val===selVal) b.classList.add("sel");
        b.addEventListener("click",()=>{ onPick(v.val); refresh(); apply(); });
        col.appendChild(b);
      });
    }
    function refresh(){
      fill(hCol,[1,2,3,4,5,6,7,8,9,10,11,12].map(h=>({label:pad(h),val:h})),h12(),v=>{ cur.h=(isPM()?12:0)+(v%12); });
      const mins=[]; for(let m=0;m<60;m+=5) mins.push({label:pad(m),val:m});
      if(cur.mi%5!==0) mins.push({label:pad(cur.mi),val:cur.mi});
      mins.sort((a,b)=>a.val-b.val);
      fill(mCol,mins,cur.mi,v=>{ cur.mi=v; });
      fill(aCol,[{label:"AM",val:0},{label:"PM",val:1}],isPM()?1:0,v=>{ const h=cur.h%12; cur.h=v?h+12:h; });
      [hCol,mCol,aCol].forEach(c=>{ const s=c.querySelector(".sel"); if(s){ try{ c.scrollTop=s.offsetTop-c.clientHeight/2+s.clientHeight/2; }catch(e){} } });
    }
    refresh();
  }
  function enhance(input){
    if(!input||(input.tagName!=="INPUT")||input.dataset.dt) return;
    const t=(input.type||"").toLowerCase(); if(t!=="time"&&t!=="date") return;
    input.dataset.dt="1";
    const wrap=document.createElement("span"); wrap.className="dt-wrap";
    try{ input.parentNode.insertBefore(wrap,input); wrap.appendChild(input); }catch(e){ return; }
    const trig=document.createElement("button"); trig.type="button"; trig.className="dt-trig";
    trig.textContent=(t==="date"?"\u25A6":"\u25F7");
    trig.setAttribute("aria-label",t==="date"?"Choose date":"Choose time");
    trig.setAttribute("tabindex","-1");
    trig.addEventListener("click",(e)=>{ e.preventDefault(); e.stopPropagation(); try{ input.focus(); }catch(_){} openPop(input,t); });
    wrap.appendChild(trig); input._dtTrig=trig;
  }
  function enhanceAll(root){ try{ (root||document).querySelectorAll('input[type="time"],input[type="date"]').forEach(enhance); }catch(e){} }
  enhanceAll(document);
  try{
    new MutationObserver((muts)=>{
      muts.forEach(m=>{ m.addedNodes.forEach(n=>{ if(!n||!n.querySelectorAll) return; if(n.tagName==="INPUT") enhance(n); enhanceAll(n); }); });
    }).observe(document.body,{childList:true,subtree:true});
  }catch(e){}
})();
