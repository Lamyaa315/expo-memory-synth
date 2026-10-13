// Look-alikes from other cultures: at each tour stop a small card shows pieces from elsewhere that resemble
// what the visitor is looking at (an inscribed stele in Egypt, runestones in Scandinavia...), with a line on
// what is alike. The pictures and links come from Wikipedia (its page summary API), loaded by the visitor's
// browser and credited on the card. The pieces and the lines are in web/scenes/<id>/story.json ("links").

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';
const cache = new Map();   // wiki title -> summary promise

function summary(title) {
  if (!cache.has(title)) {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    cache.set(title, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(title);
}

let shown = 0;   // bumps on every stop so a slow picture never lands on the wrong one

async function show(links) {
  const card = $('cultureCard');
  const token = ++shown;
  card.classList.remove('on');
  if (!links?.length) return;
  const items = (await Promise.all(links.map(async (l) => ({ l, s: await summary(l.wiki) }))))
    .filter(({ s }) => s?.thumbnail?.source);
  if (token !== shown || !items.length) return;
  const en = lang() === 'en';
  $('cultureTitle').textContent = en ? 'Looks like… elsewhere in the world' : 'يشبهه من حضارات ثانية';
  $('cultureList').replaceChildren(...items.map(({ l, s }) => {
    const a = document.createElement('a');
    a.className = 'culture-item';
    a.href = s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(l.wiki)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = s.thumbnail.source;
    img.alt = en ? s.title : l.title;
    img.loading = 'lazy';
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = en ? s.title : l.title;
    const why = document.createElement('small');
    why.textContent = en ? (s.description || '') : l.why;
    text.append(name, why);
    a.append(img, text);
    return a;
  }));
  $('cultureCredit').textContent = en ? 'Pictures: Wikipedia' : 'الصور من ويكيبيديا';
  card.classList.add('on');
}

export function initCulture() {
  document.addEventListener('tour:arrive', (e) => show(e.detail?.story?.links));
  document.addEventListener('tour:move', () => { ++shown; $('cultureCard').classList.remove('on'); });
  $('cultureClose').addEventListener('click', () => { ++shown; $('cultureCard').classList.remove('on'); });
}
