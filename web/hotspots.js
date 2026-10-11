// Hotspots: numbered points pinned to objects in the 3D scene.
// Visitors tap one -> the camera flies to it and a spoken explanation plays.
// Open index.html?edit to place hotspots by clicking the scene, then download hotspots.json into web/.
import * as THREE from 'three';
import { askFor } from './ask.js';
import * as voice from './voice.js';
import { flyTo as glide, setHome, getHome } from './stage.js';

const DATA_URL = 'hotspots.json';
const DRAFT_KEY = 'ems-hotspots-draft';
const CLICK_PX = 5, CLICK_MS = 500;

const $ = (id) => document.getElementById(id);

let viewer = null;
let data = { hotspots: [] };
let markers = new Map();     // id -> button
let active = null;           // selected hotspot
let editMode = false;
let moving = false;          // editor: next scene click moves the active hotspot
let originalRender = null;
let captureRequest = null;   // resolves with a JPEG of the next rendered frame
let labelImage = null;       // editor: photo of the museum label, as a data URL
let speaking = false;

const lang = () => document.documentElement.dataset.lang || 'ar';
const isArabic = (text) => /[؀-ۿ]/.test(text);

// ---------- Public API ----------
export async function initHotspots(v, opts = {}) {
  viewer = v;
  editMode = !!opts.editMode;
  data = await loadData();
  // A starting angle saved from the editor wins over scene-config.js
  if (data.start) {
    v.camera.position.fromArray(data.start.position);
    v.controls.target.fromArray(data.start.target);
    v.camera.lookAt(v.controls.target);
  }
  setHome({ position: v.camera.position, target: v.controls.target });
  // Reposition markers whenever the viewer draws a new frame
  originalRender = v.render;
  v.render = function () {
    originalRender.call(this);
    placeMarkers();
    // The WebGL frame can only be read right after it is drawn
    if (captureRequest) { const done = captureRequest; captureRequest = null; done(snapshot(this.renderer.domElement)); }
  };
  window.addEventListener('resize', placeMarkers);

  buildMarkers();
  if (editMode) setupEditor();
  else updateHint();
  // On phones the sheet covers the middle of the scene: start it folded so the points are visible
  if (!editMode && data.hotspots.length && matchMedia('(max-width: 899px)').matches) $('panel').classList.add('collapsed');
  viewer.forceRenderNextFrame();
}

export function clearHotspots() {
  stopAudio();
  if (viewer && originalRender) viewer.render = originalRender;
  window.removeEventListener('resize', placeMarkers);
  $('spots').innerHTML = '';
  markers.clear();
  showStory();
  viewer = null; active = null;
}

// ---------- Data ----------
async function loadData() {
  if (editMode) {
    const draft = readDraft();
    if (draft) { $('draftNote').hidden = false; return draft; }
  }
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    return { start: json.start, hotspots: Array.isArray(json.hotspots) ? json.hotspots : [] };
  } catch {
    return { hotspots: [] };
  }
}

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    return d && Array.isArray(d.hotspots) ? d : null;
  } catch { return null; }
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* private mode: edits live until reload */ }
}

const round = (a) => a.map((n) => Math.round(n * 1e4) / 1e4);

function exportJson() {
  const keys = ['id', 'position', 'view', 'title', 'title_en', 'text_ar', 'text_en', 'facts', 'audio_ar', 'audio_en'];
  const hotspots = data.hotspots.map((h) => {
    const out = {};
    for (const k of keys) if (h[k] !== undefined && h[k] !== '') out[k] = h[k];
    out.position = round(h.position);
    if (h.view) out.view = { position: round(h.view.position), target: round(h.view.target) };
    return out;
  });
  const start = data.start && { position: round(data.start.position), target: round(data.start.target) };
  return JSON.stringify(start ? { start, hotspots } : { hotspots }, null, 2) + '\n';
}

// ---------- Markers ----------
function buildMarkers() {
  const layer = $('spots');
  layer.innerHTML = '';
  markers.clear();
  data.hotspots.forEach((h, i) => {
    const b = document.createElement('button');
    b.className = 'spot';
    b.type = 'button';
    b.textContent = i + 1;
    b.setAttribute('aria-label', spotTitle(h) || `نقطة ${i + 1}`);
    b.addEventListener('click', () => select(h, { play: !editMode }));
    layer.appendChild(b);
    markers.set(h.id, b);
  });
  markActive();
  placeMarkers();
}

const local = new THREE.Vector3();
function placeMarkers() {
  if (!viewer) return;
  const cam = viewer.camera;
  const w = $('stage').clientWidth, h = $('stage').clientHeight;
  cam.updateMatrixWorld();
  for (const hs of data.hotspots) {
    const el = markers.get(hs.id);
    if (!el) continue;
    local.fromArray(hs.position).applyMatrix4(cam.matrixWorldInverse);
    const inFront = local.z < -cam.near;
    local.fromArray(hs.position).project(cam);
    const onScreen = Math.abs(local.x) <= 1.05 && Math.abs(local.y) <= 1.05;
    el.hidden = !(inFront && onScreen);
    el.style.transform = `translate(${(local.x + 1) / 2 * w}px, ${(1 - local.y) / 2 * h}px) translate(-50%, -50%)`;
  }
}

function markActive() {
  for (const [id, el] of markers) el.classList.toggle('active', !!active && active.id === id);
}

// ---------- Camera ----------
function currentView() {
  return { position: viewer.camera.position.toArray(), target: viewer.controls.target.toArray() };
}

function viewFor(h) {
  if (h.view) return { position: new THREE.Vector3(...h.view.position), target: new THREE.Vector3(...h.view.target) };
  // No saved angle: move halfway towards the point from where we are now
  const target = new THREE.Vector3(...h.position);
  const position = viewer.camera.position.clone().sub(target).multiplyScalar(0.5).add(target);
  return { position, target };
}

function flyTo(view) {
  if (viewer) glide(viewer, view);
}

// ---------- Visitor view ----------
const spotTitle = (h) => (lang() === 'en' ? h.title_en || h.title : h.title) || '';
const spotText = (h) => (lang() === 'en' ? h.text_en || h.text_ar : h.text_ar) || '';

function select(h, { play = false } = {}) {
  stopAudio();
  active = h;
  moving = false;
  markActive();
  flyTo(viewFor(h));
  $('panel').classList.remove('collapsed');
  $('panel').classList.toggle('spot-mode', !editMode);   // shorter sheet so the point stays in view
  if (editMode) {
    labelImage = null;               // a label photo belongs to one piece
    $('edLabelName').textContent = '';
    renderEditor();
    return;
  }
  renderSpot();
  askFor(h);
  $('storyView').hidden = true;
  $('spotView').hidden = false;
  if (play) playAudio();
}

function renderSpot() {
  if (!active) return;
  const i = data.hotspots.indexOf(active);
  const en = lang() === 'en';
  $('spotNum').textContent = i + 1;
  $('spotTitle').textContent = spotTitle(active) || (en ? `Point ${i + 1}` : `نقطة ${i + 1}`);
  $('spotText').textContent = spotText(active);
  $('spotText').dir = isArabic(spotText(active)) ? 'rtl' : 'ltr';   // English UI falls back to Arabic text
  $('spotBack').textContent = en ? '← Whole scene' : '→ المشهد كامل';
  $('spotNext').textContent = en ? 'Next →' : 'التالي ←';
  $('spotNext').hidden = data.hotspots.length < 2;
  $('spotLang').textContent = en ? 'العربية' : 'English';
  setListenLabel();
}

function showStory() {
  if ($('spotView')) $('spotView').hidden = true;
  if ($('storyView') && !editMode) $('storyView').hidden = false;
}

// Close the piece's explanation; fly back to the start (or the current tour stop) unless told not to
function back({ fly = true } = {}) {
  stopAudio();
  active = null;
  askFor(null);
  markActive();
  showStory();
  $('panel').classList.remove('spot-mode');
  const home = getHome();
  if (fly && home) flyTo(home);
}

function next() {
  if (!active) return;
  const i = data.hotspots.indexOf(active);
  select(data.hotspots[(i + 1) % data.hotspots.length], { play: true });
}

function updateHint() {
  if (!data.hotspots.length) return;
  const en = lang() === 'en';
  $('hint').textContent = en
    ? 'Tap a numbered point to hear about that piece. Drag to orbit, pinch or scroll to zoom.'
    : 'اضغط على النقاط المرقمة عشان تسمع شرح كل قطعة. اسحب للدوران، وكبّر بإصبعين أو بعجلة الفأرة.';
}

// ---------- Audio: recorded file if there is one, else a natural voice (see voice.js) ----------
function setListenLabel() {
  const en = lang() === 'en';
  $('spotListen').textContent = speaking ? (en ? '■ Stop' : '■ إيقاف') : (en ? '▶ Listen' : '▶ استمع للشرح');
}

function playAudio() {
  if (!active) return;
  document.dispatchEvent(new Event('hotspot:play'));   // pauses the scene's audio tour
  const text = spotText(active);
  const src = lang() === 'en' && active.text_en ? active.audio_en : active.audio_ar;
  const done = () => { speaking = false; setListenLabel(); };
  speaking = true;
  setListenLabel();
  if (src) voice.playFile(src, text, { onend: done });
  else voice.speak(text, { onend: done });
}

function stopAudio() {
  voice.stop();
  speaking = false;
  if ($('spotListen')) setListenLabel();
}

// ---------- Editor (index.html?edit) ----------
const FIELDS = { edTitle: 'title', edTitleEn: 'title_en', edText: 'text_ar', edTextEn: 'text_en', edFacts: 'facts' };

function setupEditor() {
  $('storyView').hidden = true;
  $('editor').hidden = false;
  $('empty').hidden = true;

  // Distinguish a click from an orbit drag
  const canvas = viewer.renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const isClick = Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_PX && performance.now() - down.t < CLICK_MS;
    down = null;
    if (isClick) onSceneClick(e);
  });

  for (const [id, key] of Object.entries(FIELDS)) {
    $(id).addEventListener('input', () => {
      if (!active) return;
      active[key] = $(id).value;
      if (key === 'text_ar' || key === 'text_en') { delete active.audio_ar; delete active.audio_en; }  // audio no longer matches
      saveDraft();
      renderList();
    });
  }
  $('edStart').addEventListener('click', () => {
    data.start = currentView();
    setHome({ position: viewer.camera.position, target: viewer.controls.target });
    saveDraft();
    renderList();
    setEdStatus('حفظت هذي الزاوية كبداية للمشهد. نزّل hotspots.json عشان تثبت.');
  });
  $('edView').addEventListener('click', () => { if (active) { active.view = currentView(); saveDraft(); setEdStatus('حفظت زاوية الكاميرا الحالية لهذي النقطة.'); } });
  $('edMove').addEventListener('click', () => { moving = !!active; setEdStatus(moving ? 'اضغط على المكان الجديد في المشهد.' : ''); });
  $('edDelete').addEventListener('click', () => {
    if (!active || !confirm('تحذف هذي النقطة؟')) return;
    data.hotspots.splice(data.hotspots.indexOf(active), 1);
    active = null;
    saveDraft(); buildMarkers(); renderEditor();
  });
  $('edDone').addEventListener('click', () => { active = null; moving = false; markActive(); renderEditor(); });
  $('edDownload').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'hotspots.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setEdStatus('نزل الملف. حطه في مجلد web بدل hotspots.json القديم.');
  });
  $('edCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exportJson()); setEdStatus('نسخت المحتوى. الصقه في web/hotspots.json.'); }
    catch { setEdStatus('ما قدرت أنسخ. استخدم زر التنزيل.'); }
  });
  $('edDiscard').addEventListener('click', async () => {
    if (!confirm('ترجع لملف hotspots.json وتمسح التعديلات اللي ما نزلتها؟')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing saved */ }
    $('draftNote').hidden = true;
    data = await loadData();        // the draft is gone, so this reads the file
    active = null;
    buildMarkers(); renderEditor();
  });

  setupAutoDescribe();
  renderEditor();
}

// ---------- Editor: the model looks at the piece and writes the narration ----------
function snapshot(canvas, max = 1024) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * s);
  out.height = Math.round(canvas.height * s);
  const g = out.getContext('2d');
  g.fillStyle = '#1D2440';               // the scene's background, so empty areas aren't black
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

function captureView() {
  return new Promise((resolve, reject) => {
    captureRequest = resolve;
    viewer.forceRenderNextFrame();
    setTimeout(() => { if (captureRequest === resolve) { captureRequest = null; reject(new Error('no frame')); } }, 3000);
  });
}

function readImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s);
      c.height = Math.round(im.naturalHeight * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    im.src = url;
  });
}

async function setupAutoDescribe() {
  $('edAuto').hidden = false;
  let available = false;
  try { available = (await (await fetch('/api/health', { cache: 'no-store' })).json()).describe === true; } catch { /* static server */ }
  if (!available) {
    $('edWrite').disabled = true;
    $('edWrite').title = 'يحتاج scripts/server.py مع مفتاح موديل بملف .env';
  }

  $('edLabel').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      labelImage = await readImage(file);
      $('edLabelName').textContent = file.name;
    } catch {
      labelImage = null;
      $('edLabelName').textContent = 'ما قدرت أفتح الصورة. جرّب JPG أو PNG.';
    }
  });

  $('edWrite').addEventListener('click', async () => {
    if (!active) return;
    const spot = active;
    if ((spot.text_ar || '').trim() && !confirm('فيه شرح مكتوب. تبي الموديل يكتب شرح جديد بداله؟')) return;
    $('edWrite').disabled = true;
    setEdStatus('الموديل يشوف القطعة ويكتب الشرح… (ممكن ياخذ نص دقيقة)');
    try {
      const image = await captureView();
      const res = await fetch('/api/describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: spot.id, image, label_image: labelImage, notes: spot.facts || '' }),
      });
      if (!res.ok) throw new Error(res.status);
      const r = await res.json();
      if (!r.text_ar) throw new Error('empty');
      for (const k of ['title', 'title_en', 'text_ar', 'text_en']) if (r[k]) spot[k] = r[k];
      if (r.label_text && !(spot.facts || '').trim()) spot.facts = r.label_text;   // what it read on the label
      delete spot.audio_ar; delete spot.audio_en;
      saveDraft();
      if (active === spot) renderEditor();
      renderList();
      setEdStatus('كتب الشرح ✓ عدّله إذا تبي، وبعدين نزّل hotspots.json. وحفظت صورة القطعة عشان يقدر يجاوب أسئلة الزوار عنها.');
    } catch {
      setEdStatus('ما قدر الموديل يكتب الحين. جرّب بعد شوي، أو شيك على الترمنال.');
    } finally {
      $('edWrite').disabled = !available;
    }
  });
}

const hitDims = new THREE.Vector2();
const hitPos = new THREE.Vector2();
function onSceneClick(e) {
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  hitPos.set(e.clientX - rect.left, e.clientY - rect.top);
  viewer.getRenderDimensions(hitDims);
  const hits = [];
  viewer.raycaster.setFromCameraAndScreenPosition(viewer.camera, hitPos, hitDims);
  viewer.raycaster.intersectSplatMesh(viewer.splatMesh, hits);
  if (!hits.length) { setEdStatus('ما لقيت شي هنا. اضغط على القطعة نفسها.'); return; }
  const point = hits[0].origin.toArray();

  if (moving && active) {
    active.position = point;
    moving = false;
    setEdStatus('نقلت النقطة.');
  } else {
    const n = data.hotspots.reduce((m, h) => Math.max(m, parseInt(String(h.id).slice(1)) || 0), 0) + 1;
    // Default angle: from where we're looking, halfway towards the point ("خذ زاوية الكاميرا الحالية" overrides it)
    const target = new THREE.Vector3(...point);
    const position = viewer.camera.position.clone().sub(target).multiplyScalar(0.5).add(target);
    const view = { position: position.toArray(), target: point };
    active = { id: `h${n}`, position: point, view, title: '', title_en: '', text_ar: '', text_en: '' };
    data.hotspots.push(active);
    labelImage = null;
    $('edLabelName').textContent = '';
    setEdStatus('قرّب على القطعة واضغط ✨ عشان يكتب الشرح، أو اكتبه بنفسك.');
  }
  saveDraft();
  buildMarkers();
  renderEditor();
  if (!$('edForm').hidden) $('edTitle').focus();
}

function renderList() {
  const list = $('edList');
  list.innerHTML = '';
  data.hotspots.forEach((h, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-item' + (active === h ? ' active' : '');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    const name = document.createElement('span');
    name.textContent = h.title || 'بدون عنوان';
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = !h.text_ar ? 'بدون شرح' : (h.audio_ar ? 'صوت ✓' : 'صوت الجهاز');
    b.append(num, name, state);
    b.addEventListener('click', () => select(h));
    li.appendChild(b);
    list.appendChild(li);
  });
  $('edEmpty').hidden = data.hotspots.length > 0;
  $('edDownload').disabled = $('edCopy').disabled = data.hotspots.length === 0 && !data.start;
}

function renderEditor() {
  renderList();
  markActive();
  $('edForm').hidden = !active;
  if (!active) return;
  $('edFormTitle').textContent = `النقطة ${data.hotspots.indexOf(active) + 1}`;
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = active[key] || '';
}

function setEdStatus(text) { $('edStatus').textContent = text; }

// ---------- Wiring ----------
$('spotBack')?.addEventListener('click', back);
$('spotNext')?.addEventListener('click', next);
$('spotListen')?.addEventListener('click', () => (speaking ? stopAudio() : playAudio()));
$('spotLang')?.addEventListener('click', () => $('langBtn').click());
document.addEventListener('langchange', () => {
  if (active && !editMode) { stopAudio(); renderSpot(); }
  if (!editMode) updateHint();
});
document.addEventListener('tour:play', stopAudio);
// Walking to another stop of the corridor tour closes the open piece
document.addEventListener('tour:move', () => { if (active && !editMode) back({ fly: false }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active && !editMode) back(); });
