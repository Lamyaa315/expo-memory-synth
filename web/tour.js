// Walk the corridor: stops along the path the phone was filmed on (web/scenes/<id>/tour.json, made by
// scripts/camera_path.py). The scan is sharp near where it was filmed, so visitors move between those
// spots and look around a little at each one, instead of orbiting freely into blurry, unseen areas.
import * as THREE from 'three';
import { flyTo, setHome } from './stage.js';
import { initWalk } from './walk.js';
import { sceneUrl, WALK, SCENES, SCENE } from './scene-config.js';
import * as voice from './voice.js';

const FADE_MS = 350;          // dim, jump, brighten: gliding between stops crosses blurry, unfilmed space
const SETTLE_SECONDS = 1.4;   // after the jump, ease in from a little further back
const AUTO_PAUSE_MS = 3500;   // time at each stop during the automatic tour when there is nothing to say
const AFTER_SPEECH_MS = 1200; // a breath after the guide finishes, before the next stop
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';

let viewer = null;
let tour = null;
let index = 0;
let auto = false;
let autoTimer = null;
let moveToken = 0;
let story = null;    // web/scenes/<id>/story.json: what the guide says at each stop, and look-alikes elsewhere

// One tour across the pavilions, in the order of SCENES: after the last stop of one, the next one opens
// (the page reloads on it behind a fade). The counter counts stops across all of them.
const here = SCENES.findIndex((s) => s.id === SCENE.id);   // -1: a pavilion opened on its own
const prevScene = here > 0 ? SCENES[here - 1] : null;
const nextScene = here >= 0 ? SCENES[here + 1] || null : null;
let offset = 0;      // stops in the pavilions before this one
let total = 0;       // stops in all of them
const params = new URLSearchParams(location.search);

async function countStops() {
  if (here < 0) { offset = 0; total = tour.stops.length; return; }
  const counts = await Promise.all(SCENES.map(async (s) => {
    if (s.id === SCENE.id) return tour.stops.length;
    try {
      const res = await fetch(`scenes/${s.id}/tour.json`, { cache: 'no-cache' });
      return res.ok ? ((await res.json()).stops || []).length : 0;
    } catch { return 0; }
  }));
  offset = counts.slice(0, here).reduce((a, b) => a + b, 0);
  total = counts.reduce((a, b) => a + b, 0);
}

// Fade out and open another pavilion at its first or last stop
function leave(scene, stop, { keepAuto = false } = {}) {
  ++moveToken;
  clearTimeout(autoTimer);
  $('tourFade').classList.add('on');
  const url = new URL(location.href);
  url.searchParams.set('scene', scene.id);
  url.searchParams.set('stop', stop);
  if (keepAuto) url.searchParams.set('auto', '1'); else url.searchParams.delete('auto');
  setTimeout(() => { location.href = url; }, FADE_MS + 150);
}

// Arriving from another pavilion: its name shows for a moment
function announce() {
  const t = $('sceneToast');
  t.textContent = lang() === 'en' ? SCENE.title_en : SCENE.title;
  t.classList.add('on');
  setTimeout(() => t.classList.remove('on'), 2600);
}

// Returns true when the scene has a tour. Puts the camera at the first stop.
export async function initTour(v) {
  try {
    const res = await fetch(sceneUrl('tour.json'), { cache: 'no-cache' });
    tour = res.ok ? await res.json() : null;
  } catch {
    tour = null;
  }
  if (!tour?.stops?.length) return false;
  try {
    const res = await fetch(sceneUrl('story.json'), { cache: 'no-cache' });
    story = res.ok ? await res.json() : null;
  } catch { story = null; }

  viewer = v;
  if (tour.fov) {
    // The phone's own field of view: anything wider shows edges it never filmed, which are blurry
    v.camera.fov = Math.min(55, Math.max(25, tour.fov + 2));
    v.camera.updateProjectionMatrix();
  }
  await countStops();
  const wanted = params.get('stop');
  const first = wanted === 'last' ? tour.stops.length - 1 : Math.max(0, parseInt(wanted, 10) || 0);
  go(first, { instant: true });
  if (wanted !== null) {   // came here from the previous or next pavilion: fade in, and keep walking if it was
    $('tourFade').classList.add('on');
    setTimeout(() => { $('tourFade').classList.remove('on'); }, 400);   // seamless: it should feel like the same place (announce() names it)
    if (params.get('auto') === '1') setTimeout(() => startAuto({ fromHere: true }), 900);
  }
  v.controls?.addEventListener?.('start', () => stopAuto());   // the visitor took over
  document.addEventListener('walk:move', () => stopAuto());
  document.addEventListener('guide:open', () => stopAuto());   // the visitor wants to ask Saad something
  $('tourBar').hidden = false;
  render();
  if (WALK) return { walk: initWalk(v, tour) };   // free walking; the stops stay as shortcuts
  document.addEventListener('keydown', onKey, true);
  return { walk: false };
}

// Without walking the arrows switch stops (the next one is on the left in Arabic, like the button), and
// no other key moves the camera: the viewer's own keys would turn it towards parts that were never filmed
const VIEWER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
function onKey(e) {
  if (!VIEWER_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;   // typing
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const forward = lang() === 'en' ? 'ArrowRight' : 'ArrowLeft';
  const backward = lang() === 'en' ? 'ArrowLeft' : 'ArrowRight';
  if (e.code === forward) step(1);
  else if (e.code === backward) step(-1);
}

function viewAt(i) {
  const s = tour.stops[i];
  return { position: new THREE.Vector3(...s.position), target: new THREE.Vector3(...s.target) };
}

function go(i, { instant = false, onDone } = {}) {
  index = Math.max(0, Math.min(tour.stops.length - 1, i));
  document.dispatchEvent(new Event('tour:move'));   // closes an open hotspot
  const view = viewAt(index);
  const stop = index;
  const arrived = () => {
    setHome(view);   // "whole scene" now means this stop
    document.dispatchEvent(new CustomEvent('tour:arrive', { detail: { index: stop, story: story?.stops?.[stop] } }));
    onDone?.();
  };
  render();
  if (instant) {
    flyTo(viewer, view, { seconds: 0, onDone: arrived });
    return;
  }
  const token = ++moveToken;
  const fade = $('tourFade');
  fade.classList.add('on');
  setTimeout(() => {
    if (token !== moveToken) return;            // a newer move took over
    if (reduceMotion) {
      flyTo(viewer, view, { seconds: 0, onDone: arrived });
    } else {
      // Start slightly behind the stop and ease forward while the screen brightens
      const back = view.position.clone().sub(view.target).multiplyScalar(0.12).add(view.position);
      flyTo(viewer, { position: back, target: view.target }, { seconds: 0 });
      flyTo(viewer, view, { seconds: SETTLE_SECONDS, onDone: arrived });
    }
    setTimeout(() => { if (token === moveToken) fade.classList.remove('on'); }, 120);   // let the splats sort first
  }, FADE_MS);
}

function step(d) {
  stopAuto();
  const i = index + d;
  if (i > tour.stops.length - 1 && nextScene) return leave(nextScene, 0);
  if (i < 0 && prevScene) return leave(prevScene, 'last');
  go(i);
}

// The guide tells about the stop (a recorded clip if there is one, else his voice from the server or the
// browser), then calls done. Nothing to say: a short pause instead.
function narrate(i, done) {
  const s = story?.stops?.[i];
  const text = s?.say;
  if (!text) { autoTimer = setTimeout(done, AUTO_PAUSE_MS); return; }
  const guide = $('guideBtn');
  guide?.classList.add('speaking');
  const end = () => { guide?.classList.remove('speaking'); done(); };
  const opts = { onend: end, onblocked: (play) => { guide?.classList.remove('speaking'); stopAuto(); } };
  if (s.audio) voice.playFile(s.audio, text, opts);
  else voice.speak(text, opts);
}

// The automatic tour: at each stop the guide speaks, then the tour moves on by itself, into the next
// pavilion too, until the end or until the visitor takes over (a button, a drag, or tapping the guide)
function startAuto({ fromHere = false } = {}) {
  if (!fromHere) voice.unlock();   // the tap that started it lets the guide's voice play all the way
  auto = true;
  render();
  const advance = () => {
    if (!auto) return;
    if (index >= tour.stops.length - 1) {
      if (nextScene) leave(nextScene, 0, { keepAuto: true });   // carry on in the next pavilion
      else stopAuto();
      return;
    }
    go(index + 1, { onDone: dwell });
  };
  const dwell = () => {
    if (!auto) return;
    narrate(index, () => { if (auto) autoTimer = setTimeout(advance, AFTER_SPEECH_MS); });
  };
  const atEnd = index >= tour.stops.length - 1 && !nextScene;
  if (atEnd && !fromHere) {
    // the whole tour is done: start again from the very first stop
    if (here > 0) return leave(SCENES[0], 0, { keepAuto: true });
    go(0, { onDone: dwell });
  } else {
    dwell();   // start by telling about the stop we are at
  }
}

function stopAuto() {
  if (!auto) return;
  auto = false;
  clearTimeout(autoTimer);
  voice.stop();
  $('guideBtn')?.classList.remove('speaking');
  render();
}

function render() {
  if (!tour) return;
  const en = lang() === 'en';
  const last = tour.stops.length - 1;
  $('tourPrev').textContent = en ? '← Back' : '→ السابق';
  $('tourNext').textContent = en ? 'Next →' : 'التالي ←';
  $('tourPrev').disabled = index === 0 && !prevScene;
  $('tourNext').disabled = index === last && !nextScene;
  const n = offset + index + 1, of = total || last + 1;
  $('tourCount').textContent = en ? `Stop ${n} of ${of}` : `محطة ${n} من ${of}`;
  $('tourAuto').textContent = auto ? (en ? '■ Stop' : '■ إيقاف') : (en ? '▶ Walk me through' : '▶ جولة تلقائية');
  $('tourAuto').setAttribute('aria-pressed', String(auto));
}

$('tourPrev').addEventListener('click', () => step(-1));
$('tourNext').addEventListener('click', () => step(1));
$('tourAuto').addEventListener('click', () => (auto ? stopAuto() : startAuto()));
document.addEventListener('langchange', render);
// Opening a hotspot pauses the automatic walk (its own flight takes over the camera)
document.addEventListener('hotspot:play', () => stopAuto());
