/* ------------------ SW register + update prompt ------------------ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(reg => {
      console.log('SW registered');
      const toast = document.getElementById('updateToast');
      function showUpdate(worker){
        toast.hidden = false;
        toast.onclick = () => {
          worker.postMessage({type:'SKIP_WAITING'});
        };
      }
      if (reg.waiting) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW?.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdate(newSW);
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // new SW took over; reload to apply
        location.reload();
      });
    })
    .catch(err => console.warn('SW registration failed', err));
}

/* ------------------ Splash hide ------------------ */
window.addEventListener('load', () => {
  setTimeout(() => document.getElementById('splash').classList.add('hidden'), 250);
});

/* ------------------ Helpers ------------------ */
function todayISO(){ const d=new Date(); return d.toISOString().slice(0,10); }
function extractDigits(s){ return (s && s.match(/\d+/g)) ? s.match(/\d+/g).join('') : ''; }
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

/* ----- IATA license plate (10-digit) check-digit (weights 7-3-1 over first 9) ----- */
function validIATATag10(digits){
  if (!/^\d{10}$/.test(digits)) return false;
  const w = [7,3,1]; let sum=0;
  for(let i=0;i<9;i++) sum += (+digits[i]) * w[i%3];
  return (sum % 10) === +digits[9];
}

/* Normalize + validate:
   - prefer 10-digit with valid check digit
   - allow 13-digit (kept permissive for GS1 variants)
*/
function normalizeBaggageCode(raw){
  const d = extractDigits(raw);
  if (d.length === 10 && validIATATag10(d)) return d;
  if (d.length === 13) return d; // permissive for GS1/EAN-13 style flows
  return '';
}

/* ------------------ Fragment join for split HID scans ------------------ */
// Split-label assembly (combine two halves within window)
// Safer: unique digits set; only join if total length 10/13; prefer exact halves.
const FRAG_WINDOW_MS = 1000;
let fragBuffer = []; // {digits, ts}
function addFragment(d){
  const now=Date.now();
  fragBuffer.push({digits:d, ts:now});
  const seen = new Set();
  fragBuffer = fragBuffer
    .filter(f => now - f.ts <= FRAG_WINDOW_MS)
    .filter(f => (seen.has(f.digits) ? false : (seen.add(f.digits), true)))
    .slice(-10);
}
function tryAssemble(){
  if (fragBuffer.length < 2) return '';
  const recent = fragBuffer.slice().sort((a,b)=>b.ts-a.ts).map(f=>f.digits);
  for (let i=0;i<recent.length;i++){
    for (let j=i+1;j<recent.length;j++){
      const a = recent[i], b = recent[j];
      if (a===b) continue;
      const ab = a+b, ba=b+a;
      const isHalf = Math.abs(a.length - b.length) <= 1; // tolerate near-halves
      if (isHalf && (ab.length===10 || ab.length===13)) return ab;
      if (isHalf && (ba.length===10 || ba.length===13)) return ba;
    }
  }
  // fallback: if any single is 10(valid) or 13
  for (const d of recent){
    if (d.length===10 && validIATATag10(d)) return d;
    if (d.length===13) return d;
  }
  return '';
}

/* ------------------ Persistent storage ------------------ */
const PKEY = 'bagvoyage_prefs';
function loadPrefs(){
  try { return JSON.parse(localStorage.getItem(PKEY)||'{}'); } catch { return {}; }
}
function savePrefs(p){ try { localStorage.setItem(PKEY, JSON.stringify(p||{})); } catch {} }

const SKEY = 'bagvoyage_sessions';
const CUR  = 'bagvoyage_current_session';
function loadSessions(){
  try { return JSON.parse(localStorage.getItem(SKEY)||'[]'); } catch { return []; }
}
function saveSessions(a){ try { localStorage.setItem(SKEY, JSON.stringify(a||[])); } catch {} }
function sessionIdOf(dateISO, flight){
  const f = (flight||'').trim().toUpperCase().replace(/\s+/g,'');
  const d = (dateISO||todayISO()).replace(/-/g,'');
  return `${d}_${f||'UNKNOWN'}`;
}
function getCurrentSessionId(){ return localStorage.getItem(CUR)||''; }
function setCurrentSessionId(id){ if (id) localStorage.setItem(CUR,id); }

function tagsKey(id){ return `bagvoyage_tags_${id}`; }
function loadTags(id){
  try { return JSON.parse(localStorage.getItem(tagsKey(id))||'[]'); } catch { return []; }
}
function saveTags(id, arr){ try { localStorage.setItem(tagsKey(id), JSON.stringify(arr||[])); } catch {} }

function sessionMeta(id){
  const tags = loadTags(id);
  const total = tags.length;
  const matched = tags.filter(t=>!!t.matched).length;
  return { total, matched };
}

/* TTL cleanup (e.g., 48h) */
function cleanupOldSessions(hours=48){
  const sessions = loadSessions();
  const cutoff = Date.now() - hours*3600*1000;
  const keep = sessions.filter(s => (s.openedAt||0) >= cutoff);
  if (keep.length !== sessions.length){
    // delete tag buckets of removed sessions
    const removed = sessions.filter(s => !keep.includes(s));
    removed.forEach(s => { try { localStorage.removeItem(tagsKey(s.id)); } catch{} });
    saveSessions(keep);
    if (getCurrentSessionId() && !keep.find(s=>s.id===getCurrentSessionId())){
      localStorage.removeItem(CUR);
    }
  }
}

/* ------------------ DOM refs ------------------ */
const $home = document.getElementById('home');
const $scan = document.getElementById('scan');
const $title = document.getElementById('modeTitle');
const $video = document.getElementById('preview');
const $sheet = document.getElementById('sheet');
const $pill = document.getElementById('pill');
const $sheetTitle = document.getElementById('sheetTitle');
const $sheetCode = document.getElementById('sheetCode');
const $btnContinue = document.getElementById('btnContinue');
const $toast = document.getElementById('toast');
const $dbDot = document.getElementById('dbDot');
const $dbLabel = document.getElementById('dbLabel');
const $camDot = document.getElementById('camDot');
const $camLabel = document.getElementById('camLabel');
const $manualDlg = document.getElementById('manualDialog');
const $manualInput = document.getElementById('manualInput');
const $savedTick = document.getElementById('savedTick');
const $scannerInput = document.getElementById('scannerInput');
const $ptr = document.getElementById('ptrIndicator');
const $torchBtn = document.getElementById('btnTorch');
const $countersBtn = document.getElementById('btnCounters');
const $countMatched = document.getElementById('countMatched');
const $countTotal = document.getElementById('countTotal');
const $listDlg = document.getElementById('listDialog');
const $listBody = document.getElementById('listBody');
const $listMatched = document.getElementById('listMatched');
const $listTotal = document.getElementById('listTotal');

const $currentSessionCard = document.getElementById('currentSessionCard');
const $currentSessionInfo = document.getElementById('currentSessionInfo');
const $btnTag = document.getElementById('btnTag');
const $btnRetrieve = document.getElementById('btnRetrieve');
const $btnManual = document.getElementById('btnManual');
const $btnExport = document.getElementById('btnExport');
const $btnCloseSession = document.getElementById('btnCloseSession');
const $sessionsList = document.getElementById('sessionsList');
const $newSessionForm = document.getElementById('newSessionForm');
const $flightInput = document.getElementById('flightInput');
const $dateInput = document.getElementById('dateInput');

/* ------------------ UI basics ------------------ */
setTimeout(()=>{ $dbDot.className='dot ok'; $dbLabel.textContent='DB: online (local)'; }, 300);

const vibrate = p => { try{ navigator.vibrate && navigator.vibrate(p) }catch{} };
const toast = (msg, ms=900) => { $toast.textContent=msg; $toast.classList.add('show'); setTimeout(()=>$toast.classList.remove('show'), ms); };
function showSavedTick(ms = 900){
  $savedTick.classList.add('show');
  setTimeout(()=> $savedTick.classList.remove('show'), ms);
}
function setCamStatus(active){
  if(active){ $camDot.className='dot ok'; $camLabel.textContent='Camera: active'; }
  else { $camDot.className='dot'; $camLabel.textContent='Camera: idle'; }
}

/* ------------------ Session UI ------------------ */
function refreshCurrentSessionUI(){
  const sid = getCurrentSessionId();
  if (!sid){
    $currentSessionInfo.textContent = 'No active session';
    [$btnTag,$btnRetrieve,$btnManual,$btnExport,$btnCloseSession].forEach(b=> b.disabled = true);
    $countMatched.textContent='0'; $countTotal.textContent='0';
    $countersBtn.disabled = true;
    return;
  }
  const sessions = loadSessions();
  const s = sessions.find(x=>x.id===sid);
  const meta = sessionMeta(sid);
  $currentSessionInfo.textContent = `${s.flight} on ${s.date} — ${meta.matched}/${meta.total} matched`;
  [$btnTag,$btnRetrieve,$btnManual,$btnExport,$btnCloseSession].forEach(b=> b.disabled = false);
  $countMatched.textContent = meta.matched;
  $countTotal.textContent = meta.total;
  $countersBtn.disabled = false;
}
function renderSessionsList(){
  const sessions = loadSessions().sort((a,b)=>b.openedAt-a.openedAt);
  const cur = getCurrentSessionId();
  $sessionsList.innerHTML = sessions.map(s=>{
    const meta = sessionMeta(s.id);
    const title = `${s.flight} • ${s.date}`;
    const active = (s.id === cur);
    return `
      <div class="session-item">
        <div class="session-meta">
          <div class="session-title">${title}</div>
          <div>${meta.matched}/${meta.total} matched</div>
        </div>
        <div class="row gap">
          <button data-sid="${s.id}" class="btn ${active?'primary':'ghost'} act-switch">${active?'Active':'Switch'}</button>
          <button data-sid="${s.id}" class="btn ghost act-export">Export</button>
          <button data-sid="${s.id}" class="btn ghost act-close">Close</button>
        </div>
      </div>
    `;
  }).join('') || `<div class="muted">No recent sessions</div>`;

  $sessionsList.querySelectorAll('.act-switch').forEach(btn=>{
    btn.onclick = () => { setCurrentSessionId(btn.dataset.sid); refreshCurrentSessionUI(); toast('Session switched'); };
  });
  $sessionsList.querySelectorAll('.act-export').forEach(btn=>{
    btn.onclick = () => exportCSV(btn.dataset.sid);
  });
  $sessionsList.querySelectorAll('.act-close').forEach(btn=>{
    btn.onclick = () => closeSession(btn.dataset.sid);
  });
}

/* Create/switch session */
$dateInput.value = todayISO();
$newSessionForm.addEventListener('submit', (e)=>{
  e.preventDefault();
  const flight = ($flightInput.value||'').trim().toUpperCase();
  const date   = $dateInput.value || todayISO();
  if (!flight){ toast('Enter flight number'); return; }
  const id = sessionIdOf(date, flight);
  let sessions = loadSessions();
  if (!sessions.find(s=>s.id===id)){
    sessions.push({ id, flight, date, openedAt: Date.now() });
    saveSessions(sessions);
  }
  setCurrentSessionId(id);
  refreshCurrentSessionUI();
  renderSessionsList();
  toast('Session ready');
});

function closeSession(id){
  const cur = getCurrentSessionId();
  let sessions = loadSessions();
  sessions = sessions.filter(s=>s.id!==id);
  saveSessions(sessions);
  try { localStorage.removeItem(tagsKey(id)); } catch {}
  if (cur === id) localStorage.removeItem(CUR);
  refreshCurrentSessionUI();
  renderSessionsList();
  toast('Session closed');
}

/* Export CSV */
function exportCSV(id){
  const sid = id || getCurrentSessionId();
  if (!sid){ toast('No session'); return; }
  const sessions = loadSessions();
  const s = sessions.find(x=>x.id===sid) || {flight:'UNKNOWN', date: todayISO()};
  const rows = loadTags(sid)
    .map(t=>({code:t.code, matched: !!t.matched, ts: new Date(t.ts).toISOString()}));
  const header = 'code,matched,ts\n';
  const body = rows.map(r=>`${r.code},${r.matched},${r.ts}`).join('\n');
  const blob = new Blob([header+body], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bagvoyage_${s.date}_${s.flight}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* Session buttons on current card */
$btnExport.onclick = () => exportCSV();
$btnCloseSession.onclick = () => {
  const sid = getCurrentSessionId(); if (!sid) return;
  closeSession(sid);
};

/* ------------------ Scan screen state ------------------ */
let isScanning = false, mode = null, currentTrack = null;
let lastRead = { code:null, ts:0 };
let scanCooldownUntil = 0;
let isTorchOn = false;

/* history for undo last match */
let matchHistory = []; // {code, ts}

/* ------------------ Torch & camera helpers ------------------ */
async function hasImageCaptureTorch(track){
  try {
    if (!('ImageCapture' in window) || !track || track.kind !== 'video') return false;
    const ic = new ImageCapture(track);
    const caps = await ic.getPhotoCapabilities().catch(() => null);
    return !!(caps && Array.isArray(caps.fillLightMode) && caps.fillLightMode.includes('torch'));
  } catch { return false; }
}
function hasTrackTorch(track){
  try {
    const caps = track?.getCapabilities?.();
    return !!(caps && 'torch' in caps);
  } catch { return false; }
}
async function setTorch(on){
  if (!currentTrack) return false;
  try{
    if (await hasImageCaptureTorch(currentTrack)) {
      const ic = new ImageCapture(currentTrack);
      await ic.setOptions({ torch: !!on });
      isTorchOn = !!on;
    } else if (hasTrackTorch(currentTrack)) {
      await currentTrack.applyConstraints({ advanced: [{ torch: !!on }] });
      isTorchOn = !!on;
    } else {
      isTorchOn = false;
      return false;
    }
    $torchBtn.textContent = isTorchOn ? 'Torch Off' : 'Torch On';
    $torchBtn.setAttribute('aria-pressed', String(isTorchOn));
    // persist preference
    const p = loadPrefs(); p.torchPreferred = isTorchOn; savePrefs(p);
    return true;
  } catch (e){
    console.warn('Torch control failed:', e);
    return false;
  }
}
async function updateTorchUI(){
  if (!currentTrack) { $torchBtn.disabled = true; $torchBtn.title = 'Camera not ready'; return; }
  const supported = await hasImageCaptureTorch(currentTrack) || hasTrackTorch(currentTrack);
  $torchBtn.disabled = !supported;
  $torchBtn.title = supported ? 'Toggle torch' : 'Torch not supported by this camera';
  $torchBtn.setAttribute('aria-disabled', String(!supported));
  if (!supported) {
    isTorchOn = false;
    $torchBtn.textContent = 'Torch';
    $torchBtn.setAttribute('aria-pressed', 'false');
  }
}

/* ---------- Camera selection (prefer torch-capable back camera) ---------- */
async function getBestBackCameraStream(){
  const prefs = loadPrefs();
  // If we have a last device, try it first
  if (prefs.lastCameraId){
    const s = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: prefs.lastCameraId } }, audio: false
    }).catch(()=>null);
    if (s) return s;
  }

  // Provisional stream to unlock labels
  const provisional = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } }, audio: false
  }).catch(() => null);

  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const candidates = [];
  for (const d of devices) {
    const label = (d.label || '').toLowerCase();
    const isBack = /back|rear|environment/.test(label);
    candidates.push({ deviceId: d.deviceId, score: isBack ? 2 : 1, label });
  }
  candidates.sort((a,b) => b.score - a.score);

  for (const c of candidates) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: c.deviceId },
        width:{ ideal:1920, min:1280 },
        height:{ ideal:1080,  min:720 },
        aspectRatio:{ ideal:16/9 },
        frameRate:{ ideal:30,  min:15 }
      },
      audio:false
    }).catch(() => null);

    if (!stream) continue;

    const track = stream.getVideoTracks()[0];
    const supports = hasTrackTorch(track) || await hasImageCaptureTorch(track);
    if (supports) {
      if (provisional && provisional !== stream) provisional.getTracks().forEach(t => t.stop());
      return stream;
    }
    stream.getTracks().forEach(t => { try{ t.stop(); }catch{} });
  }

  if (provisional) return provisional;

  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode:{ ideal:'environment' },
      width:{ ideal:1920, min:1280 }, height:{ ideal:1080, min:720 },
      aspectRatio:{ ideal:16/9 }, frameRate:{ ideal:30, min:15 }
    },
    audio:false
  });
}

/* ------------------ Result sheet ------------------ */
function openSheet(kind, title, code, wait){
  // Reset Continue listener
  $btnContinue.replaceWith($btnContinue.cloneNode(true));
  const freshBtn = document.getElementById('btnContinue');
  freshBtn.addEventListener('click', onContinue, { once:true });

  $pill.className = 'pill ' + (kind==='ok'?'ok':'bad');
  $pill.textContent = kind==='ok' ? 'MATCH' : 'UNMATCHED';
  $sheetTitle.textContent = title;
  $sheetCode.textContent = code;

  freshBtn.classList.toggle('hidden', !wait);
  freshBtn.setAttribute('tabindex', wait ? '0' : '-1');

  $sheet.classList.add('show');
  if (!wait) setTimeout(()=> $sheet.classList.remove('show'), 800);
  if (wait) freshBtn.focus();
}
function hideSheet(){
  $sheet.classList.remove('show');
}

/* ------------------ UI helpers ------------------ */
function showHome(){
  $scan.classList.add('hidden');
  $home.classList.remove('hidden');
  mode=null;
  setCamStatus(false);
  $scan.classList.remove('active');
  hideSheet();
}
function showScan(m){
  mode=m;
  $title.textContent = m==='tag'?'Tag — scanning':'Retrieve — scan to verify';
  $home.classList.add('hidden');
  $scan.classList.remove('hidden');
  $scan.classList.add('active');
  focusScannerInput(); // for HID scanners
}

/* ------------------ Camera start/stop ------------------ */
async function startScan(m){
  if (isScanning) return;
  if (!getCurrentSessionId()){ toast('Create/select a session first'); return; }
  showScan(m);
  isScanning = true;
  setCamStatus(true);

  await stopCamera();
  try{
    const stream = await getBestBackCameraStream();
    $video.srcObject = stream;
    await $video.play().catch(()=>{});
    if ($video.readyState < 2) {
      await new Promise(res => $video.addEventListener('loadedmetadata', res, { once:true }));
    }
    currentTrack = stream.getVideoTracks()[0] || null;

    // remember device for future
    try {
      const settings = currentTrack?.getSettings?.() || {};
      if (settings.deviceId){
        const p = loadPrefs(); p.lastCameraId = settings.deviceId; savePrefs(p);
      }
    } catch {}

    await updateTorchUI();

    // Apply mid zoom if supported (helps iOS)
    try {
      const caps = currentTrack.getCapabilities?.() || {};
      if ('zoom' in caps) {
        const mid = caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.5;
        await currentTrack.applyConstraints({ advanced: [{ zoom: mid }] }).catch(()=>{});
      }
    } catch {}

    // ---------- Prefer native BarcodeDetector on non-iOS ----------
    const canUseNative =
      !isIOS() &&
      'BarcodeDetector' in window &&
      typeof BarcodeDetector === 'function';

    if (canUseNative) {
      let supported = [];
      try { supported = await BarcodeDetector.getSupportedFormats(); } catch {}
      const wanted = ['code_128', 'itf', 'ean_13', 'ean_8', 'upc_a', 'qr_code'];
      const formats = wanted.filter(f => supported.includes(f));
      if (formats.length) {
        const detector = new BarcodeDetector({ formats });
        let running = true;
        const MIN_INTERVAL = 70; // throttle
        let last = 0;

        const rvfc = $video.requestVideoFrameCallback?.bind($video)
          || (cb => setTimeout(()=>cb(performance.now(), {presentedFrames:0}), 33));

        const frameLoop = async () => {
          if (!isScanning || !running) return;
          const now = performance.now();
          if ((now - last) < MIN_INTERVAL || Date.now() < scanCooldownUntil) {
            rvfc(() => frameLoop());
            return;
          }
          try {
            const codes = await detector.detect($video);
            if (codes && codes.length) {
              const value = (codes[0].rawValue || '').trim();
              if (value) {
                scanCooldownUntil = Date.now() + 500;
                last = now;
                onScan(value);
              }
            }
          } catch (e) {
            console.warn('Native detect failed, falling back to ZXing once:', e);
            running = false;
            await startZXingDecode(); // single fallback init
            return;
          }
          rvfc(() => frameLoop());
        };
        rvfc(() => frameLoop());
        // keep a reference so stopCamera() can stop nicely if needed
        window.__bagvoyage_native_running__ = () => { running = false; };
        // apply torch pref
        const p = loadPrefs(); if (p.torchPreferred) setTimeout(()=>setTorch(true), 50);
        return; // native path active
      }
    }

    // ---------- ZXing fallback (or iOS path) ----------
    await startZXingDecode();
    // apply torch pref
    const p = loadPrefs(); if (p.torchPreferred) setTimeout(()=>setTorch(true), 50);
    return;

  }catch(e){
    console.error('[Bagvoyage] startScan error:', e);
    toast('Camera access failed: ' + (e?.message||e), 1500);
    await stopCamera();
    showHome();
  }
}

// ZXing init, bound to the SAME deviceId as currentTrack, with GS1 hint
async function startZXingDecode() {
  const ZXB = window.ZXingBrowser || {};
  const ReaderClass = ZXB.BrowserMultiFormatReader;
  if (!ReaderClass) throw new Error('ZXing library not loaded');

  const reader = new ReaderClass();
  const BF = ZXB.BarcodeFormat, HT = ZXB.DecodeHintType;
  let hints;
  if (BF && HT) {
    const fmts = [BF.ITF, BF.CODE_128, BF.EAN_13, BF.EAN_8, BF.UPC_A, BF.QR_CODE].filter(Boolean);
    hints = new Map();
    hints.set(HT.TRY_HARDER, true);
    hints.set(HT.POSSIBLE_FORMATS, fmts);
    hints.set(HT.ASSUME_GS1, true);
  }

  const settings = (currentTrack && currentTrack.getSettings) ? currentTrack.getSettings() : {};
  const deviceId = settings.deviceId || undefined;

  let lastTS = 0;
  await reader.decodeFromVideoDevice(
    deviceId,
    $video,
    (result, err) => {
      if (!isScanning || !result) return;
      const now = Date.now();
      if (now - lastTS < 70 || now < scanCooldownUntil) return;

      const raw = result.getText();
      if (!raw) return;

      const digits = extractDigits(raw);
      if (digits) addFragment(digits);
      const assembled = tryAssemble();
      const processed = normalizeBaggageCode(raw) || digits || raw;
      const payload   = assembled || processed;
      if (!payload) return;

      scanCooldownUntil = now + 500;
      fragBuffer = [];
      lastTS = now;
      onScan(payload);
    },
    hints
  );

  window.__bagvoyage_reader__ = reader;
}

async function stopCamera(){
  try { await setTorch(false); } catch {}
  try { window.__bagvoyage_native_running__ && window.__bagvoyage_native_running__(); } catch {}
  try { window.__bagvoyage_reader__?.reset?.(); } catch {}
  const stream = $video.srcObject;
  if (stream) {
    const tracks = stream.getVideoTracks();
    tracks.forEach(t => { try { t.stop(); } catch {} });
  }
  $video.pause();
  $video.srcObject = null;
  currentTrack = null;
  setCamStatus(false);
  await updateTorchUI().catch(()=>{});
}

function stopScan(){
  if(!isScanning) return;
  isScanning = false;
  hideSheet();
  stopCamera();
}

/* ------------------ Tags & matching ------------------ */
function currentTags(){ const sid = getCurrentSessionId(); return loadTags(sid); }
function writeCurrentTags(arr){ const sid = getCurrentSessionId(); saveTags(sid, arr); }
function existsInCurrent(code){
  const n = normalizeBaggageCode(code);
  if (!n) return false;
  return currentTags().some(x=>x.code===n);
}
function saveTag(code){
  const sid = getCurrentSessionId();
  const n = normalizeBaggageCode(code);
  if (!n) { toast('Invalid code'); return false; }
  const a = loadTags(sid);
  if (a.find(x=>x.code===n)) { toast('Already saved'); return false; }
  a.unshift({code:n, ts:Date.now(), matched:false});
  if (a.length > 2000) a.pop(); // guard
  saveTags(sid, a);
  updateCounters();
  return true;
}
function markMatched(code){
  const sid = getCurrentSessionId();
  const n = normalizeBaggageCode(code);
  if (!n) return false;
  const a = loadTags(sid);
  const item = a.find(x=>x.code===n);
  if (!item) return false;
  if (!item.matched){
    item.matched = true;
    item.matchedTs = Date.now();
    matchHistory.push({code:n, ts:item.matchedTs});
    saveTags(sid, a);
    updateCounters();
  }
  return true;
}
function undoLastMatch(){
  const sid = getCurrentSessionId();
  const a = loadTags(sid);
  while (matchHistory.length){
    const last = matchHistory.pop();
    const item = a.find(x=>x.code===last.code && x.matchedTs===last.ts);
    if (item && item.matched){ item.matched=false; delete item.matchedTs; saveTags(sid,a); updateCounters(); return true; }
  }
  return false;
}
function updateCounters(){
  const sid = getCurrentSessionId();
  const {total, matched} = sessionMeta(sid);
  $countMatched.textContent = matched;
  $countTotal.textContent = total;
  $listMatched.textContent = matched;
  $listTotal.textContent = total;
  refreshCurrentSessionUI();
}

/* ------------------ Scan handler ------------------ */
async function onScan(text){
  const code = (text||'').trim();
  if(!code) return;
  const now = Date.now();
  if(code===lastRead.code && (now-lastRead.ts)<900) return; // de-dupe
  lastRead = { code, ts: now };

  if(mode==='tag'){
    if (saveTag(code)) {
      vibrate(30);
      showSavedTick();
      toast('Saved');
    }
  }else if(mode==='retrieve'){
    const ok = existsInCurrent(code);
    if(ok){
      // mark matched then show sheet
      markMatched(code);
      vibrate([40,60,40]);
      isScanning = false;           // allow startScan to proceed later
      await stopCamera();           // wait until tracks are fully stopped
      openSheet('ok','MATCH',normalizeBaggageCode(code),true); // show Continue
    } else {
      vibrate([30,40,30]);
      openSheet('bad','UNMATCHED',normalizeBaggageCode(code)||code,false); // auto-hide
    }
  }
}

/* ---------- Continue flow (restart retrieve) ---------- */
async function onContinue(e){
  if (e && e.preventDefault) e.preventDefault();
  hideSheet();
  isScanning = false;
  if (mode !== 'retrieve') mode = 'retrieve';
  await startScan('retrieve');
}

/* ------------------ HID scanner (keyboard wedge) ------------------ */
function focusScannerInput(){
  if (!isScanning || $manualDlg?.open || $listDlg?.open) return;
  const el = $scannerInput;
  if (document.activeElement !== el) el.focus();
}
window.addEventListener('click', focusScannerInput);
window.addEventListener('keydown', (e)=>{
  if (e.key === 'Tab') return;
  focusScannerInput();
});

let burstTimer;
const BURST_IDLE_MS = 60;
$scannerInput.addEventListener('keydown', (e)=>{
  clearTimeout(burstTimer);
  if (e.key === 'Enter') {
    const code = $scannerInput.value.trim();
    $scannerInput.value = '';
    if (code) onScan(code);
    e.preventDefault();
  } else {
    burstTimer = setTimeout(()=>{
      const code = $scannerInput.value.trim();
      if (code.length >= 8) onScan(code);
      $scannerInput.value = '';
    }, BURST_IDLE_MS);
  }
});

/* ------------------ Pull to refresh (disable while scanning) ------------------ */
(function enablePullToRefresh(){
  const THRESHOLD = 70;
  let startY = 0, pulling = false, activated = false;

  window.addEventListener('touchstart', (e) => {
    if (isScanning) return; // locked during scanning
    if (document.scrollingElement.scrollTop === 0) {
      startY = e.touches[0].clientY;
      pulling = true; activated = false;
    } else pulling = false;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling || isScanning) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) {
      if (dy > THRESHOLD && !activated) {
        $ptr.classList.add('active');
        activated = true;
      } else if (dy <= THRESHOLD && activated) {
        $ptr.classList.remove('active');
        activated = false;
      }
    }
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (pulling && activated) {
      $ptr.classList.remove('active');
      setTimeout(() => window.location.reload(), 60);
    } else {
      $ptr.classList.remove('active');
    }
    pulling = false;
  });
})();

/* ------------------ Buttons / listeners ------------------ */
$torchBtn.addEventListener('click', async ()=>{
  const ok = await setTorch(!isTorchOn);
  if (!ok) updateTorchUI();
});
document.getElementById('btnStop').addEventListener('click', async ()=>{
  await stopScan();
  showHome();
});
document.getElementById('btnTag').addEventListener('click', ()=> startScan('tag'));
document.getElementById('btnRetrieve').addEventListener('click', ()=> startScan('retrieve'));
document.getElementById('btnManual').addEventListener('click', ()=>{
  $manualInput.value='';
  $manualDlg.showModal();
});
document.getElementById('manualApply').addEventListener('click', async (e)=>{
  e.preventDefault();
  const v = ($manualInput.value||'').trim();
  if(!v) return;
  if(!mode || mode==='tag'){
    if (saveTag(v)) { showSavedTick(); toast('Saved'); }
  }
  else {
    // ensure clean UI; await camera stop before opening sheet when MATCH
    const ok = existsInCurrent(v);
    if (ok) { await stopCamera(); markMatched(v); openSheet('ok','MATCH',normalizeBaggageCode(v),true); }
    else     openSheet('bad','UNMATCHED',normalizeBaggageCode(v)||v,false);
  }
  $manualDlg.close();
});

$countersBtn.addEventListener('click', ()=>{
  renderListDialog();
  $listDlg.showModal();
});
document.getElementById('btnUndoLast').addEventListener('click', ()=>{
  if (undoLastMatch()) { toast('Undone'); renderListDialog(); }
});

/* List rendering */
function renderListDialog(){
  const t = currentTags();
  $listBody.innerHTML = t.map(item=>{
    const status = item.matched ? '<span class="badge ok">MATCHED</span>' : '<span class="badge pending">PENDING</span>';
    const ts = new Date(item.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    return `<div class="list-item">
      <div>${item.code}</div>
      <div class="row gap">
        <span class="muted">${ts}</span>
        ${status}
      </div>
    </div>`;
  }).join('') || '<div class="muted" style="padding:10px">No items yet.</div>';
  updateCounters();
}

/* Lifecycle safety */
window.addEventListener('pagehide', () => { stopScan(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopScan();
  else if (mode) startScan(mode);
});

/* ------------------ Init ------------------ */
(function init(){
  cleanupOldSessions(48);
  refreshCurrentSessionUI();
  renderSessionsList();
})();
