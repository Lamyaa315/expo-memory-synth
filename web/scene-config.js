// Shared by index.html (viewer) and film.js (trip film).
// Tweak these if the scene appears upside down or far away.
// These values fit the full pavilion (IMG_0920). The rock's are kept in data/rock/scene-config.js.
// The starting angle can also be saved from index.html?edit ("خذ الزاوية الحالية كبداية").
// The light copy (scripts/clean_scene.py --splat) loads first when it exists
export const SCENE_FILES = ['scene.splat', 'scene.ply'];

// First scene file that exists on the server, or null
export async function findScene() {
  for (const url of SCENE_FILES) {
    try {
      if ((await fetch(url, { method: 'HEAD', cache: 'no-cache' })).ok) return url;
    } catch { /* try the next one */ }
  }
  return null;
}

export const CAMERA = {
  cameraUp: [0, 0, 1],                    // gsplat's trainer usually turns "up" into +z
  initialCameraPosition: [0.13, -1.55, 0.22],
  initialCameraLookAt: [0.13, 0.8, 0.02],   // the stone wall
};

// Soft floor under the scan so it doesn't float (scene units; the circle faces cameraUp). null to turn off.
export const FLOOR = { center: [0.29, 0.27, -0.14], radius: 1.7 };

// How far visitors can turn, tilt and zoom around each resting view (the start, a tour stop, a hotspot),
// so they look around without drifting into parts the phone never saw. turnDeg can be [one way, other way].
// The editor (?edit) has no limits. null to turn off.
export const LIMITS = { turnDeg: 30, tiltDeg: 12, zoomIn: 0.35, zoomOut: 1.25, pan: false };
