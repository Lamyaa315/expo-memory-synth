// The passport stamps (Figma: account → "طوابعي"): one per pavilion, stamped when its tour is finished.
// Only the Kingdom pavilion has a tour today; the rest show what the app will hold. Kept in this browser only.
export const STAMPS = [
  { id: 'ksa', n: '01', name: 'جناح المملكة', img: 'img/stamps/stamp-01.png' },
  { id: 'oasis', n: '02', name: 'جناح الواحة', img: 'img/stamps/stamp-02.png' },
  { id: 'heritage', n: '03', name: 'جناح التراث', img: 'img/stamps/stamp-03.png' },
  { id: 'future', n: '04', name: 'جناح المستقبل', img: 'img/stamps/stamp-04.png' },
  { id: 'hospitality', n: '05', name: 'جناح الضيافة', img: 'img/stamps/stamp-05.png' },
  { id: 'world', n: '06', name: 'العالم في الرياض', img: 'img/stamps/stamp-06.png' },
];
const KEY = 'laqya-stamps';

// { id: time stamped }
export function earned() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

// Stamps a pavilion; true the first time
export function earn(id) {
  const all = earned();
  if (all[id]) return false;
  all[id] = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private window: shown, not kept */ }
  return true;
}

export const stampDate = (t) => new Date(t).toLocaleDateString('ar-SA-u-ca-gregory', { day: 'numeric', month: 'long' });
