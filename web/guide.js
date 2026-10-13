// The tour guide: the visitor asks about whatever is in front of them ("which civilization is this from?",
// "how old is it?"). The question goes to scripts/server.py with a picture of the current view, so the model
// can see the piece and read any museum label in it; the answer is read aloud. Facts come only from the labels
// and from what the team wrote in the pavilion's hotspots.json.
// Hidden when the page runs without that server (python -m http.server, GitHub Pages).

import * as voice from './voice.js';
import { SCENE, sceneUrl } from './scene-config.js';
import { captureView } from './hotspots.js';

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.dataset.lang || 'ar';
const isArabic = (text) => /[؀-ۿ]/.test(text);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const history = [];   // [{ role, content }] for this pavilion
let demo = false;
let busy = false;
let listening = null;

export async function initGuide() {
  let available = false;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    available = res.ok && (await res.json()).guide === true;
  } catch { /* static server */ }
  if (!available) return;
  $('guide').hidden = false;
  $('guideBtn').hidden = false;
  usePhoto();
  $('guideMic').hidden = !Recognition;
  // Notes marked as demo (web/scenes/<id>/guide.json) are not from the museum: say so under the box
  try {
    const res = await fetch(sceneUrl('guide.json'), { cache: 'no-cache' });
    demo = res.ok && (await res.json()).demo === true;
  } catch { demo = false; }
  labels();
  // He waves and introduces himself once the scene is up, and the greeting stays while the panel is closed
  setTimeout(() => {
    $('guideBtn').classList.add('waving');
    greet();
    setTimeout(() => $('guideBtn').classList.remove('waving'), 2200);
  }, 2500);
  document.addEventListener('panel:close', greet);
}

const GUIDE_NAME = { ar: 'سعد', en: 'Saad' };
function greet() {
  if (!$('panel').classList.contains('closed')) return;
  say(lang() === 'en'
    ? `Hello! I'm ${GUIDE_NAME.en}, your guide. Ask me anything you like.`
    : `هلا والله! أنا ${GUIDE_NAME.ar}، مرشدك. اسألني عن اللي تبي`);
}

// A realistic picture (web/guide.png) replaces the drawing when it exists
function usePhoto() {
  const img = $('guidePhoto');
  img.onload = () => { img.hidden = false; $('guideBtn').classList.add('has-photo'); };
  img.onerror = () => img.remove();
  img.src = 'guide.png';
}

// A short line in his speech bubble
let bubbleTimer = null;
function say(text, ms = 0) {
  const b = $('guideBubble');
  clearTimeout(bubbleTimer);
  b.textContent = text;
  b.classList.toggle('on', !!text);
  if (text && ms) bubbleTimer = setTimeout(() => b.classList.remove('on'), ms);
}

// Show the guide in the panel (from the floating button)
function open() {
  document.dispatchEvent(new Event('guide:open'));   // pauses the automatic tour
  document.dispatchEvent(new Event('tour:move'));   // closes an open hotspot, back to the main view
  $('panel').classList.remove('closed', 'collapsed');
  say('');
  $('guide').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('guideInput').focus({ preventScroll: true });
}

function labels() {
  const en = lang() === 'en';
  $('guideTitle').textContent = en ? 'Ask the guide' : 'اسأل المرشد';
  $('guideIntro').textContent = en
    ? 'Ask about anything in front of you: which civilization it is from, how old it is, what is written on it…'
    : 'اسألني عن أي قطعة قدامك: من أي حضارة، كم عمرها، وش مكتوب عليها…';
  $('guideInput').placeholder = en ? 'e.g. How old is this stone?' : 'مثلاً: كم عمر هالحجر؟';
  $('guideInput').dir = en ? 'ltr' : 'rtl';
  $('guideSend').textContent = en ? 'Ask' : 'اسأل';
  // Ready questions: one tap asks them
  const chips = en
    ? ['Which civilization is it from?', 'How old is it?', 'What does it resemble in other cultures?']
    : ['من أي حضارة؟', 'كم عمره تقريباً؟', 'وش يشبهه في حضارات ثانية؟'];
  $('guideChips').replaceChildren(...chips.map((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => send(q));
    return b;
  }));
  $('guideDemo').hidden = !demo;
  $('guideDemo').textContent = en
    ? 'Demo information for this showcase, not from the museum labels yet.'
    : 'المعلومات حالياً تجريبية للعرض، ومو من لوحات المتحف.';
  $('guideMic').setAttribute('aria-label', en ? 'Ask with your voice' : 'اسأل بصوتك');
  $('guideBtn').setAttribute('aria-label', en ? 'Ask the guide' : 'اسأل المرشد');
}

function bubble(role, text, extra = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extra}`.trim();
  div.dir = isArabic(text) ? 'rtl' : 'ltr';
  div.textContent = text;
  return div;
}

async function send(question) {
  question = question.trim();
  if (!question || busy) return;
  const en = lang() === 'en';
  busy = true;
  voice.unlock();   // still inside the tap: lets the spoken answer play when it arrives
  $('guideSend').disabled = true;
  $('guideInput').value = '';
  const box = $('guideChat');
  box.hidden = false;
  box.appendChild(bubble('user', question));
  const wait = box.appendChild(bubble('assistant', en ? 'Let me look…' : 'خلني أشوف…', 'pending'));
  say(en ? 'Let me look…' : 'خلني أشوف…');
  wait.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  let answer = null;
  try {
    // What the visitor is looking at right now (without it he answers from the pavilion's notes)
    const image = await captureView().catch(() => null);
    const res = await fetch('/api/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scene: SCENE.id, scene_title: en ? SCENE.title_en : SCENE.title,
        image, question, lang: lang(), history,
      }),
    });
    if (res.ok) answer = (await res.json()).answer;
  } catch { /* shown below */ }

  wait.remove();
  if (answer) {
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    box.appendChild(bubble('assistant', answer)).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    document.dispatchEvent(new Event('hotspot:play'));   // pauses the scene's audio tour
    say('');
    $('guideBtn').classList.add('speaking');
    const reply = box.lastElementChild;
    voice.speak(answer, {
      onend: () => $('guideBtn').classList.remove('speaking'),
      onblocked: (play) => {   // the browser wants a tap before it plays sound
        $('guideBtn').classList.remove('speaking');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ghost listen-btn';
        b.textContent = en ? '▶ Play the answer' : '▶ اسمع الجواب';
        b.addEventListener('click', () => { b.remove(); $('guideBtn').classList.add('speaking'); play(); });
        reply.after(b);
      },
    });
  } else {
    say('');
    box.appendChild(bubble('assistant', en ? "I couldn't answer right now. Try again in a moment." : 'ما قدرت أجاوب الحين. جرّب بعد شوي.', 'error'));
  }
  busy = false;
  $('guideSend').disabled = false;
}

// ---------- Voice question (Chrome, Edge, Safari) ----------
function startListening() {
  if (!Recognition || listening) return;
  const r = new Recognition();
  r.lang = lang() === 'en' ? 'en-US' : 'ar-SA';
  r.interimResults = true;
  r.onresult = (e) => {
    const text = [...e.results].map((x) => x[0].transcript).join('');
    $('guideInput').value = text;
    if (e.results[e.results.length - 1].isFinal) send(text);
  };
  r.onend = r.onerror = () => { listening = null; $('guideMic').classList.remove('on'); };
  voice.stop();
  listening = r;
  $('guideMic').classList.add('on');
  r.start();
}

function stopListening() {
  if (listening) listening.abort();
  listening = null;
  $('guideMic').classList.remove('on');
}

$('guideForm').addEventListener('submit', (e) => { e.preventDefault(); send($('guideInput').value); });
$('guideMic').addEventListener('click', () => (listening ? stopListening() : startListening()));
$('guideBtn').addEventListener('click', open);
document.addEventListener('langchange', labels);
