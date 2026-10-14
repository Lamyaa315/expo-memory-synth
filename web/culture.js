// Look-alikes from other cultures: at each tour stop a small card shows pieces from elsewhere that resemble
// what the visitor is looking at (a Kufic tombstone in Egypt, a stele from Al-Andalus found in Mali...), with a
// line on what is alike. The pieces and the lines are in web/scenes/<id>/story.json ("links"): each has either
// "img" + "page" (a picture on Wikimedia Commons, chosen to look like the piece) or "wiki" (a Wikipedia article,
// whose picture comes from its page summary API). Loaded by the visitor's browser and credited on the card.

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
let current = null;   // the links on the card, to redraw it in another language

async function show(links) {
  const card = $('cultureCard');
  const token = ++shown;
  card.classList.remove('on');
  current = links || null;
  if (!links?.length) return;
  const items = (await Promise.all(links.map(async (l) => {
    if (l.img) return { l, img: l.img, page: l.page };
    const s = await summary(l.wiki);
    return { l, img: s?.thumbnail?.source, page: s?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(l.wiki)}` };
  }))).filter((x) => x.img);
  if (token !== shown || !items.length) return;
  const en = lang() === 'en';
  $('cultureTitle').textContent = en ? 'Looks like… elsewhere in the world' : 'يشبهه من حضارات ثانية';
  $('cultureTitle').dir = $('cultureCredit').dir = en ? 'ltr' : 'rtl';
  $('cultureList').replaceChildren(...items.map(({ l, img: src, page }) => {
    const title = en ? l.title_en || l.title : l.title;
    const a = document.createElement('a');
    a.className = 'culture-item';
    a.href = page;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = src;
    img.alt = title;
    img.loading = 'lazy';
    const text = document.createElement('span');
    text.dir = en ? 'ltr' : 'rtl';
    const name = document.createElement('b');
    name.textContent = title;
    const why = document.createElement('small');
    why.textContent = en ? l.why_en || '' : l.why;
    text.append(name, why);
    a.append(img, text);
    return a;
  }));
  $('cultureCredit').textContent = en ? 'Pictures: Wikimedia Commons and Wikipedia (tap one for its source and licence)'
    : 'الصور من ويكيميديا كومنز وويكيبيديا (اضغط الصورة لمصدرها ورخصتها)';
  card.classList.add('on');
}

export function initCulture() {
  document.addEventListener('tour:arrive', (e) => show(e.detail?.story?.links));
  document.addEventListener('tour:move', () => { ++shown; current = null; $('cultureCard').classList.remove('on'); });
  document.addEventListener('langchange', () => { if (current && $('cultureCard').classList.contains('on')) show(current); });
  $('cultureClose').addEventListener('click', () => { ++shown; current = null; $('cultureCard').classList.remove('on'); });
}
