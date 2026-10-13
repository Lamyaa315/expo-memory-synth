// Makes a partial scan feel grounded instead of floating in space, and moves the camera around it:
// - a soft floor under the scan
// - camera limits around the current view, so visitors look around without drifting into the parts the
//   phone never saw (a scan is only sharp near where it was filmed)
// - smooth camera flights (tour stops, hotspots) that lift the limits while moving
// Settings live in scene-config.js (FLOOR, LIMITS); both are optional.
import * as THREE from 'three';
import * as config from './scene-config.js';

const rad = (deg) => (deg * Math.PI) / 180;
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let limitsOn = false;
let flight = null;
let home = null;   // where "back to the whole scene" returns: the start, or the current tour stop

// ---------- Floor ----------
// A THREE.Scene with a soft round floor, for the viewer's `threeScene` option (undefined = no floor)
export function makeFloorScene() {
  const floor = config.FLOOR;
  if (!floor) return undefined;

  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(96, 82, 64, 0.9)');
  grad.addColorStop(0.55, 'rgba(72, 60, 46, 0.55)');
  grad.addColorStop(1, 'rgba(40, 34, 28, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(floor.radius, 64),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  // The circle faces +Z: turn it to face the scene's "up"
  const up = new THREE.Vector3(...config.CAMERA.cameraUp).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
  mesh.position.fromArray(floor.center);
  mesh.userData.floor = true;

  const scene = new THREE.Scene();
  scene.add(mesh);
  return scene;
}

// Inside a walked-through scan the real floor is there, and the soft floor would cover the splats
export function hideFloor(viewer) {
  viewer?.threeScene?.children.forEach((c) => { if (c.userData.floor) c.visible = false; });
  viewer?.forceRenderNextFrame();
}

// ---------- Limits ----------
// Visitors only (the editor goes anywhere): from now on, every resting view gets limits around it
export function enableLimits(viewer) {
  limitsOn = !!config.LIMITS;
  applyLimits(viewer);
}

function applyLimits(viewer) {
  const limits = config.LIMITS;
  const c = viewer?.controls;
  if (!limitsOn || !limits || !c) return;
  c.update();
  const azimuth = c.getAzimuthalAngle();
  const polar = c.getPolarAngle();
  const distance = c.getDistance();
  if (limits.turnDeg != null) {
    // A number turns the same both ways; [a, b] allows a degrees one way and b the other
    const [a, b] = Array.isArray(limits.turnDeg) ? limits.turnDeg : [limits.turnDeg, limits.turnDeg];
    c.minAzimuthAngle = azimuth - rad(a);
    c.maxAzimuthAngle = azimuth + rad(b);
  }
  if (limits.tiltDeg != null) {
    c.minPolarAngle = Math.max(0.05, polar - rad(limits.tiltDeg));
    c.maxPolarAngle = Math.min(rad(limits.maxPolarDeg ?? 179), polar + rad(limits.tiltDeg));
  }
  if (limits.zoomIn) c.minDistance = distance * limits.zoomIn;
  if (limits.zoomOut) c.maxDistance = distance * limits.zoomOut;
  if (limits.pan === false) c.enablePan = false;
}

function liftLimits(c) {
  c.minAzimuthAngle = -Infinity;
  c.maxAzimuthAngle = Infinity;
  c.minPolarAngle = 0;
  c.maxPolarAngle = Math.PI;
  c.minDistance = 0;
  c.maxDistance = Infinity;
}

// ---------- Moving the camera ----------
export const currentView = (viewer) => ({
  position: viewer.camera.position.clone(),
  target: viewer.controls.target.clone(),
});

export function setHome(view) {
  home = view && { position: view.position.clone(), target: view.target.clone() };
}

export const isFlying = () => flight !== null;

// The viewer re-sorts splats (and picks which parts of the scene to draw) only after the camera moves a
// full scene unit or turns ~8 degrees. Our scans are only a couple of units across, so walking a little
// left the view sorted for an old spot: empty, smeared or overlapping. Re-sort on small moves too.
const SORT_MOVE = 0.03;   // scene units
const SORT_TURN = 0.999;  // cosine of the angle
export function trackSorting(viewer) {
  const lastPos = new THREE.Vector3(Infinity, 0, 0);
  const lastDir = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const frame = () => {
    if (viewer.isDisposingOrDisposed?.()) return;
    const cam = viewer.camera;
    if (cam && viewer.splatRenderReady && !viewer.sortRunning) {
      cam.updateMatrixWorld();
      dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
      if (cam.position.distanceTo(lastPos) > SORT_MOVE || dir.dot(lastDir) < SORT_TURN) {
        lastPos.copy(cam.position);
        lastDir.copy(dir);
        viewer.runSplatSort(true);   // the viewer redraws when the sort finishes
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Keep drawing for a moment after the camera stops, while the last sort lands.
export function keepRendering(viewer, ms = 800) {
  const until = performance.now() + ms;
  const frame = () => {
    viewer.forceRenderNextFrame();
    if (performance.now() < until) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

export const getHome = () => home && { position: home.position.clone(), target: home.target.clone() };

// Glide to { position, target } (THREE.Vector3s). A new flight replaces the one in progress.
export function flyTo(viewer, view, { seconds = 1.2, onDone } = {}) {
  const cam = viewer.camera;
  const ctl = viewer.controls;
  viewer.transitioningCameraTarget = false;   // cancel the viewer's own click-to-focus animation
  liftLimits(ctl);
  const f = flight = { start: performance.now(), p0: cam.position.clone(), q0: ctl.target.clone() };
  const finish = () => {
    if (flight !== f) return;
    flight = null;
    applyLimits(viewer);
    keepRendering(viewer);
    onDone?.();
  };
  const place = (k) => {
    cam.position.lerpVectors(f.p0, view.position, k);
    ctl.target.lerpVectors(f.q0, view.target, k);
    cam.lookAt(ctl.target);
  };
  if (reduceMotion || seconds <= 0) {
    place(1);
    viewer.forceRenderNextFrame();
    finish();
    return;
  }
  const step = (now) => {
    if (flight !== f) return;
    const k = ease((now - f.start) / 1000 / seconds);
    place(k);
    if (k < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
}
