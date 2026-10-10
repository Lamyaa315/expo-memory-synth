// Hotspots: numbered points pinned to objects in the 3D scene.
// Visitors tap one -> the camera flies to it and a spoken explanation plays.
// Open index.html?edit to place hotspots by clicking the scene, then download hotspots.json into web/.
import * as THREE from 'three';
import { askFor } from './ask.js';

const DATA_URL = 'hotspots.json';
const DRAFT_KEY = 'ems-hotspots-draft';
const FLY_SECONDS = 1.2;
const CLICK_PX = 5, CLICK_MS = 500;

const $ = (id) => document.getElementById(id);
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let viewer = null;
let data = { hotspots: [] };
let markers = new Map();     // id -> button
let active = null;           // selected hotspot
let editMode = false;
let moving = false;          // editor: next scene click moves the active hotspot
let home = null;             // { position, target } of the starting view
let fly = null;
let originalRender = null;
let speaking = false;

const lang = () => document.documentElement.dataset.lang || 'ar';
const spotAudio = () => $('spotAudio');
const isArabic = (text) => /[؀-ۿ]/.test(text);

// ---------- Public API ----------
export async function initHotspots(v, opts = {}) {
  viewer = v;
  editMode = !!opts.editMode;
  home = { position: v.camera.position.clone(), target: v.controls.target.clone() };

  data = await loadData();
  // Reposition markers whenever the viewer draws a new frame
  originalRender = v.render;
  v.render = function () { originalRender.call(this); placeMarkers(); };
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
  viewer = null; active = null; fly = null;
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
    return { hotspots: Array.isArray(json.hotspots) ? json.hotspots : [] };
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
  return JSON.stringify({ hotspots }, null, 2) + '\n';
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
  if (!viewer) return;
  viewer.transitioningCameraTarget = false;   // cancel the viewer's own click-to-focus animation
  const cam = viewer.camera, ctl = viewer.controls;
  if (reduceMotion) {
    cam.position.copy(view.position); ctl.target.copy(view.target); cam.lookAt(ctl.target);
    viewer.forceRenderNextFrame();
    return;
  }
  fly = { start: performance.now(), p0: cam.position.clone(), q0: ctl.target.clone(), p1: view.position, q1: view.target };
  const step = (now) => {
    if (!fly || !viewer) return;
    const k = ease((now - fly.start) / 1000 / FLY_SECONDS);
    cam.position.lerpVectors(fly.p0, fly.p1, k);
    ctl.target.lerpVectors(fly.q0, fly.q1, k);
    cam.lookAt(ctl.target);
    if (k < 1) requestAnimationFrame(step); else fly = null;
  };
  requestAnimationFrame(step);
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
  if (editMode) { renderEditor(); return; }
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

function back() {
  stopAudio();
  active = null;
  askFor(null);
  markActive();
  showStory();
  $('panel').classList.remove('spot-mode');
  if (home) flyTo({ position: home.position.clone(), target: home.target.clone() });
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

// ---------- Audio: recorded file if there is one, else the device's text-to-speech ----------
function setListenLabel() {
  const en = lang() === 'en';
  $('spotListen').textContent = speaking ? (en ? '■ Stop' : '■ إيقاف') : (en ? '▶ Listen' : '▶ استمع للشرح');
}

function playAudio() {
  if (!active) return;
  document.dispatchEvent(new Event('hotspot:play'));   // pauses the scene's audio tour
  const src = lang() === 'en' && active.text_en ? active.audio_en : active.audio_ar;
  const a = spotAudio();
  speaking = true;
  setListenLabel();
  if (src) {
    a.src = src;
    a.play().catch(() => speak());
  } else {
    speak();
  }
}

function speak() {
  const text = spotText(active);
  if (!text || !('speechSynthesis' in window)) { speaking = false; setListenLabel(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = isArabic(text) ? 'ar-SA' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 0.95;
  u.onend = u.onerror = () => { speaking = false; setListenLabel(); };
  speechSynthesis.speak(u);
}

function stopAudio() {
  const a = spotAudio();
  if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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

  renderEditor();
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
    setEdStatus('');
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
  $('edDownload').disabled = $('edCopy').disabled = data.hotspots.length === 0;
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
spotAudio()?.addEventListener('ended', () => { speaking = false; setListenLabel(); });
document.addEventListener('langchange', () => {
  if (active && !editMode) { stopAudio(); renderSpot(); }
  if (!editMode) updateHint();
});
document.addEventListener('tour:play', stopAudio);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active && !editMode) back(); });
// Chrome loads speech voices lazily
if ('speechSynthesis' in window) speechSynthesis.getVoices();
