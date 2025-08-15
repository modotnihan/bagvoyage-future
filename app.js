/* ------------------ SW register ------------------ */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js')
    .then(() => console.log('SW registered'))
    .catch(err => console.warn('SW registration failed', err));
}

/* ------------------ Splash hide ------------------ */
window.addEventListener('load', () => {
  setTimeout(() => document.getElementById('splash').classList.add('hidden'), 250);
});

/* ------------------ Helpers ------------------ */
function extractDigits(s){ return (s && s.match(/\d+/g)) ? s.match(/\d+/g).join('') : ''; }
function normalizeBaggageCode(s){
  const d = extractDigits(s);
  return (d.length === 10 || d.length === 13) ? d : '';
}
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isHoneywell(){
  const ua = (navigator.userAgent || '').toLowerCase();
  return /ct60|ct40|ct45|honeywell|intermec/.test(ua);
}

// Split-label assembly (combine two Code128 halves within 1s)
const FRAG_WINDOW_MS = 1000;
let fragBuffer = []; // {digits, ts}
function addFragment(d){
  const now=Date.now();
  fragBuffer.push({digits:d, ts:now});
  fragBuffer = fragBuffer.slice(-10).filter((f,i,a)=> now-f.ts<=FRAG_WINDOW_MS && (i===0 || f.digits!==a[i-1].digits));
}
function tryAssemble(){
  if (fragBuffer.length < 2) return '';
  const sorted = fragBuffer.slice().sort((a, b) => b.ts - a.ts);
  const [b, a] = sorted.slice(0, 2).map(f => f.digits);
  if (!a || !b || a === b) return '';
  const ab=a+b, ba=b+a;
  return (ab.length===10 || ab.length===13) ? ab :
         (ba.length===10 || ba.length===13) ? ba :
         (a.length===10 || a.length===13) ? a :
         (b.length===10 || b.length===13) ? b : '';
}

(async () => {
  try {
    await BV.signInAnon();
    const today = new Date().toISOString().slice(0,10);
    let flightNo = localStorage.getItem('bv_flight') || '';
    if (!flightNo) {
      flightNo = prompt('Enter flight number for this session (e.g., MU123)') || 'TEST001';
      localStorage.setItem('bv_flight', flightNo);
    }
    window.BV_SESSION_ID = await BV.ensureSession(today, flightNo);

    // live-merge tags from other devices into local cache
    BV.subscribeTags(window.BV_SESSION_ID, (code) => {
      const DBKEY='bagvoyage_tags';
      const a = JSON.parse(localStorage.getItem(DBKEY)||'[]');
      if (!a.some(x=>x.code===code)) {
        a.unshift({ code, ts: Date.now() });
        localStorage.setItem(DBKEY, JSON.stringify(a));
      }
    });
  } catch(e){ console.warn('Firebase init failed', e); }
})();


(function init(){
  if(window.__BAGVOYAGE_LOADED__){ console.warn('Bagvoyage already loaded.'); return; }
  window.__BAGVOYAGE_LOADED__ = true;

  // State
  let isScanning = false, mode = null, currentTrack = null;
  let lastRead = { code:null, ts:0 };
  let scanCooldownUntil = 0;
  let isTorchOn = false;
  let isContinuing = false;
  // Persist HID toggle; default ON on Honeywell
  let useHardwareScanner = JSON.parse(localStorage.getItem('bagvoyage_hid') ?? 'null');
  if (useHardwareScanner === null) useHardwareScanner = isHoneywell();

  // Local DB
  const DBKEY = 'bagvoyage_tags';
  const getAll = () => { try{return JSON.parse(localStorage.getItem(DBKEY)||'[]')}catch{return[]} };
  const saveTag = code => {
    const n = normalizeBaggageCode(code);
    if (!n) return;
    const a = getAll();
    if (a.length > 100) a.pop();
    a.unshift({code:n,ts:Date.now()});
    try { localStorage.setItem(DBKEY, JSON.stringify(a)); } catch (e) {
      console.error('Storage failed:', e);
      toast('Failed to save tag', 1000);
    }
    BV.saveTagServer(window.BV_SESSION_ID, n).catch(()=>{});

  };
  const exists  = code => getAll().some(x=>x.code===normalizeBaggageCode(code));

  // DOM
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
  const $hidBtn = document.getElementById('btnHID');

  // Status UI
  setTimeout(()=>{ $dbDot.className='dot ok'; $dbLabel.textContent='DB: online (local)'; }, 300);

  const vibrate = p => { try{ navigator.vibrate && navigator.vibrate(p) }catch{} };
  const toast = (msg, ms=800) => { $toast.textContent=msg; $toast.classList.add('show'); setTimeout(()=>$toast.classList.remove('show'), ms); };

  /* ---------- GLOBAL HID CAPTURE (no input focus, no soft keyboard) ---------- */
  let hidActive = false;
  let hidBuffer = '';
  let hidTimer = null;
  const HID_IDLE_MS = 60;

  function enableHIDCapture(){
    if (hidActive) return;
    hidActive = true;
    hidBuffer = '';
    // Ensure no focus on any input → prevents soft keyboard
    try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    // Gather printable keys
    document.addEventListener('keydown', onHIDKeyDown, true);
  }
  function disableHIDCapture(){
    if (!hidActive) return;
    hidActive = false;
    document.removeEventListener('keydown', onHIDKeyDown, true);
    hidBuffer = '';
    clearTimeout(hidTimer); hidTimer = null;
  }
  function onHIDKeyDown(e){
    if (!useHardwareScanner) return;
    // Ignore when modifiers pressed (except Shift for digits)
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // Enter ends the scan
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = hidBuffer.trim();
      hidBuffer = '';
      if (code) onScan(code);
      return;
    }

    // Collect digits/letters quickly; you can restrict to digits if you prefer
    if (e.key && e.key.length === 1) {
      const ch = e.key;
      // accept [0-9A-Za-z-_/+] etc if needed; we only need digits but fragments can arrive
      if (/^[0-9A-Za-z\-_/+]+$/.test(ch)) {
        hidBuffer += ch;
        clearTimeout(hidTimer);
        hidTimer = setTimeout(()=>{
          const code = hidBuffer.trim();
          hidBuffer = '';
          if (code.length >= 8) onScan(code);
        }, HID_IDLE_MS);
        // Don't let keystrokes type into focused elements if any
        e.preventDefault();
      }
    }
  }

  /* ---------- Torch capability & control ---------- */
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
    if (!currentTrack || useHardwareScanner) return false;
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
      return true;
    } catch (e){
      console.warn('Torch control failed:', e);
      return false;
    }
  }
  async function updateTorchUI(){
    if (useHardwareScanner) {
      $torchBtn.disabled = true;
      $torchBtn.title = 'Torch disabled in Hardware Scanner mode';
      $torchBtn.setAttribute('aria-disabled', 'true');
      $torchBtn.textContent = 'Torch';
      $torchBtn.setAttribute('aria-pressed', 'false');
      return;
    }
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
          width:{ ideal:1280, min:960 },
          height:{ ideal:720,  min:540 },
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
      stream.getTracks().forEach(t => t.stop());
    }

    if (provisional) return provisional;

    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode:{ ideal:'environment' },
        width:{ ideal:1280, min:960 }, height:{ ideal:720, min:540 },
        aspectRatio:{ ideal:16/9 }, frameRate:{ ideal:30, min:15 }
      },
      audio:false
    });
  }

  /* ---------- Result sheet (singleton) ---------- */
  function openSheet(kind, title, code, wait){
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
    if (!wait) setTimeout(()=> $sheet.classList.remove('show'), 900);
    if (wait) freshBtn.focus();
  }
  function hideSheet(){
    $sheet.classList.remove('show');
    isContinuing = false;
  }

  /* ---------- UI helpers ---------- */
  function setCamStatus(active){
    if(active){ $camDot.className='dot ok'; $camLabel.textContent='Camera: active'; }
    else { $camDot.className='dot'; $camLabel.textContent='Camera: idle'; }
  }
  function showSavedTick(ms = 900){
    $savedTick.classList.add('show');
    setTimeout(()=> $savedTick.classList.remove('show'), ms);
  }
  function showHome(){
    $scan.classList.add('hidden');
    $home.classList.remove('hidden');
    mode=null;
    setCamStatus(false);
    $scan.classList.remove('active');
    hideSheet();
    disableHIDCapture();
  }
  function showScan(m){
    mode=m;
    $title.textContent = m==='tag'?'Tag — scanning':'Retrieve — scan to verify';
    $home.classList.add('hidden');
    $scan.classList.remove('hidden');
    $scan.classList.add('active');
    if (useHardwareScanner) {
      disableHIDCapture(); // reset
      enableHIDCapture();  // start global capture (no focus)
    } else {
      disableHIDCapture();
    }
  }

  /* ---------- Camera start/stop ---------- */
  async function startScan(m){
    if (isScanning) return;
    showScan(m);

    // HID-only path
    if (useHardwareScanner) {
      isScanning = false;
      setCamStatus(false);
      await stopCamera();
      await updateTorchUI();
      return;
    }

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

      await updateTorchUI();

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

          const frameLoop = async () => {
            if (!isScanning || !running || useHardwareScanner) return;
            if (Date.now() < scanCooldownUntil) {
              $video.requestVideoFrameCallback(() => frameLoop());
              return;
            }
            try {
              const codes = await detector.detect($video);
              if (codes && codes.length) {
                const value = (codes[0].rawValue || '').trim();
                if (value) {
                  scanCooldownUntil = Date.now() + 500;
                  onScan(value);
                }
              }
            } catch (e) {
              console.warn('Native detect failed, falling back to ZXing once:', e);
              running = false;
              await startZXingDecode();
              return;
            }
            $video.requestVideoFrameCallback(() => frameLoop());
          };
          $video.requestVideoFrameCallback(() => frameLoop());
          window.__bagvoyage_native_running__ = () => { running = false; };
          return;
        }
      }

      await startZXingDecode();
      return;

    }catch(e){
      console.error('[Bagvoyage] startScan error:', e);
      toast('Camera access failed: ' + (e?.message||e), 1500);
      await stopCamera();
      showHome();
    }
  }

  // ZXing init, bound to SAME device as currentTrack
  async function startZXingDecode() {
    const ZXB = window.ZXingBrowser || {};
    const ReaderClass = ZXB.BrowserMultiFormatReader;
    if (!ReaderClass) throw new Error('ZXing library not loaded');

    const reader = new ReaderClass();
    const BF = ZXB.BarcodeFormat, HT = ZXB.DecodeHintType;
    let hints;
    if (BF && HT) {
      const fmts = [BF.ITF, BF.CODE_128, BF.CODE_39, BF.EAN_13, BF.EAN_8, BF.UPC_A, BF.QR_CODE].filter(Boolean);
      hints = new Map();
      hints.set(HT.TRY_HARDER, true);
      hints.set(HT.POSSIBLE_FORMATS, fmts);
    }

    const settings = (currentTrack && currentTrack.getSettings) ? currentTrack.getSettings() : {};
    const deviceId = settings.deviceId || undefined;

    await reader.decodeFromVideoDevice(
      deviceId,
      $video,
      (result, err) => {
        if (!isScanning || !result || useHardwareScanner) return;
        if (Date.now() < scanCooldownUntil) return;

        const raw = result.getText();
        if (!raw) return;

        const digits = extractDigits(raw);
        if (digits) addFragment(digits);
        const assembled = tryAssemble();
        const processed = normalizeBaggageCode(raw) || digits || raw;
        const payload   = assembled || processed;
        if (!payload) return;

        scanCooldownUntil = Date.now() + 500;
        fragBuffer = [];
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

  /* ---------- Scan handler ---------- */
  async function onScan(text){
    const code = (text||'').trim();
    if(!code) return;
    const now = Date.now();
    if(code===lastRead.code && (now-lastRead.ts)<1200) return; // stronger dedupe
    lastRead = { code, ts: now };

    if(mode==='tag'){
      saveTag(code);
      vibrate(30);
      showSavedTick();
      
    } else if (mode === 'retrieve') {
  let ok = exists(code);
  if (!ok) {
    try { ok = await BV.existsServer(window.BV_SESSION_ID, code); } catch {}
  }
  BV.logScan(window.BV_SESSION_ID, code, ok).catch(()=>{});

  if (ok) {
    vibrate([40,60,40]);
    isScanning = false;
    await stopCamera();
    openSheet('ok','MATCH',code,true);
  } else {
    vibrate([30,40,30]);
    openSheet('bad','UNMATCHED',code,false);
  }
}


  /* ---------- Continue flow ---------- */
  async function onContinue(e){
    if (e && e.preventDefault) e.preventDefault();
    hideSheet();
    isScanning = false;
    if (mode !== 'retrieve') mode = 'retrieve';

    if (useHardwareScanner) {
      // Stay in HID mode; just make sure camera is off and doc has no focused input
      await stopCamera();
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      return;
    }
    await startScan('retrieve');
  }

  /* ---------- Buttons ---------- */
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
  document.getElementById('manualApply').addEventListener('click', (e)=>{
    e.preventDefault();
    const v = ($manualInput.value||'').trim();
    if(!v) return;
    if(!mode || mode==='tag'){ saveTag(v); showSavedTick(); }
    else { exists(v) ? (stopCamera(), openSheet('ok','MATCH',v,true)) : openSheet('bad','UNMATCHED',v,false); }
    $manualDlg.close();
    // In HID mode: keep document unfocused to prevent keyboard
    if (useHardwareScanner) { try{ document.activeElement && document.activeElement.blur && document.activeElement.blur(); }catch{} }
  });

  // Hardware Scanner toggle
  $hidBtn.addEventListener('click', async ()=>{
    useHardwareScanner = !useHardwareScanner;
    localStorage.setItem('bagvoyage_hid', JSON.stringify(useHardwareScanner));
    $hidBtn.textContent = `Hardware Scanner: ${useHardwareScanner ? 'On' : 'Off'}`;
    toast(useHardwareScanner ? 'Hardware scanner enabled' : 'Camera scanner enabled', 700);

    if (useHardwareScanner) {
      isScanning = false;
      await stopCamera();
      setCamStatus(false);
      await updateTorchUI();
      enableHIDCapture();
      // Ensure nothing focused
      try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
    } else {
      disableHIDCapture();
      await updateTorchUI();
      if ($scan && !$scan.classList.contains('hidden') && mode) {
        await startScan(mode);
      }
    }
  });

  /* ---------- Lifecycle ---------- */
  window.addEventListener('pagehide', () => { stopScan(); disableHIDCapture(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopScan();
      disableHIDCapture();
    } else if (mode) {
      if (useHardwareScanner) {
        enableHIDCapture();
        stopCamera();
        setCamStatus(false);
        updateTorchUI();
        try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch {}
      } else {
        startScan(mode);
      }
    }
  });

  // Initialize labels/states
  $hidBtn.textContent = `Hardware Scanner: ${useHardwareScanner ? 'On' : 'Off'}`;
})();
