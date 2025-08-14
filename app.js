/* =========================
   BagVoyage — app.js (clean)
   ========================= */

/* ---------- Config ---------- */
// Set to true if you want to reject 10-digit codes that fail IATA 7-3-1 check-digit.
// Leave false during field testing to avoid blocking operators.
const STRICT_VALIDATION = false;

/* ---------- State ---------- */
let mode = 'tag'; // 'tag' | 'retrieve'
let currentStream = null;
let reader = null; // ZXing reader instance
let torchOn = false;
let lastScanAt = 0; // throttle

/* ---------- DOM ---------- */
const $video = document.getElementById('cameraFeed');
const $result = document.getElementById('scanResult');
const $counter = document.getElementById('counter');
const $torch = document.getElementById('torchToggle');
const $listBtn = document.getElementById('showList');
const $list = document.getElementById('listDrawer');
const $closeList = document.getElementById('closeList');
const $tagList = document.getElementById('tagList');
const $tagBtn = document.getElementById('tagModeBtn');
const $retBtn = document.getElementById('retrieveModeBtn');
const $hid = document.getElementById('scannerInput');

/* ---------- Helpers ---------- */
function extractDigits(s){ return (s||'').replace(/\D+/g,''); }
function validIATATag10(d){
  if (!/^\d{10}$/.test(d)) return false;
  const w = [7,3,1]; let sum = 0;
  for (let i=0;i<9;i++) sum += (+d[i]) * w[i%3];
  return (sum % 10) === +d[9];
}
// Accept 10-digit (with optional strict check) or 13-digit
function normalize(raw){
  const d = extractDigits(raw);
  if (d.length === 10) return (validIATATag10(d) || !STRICT_VALIDATION) ? d : '';
  if (d.length === 13) return d;
  return '';
}

/* ---------- Storage ---------- */
const KEY = 'bagvoyage_tags'; // single bucket for now
function load(){ try { return JSON.parse(localStorage.getItem(KEY)||'[]'); } catch { return []; } }
function save(a){ try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {} }
function updateCounter(){ $counter.textContent = `Count: ${load().length}`; }

function saveTag(raw){
  let n = normalize(raw), note = '';
  if (!n) {
    const d = extractDigits(raw);
    if (d.length === 10 || d.length === 13) { n = d; note = 'lenient'; }
  }
  if (!n) return false;
  const a = load();
  if (!a.some(x=>x.code===n)) {
    a.unshift({ code:n, ts:Date.now(), note });
    if (a.length > 5000) a.pop();
    save(a);
    updateCounter();
  }
  return true;
}
function exists(raw){
  const n = normalize(raw), d = extractDigits(raw), a = load();
  if (n && a.some(x=>x.code===n)) return true;
  if ((!n || STRICT_VALIDATION) && (d.length===10 || d.length===13))
    return a.some(x=>x.code===d);
  return false;
}

/* ---------- UI ---------- */
function showResult(text, ok){
  $result.textContent = text;
  $result.style.background = ok ? 'rgba(0,128,0,0.7)' : 'rgba(128,0,0,0.7)';
  clearTimeout(showResult._t);
  showResult._t = setTimeout(()=>{ $result.textContent=''; }, 1400);
}
function renderList(){
  const a = load();
  $tagList.innerHTML = a.map(item =>
    `<li>${item.code}${item.note==='lenient' ? ' <span class="badge">LENIENT</span>' : ''}</li>`
  ).join('') || '<li class="muted">No tags yet.</li>';
}

/* ---------- Mode switching ---------- */
function setMode(m){
  mode = m;
  const tagActive = (m==='tag');
  $tagBtn.classList.toggle('active', tagActive);
  $retBtn.classList.toggle('active', !tagActive);
  $tagBtn.setAttribute('aria-pressed', String(tagActive));
  $retBtn.setAttribute('aria-pressed', String(!tagActive));
  // brief visual cue
  showResult(tagActive ? 'Tag mode' : 'Retrieve mode', true);
}

$tagBtn.onclick = ()=> setMode('tag');
$retBtn.onclick = ()=> setMode('retrieve');

/* ---------- Camera & Torch ---------- */
async function startCamera(){
  try{
    await stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920, min: 1280 },
        height:{ ideal: 1080, min: 720 },
        frameRate: { ideal: 30, min: 15 }
      },
      audio: false
    });
    currentStream = stream;
    $video.srcObject = stream;

    // Torch availability
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    const torchSupported = 'torch' in caps;
    $torch.disabled = !torchSupported;
    if (!torchSupported) {
      $torch.title = 'Torch not supported on this camera';
    } else {
      $torch.title = 'Toggle torch';
    }

    // ZXing setup (bind to this device)
    await startZXing(track.getSettings?.().deviceId);

  }catch(e){
    console.error('Camera error:', e);
    showResult('Camera error: ' + (e.message||e), false);
  }
}

async function stopCamera(){
  try { await sto
