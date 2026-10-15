// Shared by tour.html (viewer) and film.js (trip film).
// Each pavilion lives in its own folder, web/scenes/<id>/, with:
//   scene.splat (or scene.ply)  the 3D scan (scripts/clean_scene.py --splat makes the light .splat)
//   tour.json                   the filmed path and its stops (scripts/camera_path.py)
//   hotspots.json               the pieces and their explanations (tour.html?edit)
// The page shows one pavilion at a time: tour.html?scene=<id>, the first one by default.
// The first pavilion (IMG_0920 only) is kept in data/hall/site_backup/, the rock in data/rock/.
export const SCENES = [
  {
    id: 'corner',
    title: 'ركن النقوش',
    title_en: 'Inscriptions corner',
    // The last stop of the kingdoms corridor (web/scenes/hall), cut out with scripts/clean_scene.py and placed far
    // above this scan so the tour goes on into it without loading another page. Its stop in tour.json is moved
    // by the same offset.
    extras: [{ file: 'kingdoms.splat', lite: 'kingdoms-lite.splat', position: [0, 0, 40] }],
    camera: {
      cameraUp: [0, 0, 1],                          // gsplat's trainer usually turns "up" into +z
      initialCameraPosition: [0.3673, -2.3803, 0.1931],
      initialCameraLookAt: [0.8517, -0.5823, 0.1473],   // the first tour stop
    },
  },
];

// The kingdoms corridor on its own (web/scenes/hall): open it with tour.html?scene=hall.
// Its last stop is part of the corner's tour (see extras above).
export const OTHER_SCENES = [
  {
    id: 'hall',
    title: 'ممر الممالك',
    title_en: 'Kingdoms corridor',
    camera: {
      cameraUp: [0, 0, 1],
      initialCameraPosition: [1.4042, -0.4064, -0.0128],
      initialCameraLookAt: [1.2481, -0.0454, -0.0256],   // the first tour stop: the black stela
    },
  },
];

const wanted = new URLSearchParams(location.search).get('scene');
export const SCENE = [...SCENES, ...OTHER_SCENES].find((s) => s.id === wanted) || SCENES[0];

// A file of the current pavilion, e.g. sceneUrl('tour.json') -> 'scenes/corner/tour.json'
export const sceneUrl = (name) => `scenes/${SCENE.id}/${name}`;

// A link to another page (or this one) that keeps the current pavilion
export function withScene(href, id = SCENE.id) {
  const url = new URL(href, location.href);
  url.searchParams.set('scene', id);
  return url.pathname.split('/').pop() + url.search;
}

// Phones get a lighter copy of the scan (the first, biggest points of the .splat): the whole scan is more than a
// phone browser lets a page hold, and iPhone Safari closes the page ("A problem repeatedly occurred")
export const LITE = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/i.test(navigator.userAgent);

// The light copy loads first when it exists
export const SCENE_FILES = [...(LITE ? ['scene-lite.splat'] : []), 'scene.splat', 'scene.ply'].map(sceneUrl);

// First scene file that exists on the server, or null
export async function findScene() {
  for (const url of SCENE_FILES) {
    try {
      if ((await fetch(url, { method: 'HEAD', cache: 'no-cache' })).ok) return url;
    } catch { /* try the next one */ }
  }
  return null;
}

export const CAMERA = SCENE.camera;

// Soft floor under the scan so it doesn't float (scene units; the circle faces cameraUp). null to turn off.
// Walking hides it anyway. The first pavilion's was { center: [0.29, 0.27, -0.14], radius: 1.7 }.
export const FLOOR = SCENE.floor || null;

// Free walking with the arrow keys along the filmed path (walk.js). Off: visitors go from stop to stop
// (the arrows switch stops) and only look around a little at each, so the blurry parts stay out of view.
export const WALK = false;

// How far visitors can turn, tilt and zoom around each resting view (a tour stop, a hotspot), so they look
// around without drifting into parts the phone never saw. turnDeg can be [one way, other way].
// Not used while walking. The editor (?edit) has no limits. null to turn off.
export const LIMITS = { turnDeg: 20, tiltDeg: 8, zoomIn: 0.6, zoomOut: 1.1, pan: false };
