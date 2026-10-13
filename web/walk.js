// Walk freely with the arrow keys (or the on-screen pad on phones), but only along the path the phone was
// filmed on (tour.json "path"): the scan is sharp there and blurry everywhere else, so visitors move inside
// an invisible corridor around that path. ↑ ↓ walk, ← → turn, drag to look around, wheel to zoom.
import * as THREE from 'three';
import { isFlying, keepRendering, hideFloor } from './stage.js';

const SPEED = 0.15;                  // scene units per second
const TURN = Math.PI / 2.5;          // radians per second
const LOOK = 0.004;                  // radians per dragged pixel
const MAX_PITCH = (30 * Math.PI) / 180;
const CORRIDOR = 0.05;               // how far from the filmed path visitors may step
const KEYS = {
  ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

const $ = (id) => document.getElementById(id);

let viewer = null;
let path = [];
let up = null;
const held = new Set();
let last = 0;
let lastMove = 0;

export function initWalk(v, tour) {
  if (!tour?.path?.length) return false;
  viewer = v;
  path = tour.path.map((p) => new THREE.Vector3(...p));
  up = new THREE.Vector3(...tour.up).normalize();
  v.camera.up.copy(up);
  v.controls.enabled = false;   // the orbit controls would fight the walk
  hideFloor(v);

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => held.clear());
  setupLook(v.renderer.domElement);
  setupPad();
  $('walkHint').hidden = false;
  setTimeout(() => $('walkHint').classList.add('fade'), 7000);
  keepRendering(v, 1500);
  requestAnimationFrame(tick);
  return true;
}

// ---------- Input ----------
function onKey(e) {
  const move = KEYS[e.code];
  if (!move || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;   // typing, not walking
  e.preventDefault();
  e.stopPropagation();          // the 3D viewer uses the arrows to roll the camera
  if (e.type === 'keydown') held.add(move); else held.delete(move);
}

function setupLook(canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || isFlying()) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    look(-dx * LOOK, -dy * LOOK);
    lastMove = performance.now();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cam = viewer.camera;
    cam.fov = Math.min(55, Math.max(20, cam.fov + Math.sign(e.deltaY) * 2));
    cam.updateProjectionMatrix();
    viewer.forceRenderNextFrame();
  }, { passive: false });
}

// On-screen pad for touch screens: hold a button to keep moving
function setupPad() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  $('walkPad').hidden = false;
  for (const b of $('walkPad').querySelectorAll('[data-move]')) {
    const move = b.dataset.move;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); held.add(move); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => held.delete(move));
  }
}

// ---------- Moving ----------
function forward() {
  return viewer.controls.target.clone().sub(viewer.camera.position);
}

function apply(position, dir) {
  const length = Math.max(0.3, dir.length());
  viewer.camera.position.copy(position);
  viewer.controls.target.copy(position).addScaledVector(dir.normalize(), length);
  viewer.camera.lookAt(viewer.controls.target);
  viewer.forceRenderNextFrame();
}

function look(yaw, pitch) {
  const dir = forward();
  dir.applyAxisAngle(up, yaw);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const tilted = dir.clone().applyAxisAngle(right, pitch);
  const elevation = Math.asin(tilted.clone().normalize().dot(up));
  if (Math.abs(elevation) < MAX_PITCH) dir.copy(tilted);
  apply(viewer.camera.position.clone(), dir);
}

// Keep the camera inside the corridor around the filmed path
function clamp(p) {
  let best = null, bestD = Infinity;
  for (const q of path) {
    const d = q.distanceToSquared(p);
    if (d < bestD) { bestD = d; best = q; }
  }
  const offset = p.clone().sub(best);
  if (offset.length() > CORRIDOR) offset.setLength(CORRIDOR);
  return best.clone().add(offset);
}

function tick(now) {
  if (!viewer.controls || viewer.isDisposingOrDisposed?.()) {   // another scene was opened by hand
    held.clear();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    $('walkHint').hidden = true;
    $('walkPad').hidden = true;
    return;
  }
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (held.size && !isFlying()) {
    const dir = forward();
    if (held.has('left')) dir.applyAxisAngle(up, TURN * dt);
    if (held.has('right')) dir.applyAxisAngle(up, -TURN * dt);
    const flat = dir.clone().addScaledVector(up, -dir.dot(up)).normalize();
    const step = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
    const position = viewer.camera.position.clone().addScaledVector(flat, step * SPEED * dt);
    apply(step ? clamp(position) : position, dir);
    lastMove = now;
    if (step) document.dispatchEvent(new Event('walk:move'));
  } else if (now - lastMove < 700) {
    viewer.forceRenderNextFrame();   // let the sort catch up after stopping
  }
  requestAnimationFrame(tick);
}
