// Shared by index.html (viewer) and film.js (trip film).
// Tweak these if the scene appears upside down or far away.
export const SCENE_URL = 'scene.ply';

export const CAMERA = {
  cameraUp: [0, -1, 0],              // COLMAP scenes are usually Y-down
  initialCameraPosition: [0, -1, -4],
  initialCameraLookAt: [0, 0, 0],
};
