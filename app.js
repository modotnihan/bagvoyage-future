// ====== CONFIG ======
const STRICT_VALIDATION = false;

// ====== STATE ======
let mode = 'tag';
let currentStream;
let torchOn = false;

// ====== HELPERS ======
function extractDigits(str){ return str.replace(/\D+/g, ''); }
function validIATATag10(code){
  if (!/^\d{10}$/.test(code)) return false;
  const weights = [7,3,1,7,3,1,7,3,1];
  let sum = 0;
  for (let i=0;i<9;i++) sum += parseInt(code[i])*weights[i];
  return (sum % 10) === parseInt(code[9]);
}
function normalizeBaggageCode(raw){
  const d = extractDigits(raw);
  if (d.length === 10){
    if (validIATATag10(d) || !STRICT_VALIDATION) return d;
    return '';
  }
  if (d.length === 13) return d;
  return '';
}

// ====== STORAGE ======
function getSessionKey(){ return `bagvoyage_${mode}`; }
function loadTags(){ return JSON.parse(localStorage.getItem(getSessionKey())||'[]'); }
function saveTags(tags){ localStorage.setItem(getSessionKey(), JSON.stringify(tags)); }

function saveTag(raw){
  const n = normalizeBaggageCode(raw);
  let stored = n;
  let note = '';

  if (!stored){
    const d = extractDigits(raw);
    if (d.length === 10 || d.length === 13){
      stored = d;
      note = 'lenient';
    }
  }
  if (!stored) return false;

  const list = loadTags();
  if (!list.some(x=>x.code===stored)){
    list.unshift({code: stored, ts: Date.now(), note});
    saveTags(list);
    updateCounter();
  }
  return true;
}

function existsInTags(raw){
  const n = normalizeBaggageCode(raw);
  const d = extractDigits(raw);
  const list = loadTags();
  if (n && list.some(x=>x.code===n)) return true;
  if ((!n || STRICT_VALIDATION) && (d.length===10 || d.length===13)){
    return list.some(x=>x.code===d);
  }
  return false;
}

// ====== CAMERA ======
async function startCamera(){
  if (currentStream){
    currentStream.getTracks().forEach(t=>t.stop());
  }
  const constraints = {video: {facingMode: 'environment'}};
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  document.getElementById('cameraFeed').srcObject = currentStream;
}

function toggleTorch(){
  if (!currentStream) return;
  const track = currentStream.getVideoTracks()[0];
  const cap = track.getCapabilities();
  if (!cap.torch) return alert('Torch not supported');
  torchOn = !torchOn;
  track.applyConstraints({advanced:[{torch: torchOn}]});
}

// ====== UI ======
function updateCounter(){
  document.getElementById('counter').textContent = `Count: ${loadTags().length}`;
}

function renderList(){
  const list = loadTags();
  const ul = document.getElementById('tagList');
  ul.innerHTML = '';
  list.forEach(item=>{
    const li = document.createElement('li');
    li.innerHTML = `${item.code}${item.note==='lenient' ? '<span class="badge">LENIENT</span>' : ''}`;
    ul.appendChild(li);
  });
}

function showResult(text, match=false){
  const el = document.getElementById('scanResult');
  el.textContent = text;
  el.style.background = match ? 'rgba(0,128,0,0.7)' : 'rgba(128,0,0,0.7)';
  setTimeout(()=>{ el.textContent = ''; }, 2000);
}

// ====== SCANNING ======
// Placeholder scanner simulation — integrate with your real QR/barcode lib here.
function fakeScan(){
  const sample = prompt('Enter fake scan value:');
  if (!sample) return;
  if (mode==='tag'){
    if (saveTag(sample)) showResult('Saved ✓', true);
    else showResult('Invalid ❌', false);
  } else {
    if (existsInTags(sample)) showResult('MATCH ✓', true);
    else showResult('UNMATCHED ❌', false);
  }
}

// ====== INIT ======
document.getElementById('tagModeBtn').onclick = ()=>{ mode='tag'; updateCounter(); };
document.getElementById('retrieveModeBtn').onclick = ()=>{ mode='retrieve'; updateCounter(); };
document.getElementById('torchToggle').onclick = toggleTorch;
document.getElementById('showList').onclick = ()=>{ renderList(); document.getElementById('listDrawer').classList.remove('hidden'); };
document.getElementById('closeList').onclick = ()=>{ document.getElementById('listDrawer').classList.add('hidden'); };

startCamera();
updateCounter();

// TEMP: bind fake scan for demo without camera library
document.getElementById('cameraFeed').onclick = fakeScan;
