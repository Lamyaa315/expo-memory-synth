// The visitor's saved trips (Figma: "رحلاتك المحفوظة"), kept in this browser only: the list (title, date,
// photo count, length, a small thumbnail) in localStorage, the films themselves in IndexedDB.
const KEY = 'laqya-memories';
const DB = 'laqya', STORE = 'films';

export function list() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function db() {
  return new Promise((ok, no) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => ok(req?.result);
    t.onerror = () => no(t.error);
  });
}

// trip: { title, photos, seconds, voice, thumb, story, type }; film: the video Blob. Returns the trip's id.
export async function save(trip, film) {
  const id = `t${Date.now()}`;
  const all = list();
  all.unshift({ id, at: Date.now(), ...trip, hasFilm: false });
  try {
    await tx('readwrite', (s) => s.put(film, id));
    all[0].hasFilm = true;
  } catch { /* no IndexedDB (private window): the trip is listed, its film stays a download */ }
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, 30))); } catch { /* full or blocked */ }
  return id;
}

export async function film(id) {
  try { return await tx('readonly', (s) => s.get(id)); } catch { return null; }
}

export async function remove(id) {
  try { localStorage.setItem(KEY, JSON.stringify(list().filter((t) => t.id !== id))); } catch {}
  try { await tx('readwrite', (s) => s.delete(id)); } catch {}
}

export async function clear() {
  try { localStorage.removeItem(KEY); } catch {}
  try { await tx('readwrite', (s) => s.clear()); } catch {}
}

// "0:48"
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
