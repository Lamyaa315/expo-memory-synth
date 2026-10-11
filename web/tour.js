// Walk the corridor: stops along the path the phone was filmed on (web/tour.json, made by
// scripts/camera_path.py). The scan is sharp near where it was filmed, so visitors move between those
// spots and look around a little at each one, instead of orbiting freely into blurry, unseen areas.
import * as THREE from 'three';
import { flyTo, setHome } from './stage.js';

const FLY_SECONDS = 2.2;
const AUTO_PAUSE_MS = 3500;   // time at each stop during the automatic tour

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';

let viewer = null;
let tour = null;
let index = 0;
let auto = false;
let autoTimer = null;

// Returns true when the scene has a tour. Puts the camera at the first stop.
export async function initTour(v) {
  try {
    const res = await fetch('tour.json', { cache: 'no-cache' });
    tour = res.ok ? await res.json() : null;
  } catch {
    tour = null;
  }
  if (!tour?.stops?.length) return false;

  viewer = v;
  if (tour.fov) {
    // Close to the phone's field of view, so the edges of what it saw stay out of frame
    v.camera.fov = Math.min(60, Math.max(35, tour.fov + 10));
    v.camera.updateProjectionMatrix();
  }
  go(0, { instant: true });
  v.controls?.addEventListener?.('start', () => stopAuto());   // the visitor took over
  $('tourBar').hidden = false;
  render();
  return true;
}

function viewAt(i) {
  const s = tour.stops[i];
  return { position: new THREE.Vector3(...s.position), target: new THREE.Vector3(...s.target) };
}

function go(i, { instant = false, onDone } = {}) {
  index = Math.max(0, Math.min(tour.stops.length - 1, i));
  document.dispatchEvent(new Event('tour:move'));   // closes an open hotspot
  const view = viewAt(index);
  flyTo(viewer, view, {
    seconds: instant ? 0 : FLY_SECONDS,
    onDone: () => { setHome(view); onDone?.(); },     // "whole scene" now means this stop
  });
  render();
}

function step(d) {
  stopAuto();
  go(index + d);
}

function startAuto() {
  auto = true;
  render();
  const next = () => {
    if (!auto) return;
    if (index >= tour.stops.length - 1) { stopAuto(); return; }
    go(index + 1, { onDone: () => { if (auto) autoTimer = setTimeout(next, AUTO_PAUSE_MS); } });
  };
  if (index >= tour.stops.length - 1) go(0, { onDone: () => { autoTimer = setTimeout(next, AUTO_PAUSE_MS); } });
  else next();
}

function stopAuto() {
  if (!auto) return;
  auto = false;
  clearTimeout(autoTimer);
  render();
}

function render() {
  if (!tour) return;
  const en = lang() === 'en';
  const last = tour.stops.length - 1;
  $('tourPrev').textContent = en ? '← Back' : '→ السابق';
  $('tourNext').textContent = en ? 'Next →' : 'التالي ←';
  $('tourPrev').disabled = index === 0;
  $('tourNext').disabled = index === last;
  $('tourCount').textContent = en ? `Stop ${index + 1} of ${last + 1}` : `محطة ${index + 1} من ${last + 1}`;
  $('tourAuto').textContent = auto ? (en ? '■ Stop' : '■ إيقاف') : (en ? '▶ Walk me through' : '▶ جولة تلقائية');
  $('tourAuto').setAttribute('aria-pressed', String(auto));
}

$('tourPrev').addEventListener('click', () => step(-1));
$('tourNext').addEventListener('click', () => step(1));
$('tourAuto').addEventListener('click', () => (auto ? stopAuto() : startAuto()));
document.addEventListener('langchange', render);
// Opening a hotspot pauses the automatic walk (its own flight takes over the camera)
document.addEventListener('hotspot:play', () => stopAuto());
