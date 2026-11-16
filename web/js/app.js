import { Sensor, gestureRow } from './sensor.js';
import { Segmenter, State, predictLetter, tracePoints } from './letters.js';
import { GestureMode, GESTURES, GLYPHS, LABELS, loadGestureModel } from './gestures.js';
import { Instruments } from './instruments.js';
import { WatchLink } from './watch.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const pct = (x) => `${Math.round(x * 100)}%`;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const sensor = new Sensor();
const watch = new WatchLink();
const segmenter = new Segmenter();
const instruments = new Instruments({
  toggle: $('drawer-toggle'), body: $('instruments-body'), spark: $('spark'), rate: $('rate-readout'),
  acc: $('chart-acc'), gyro: $('chart-gyro'), roll: $('ro-roll'), pitch: $('ro-pitch'), yaw: $('ro-yaw'),
  rateRo: $('ro-rate'), count: $('ro-count'), motion: $('ro-motion'),
});

let mode = location.hash === '#gestures' ? 'gestures' : store.get('airwrite.mode', 'letters');
let gestures = null;       // GestureMode once the model has loaded
let gestureModel = null;
let lettersHealth = { state: 'loading', detail: '' };

/* ------------------------------------------------------------------ tabs */

const tabs = { letters: $('tab-letters'), gestures: $('tab-gestures') };
const panels = { letters: $('panel-letters'), gestures: $('panel-gestures') };

function setMode(next, focus = false) {
  mode = next;
  for (const key of Object.keys(tabs)) {
    const on = key === next;
    tabs[key].setAttribute('aria-selected', String(on));
    tabs[key].tabIndex = on ? 0 : -1;
    panels[key].hidden = !on;
  }
  if (focus) tabs[next].focus();
  store.set('airwrite.mode', next);
  history.replaceState(null, '', next === 'gestures' ? '#gestures' : location.pathname);
  segmenter.reset();
  if (gestures) gestures.reset();
  if (next === 'letters') { trace.resize(); refreshLettersStatus(); } else refreshGestureStatus();
}

Object.entries(tabs).forEach(([key, tab]) => {
  tab.addEventListener('click', () => setMode(key));
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setMode(key === 'letters' ? 'gestures' : 'letters', true); }
  });
});

/* ---------------------------------------------------------------- sensor */

const sensorEl = $('sensor');
const connectBtn = $('connect');

function renderSensor(state, detail = '') {
  sensorEl.dataset.state = state;
  const name = $('sensor-name'), info = $('sensor-detail');
  connectBtn.disabled = state === 'choosing' || state === 'connecting' || !Sensor.supported;
  const live = state === 'live' || state === 'reconnecting';
  connectBtn.textContent = live ? 'Disconnect' : 'Connect sensor';
  connectBtn.classList.toggle('btn-solid', !live);
  switch (state) {
    case 'choosing': name.textContent = 'Choose your sensor'; info.textContent = 'in the browser’s list'; break;
    case 'connecting': name.textContent = sensor.name || 'Sensor'; info.textContent = 'Connecting…'; break;
    case 'live': name.textContent = sensor.name; info.textContent = 'Connected'; break;
    case 'reconnecting': name.textContent = sensor.name; info.textContent = `Reconnecting (${detail})`; break;
    case 'demo': name.textContent = 'Sample recording'; info.textContent = 'Playing'; break;
    default: name.textContent = 'No sensor'; info.textContent = detail === 'lost' ? 'Connection lost' : 'Not connected';
  }
  refreshLettersStatus();
  refreshGestureStatus();
}

sensor.addEventListener('state', (e) => {
  const { state, detail } = e.detail;
  if (state !== 'live' && state !== 'demo') { segmenter.reset(); }
  if (state === 'demo' || state === 'live') instruments.clear();
  renderSensor(state, detail);
});

connectBtn.addEventListener('click', async () => {
  if (sensor.state === 'live' || sensor.state === 'reconnecting') { sensor.disconnect(); return; }
  try {
    await sensor.connect();
  } catch (err) {
    sensor.disconnect();
    const msg = err && err.message ? err.message : String(err);
    setStatus(mode, 'error', `Couldn’t connect: ${msg}. Check the sensor is on and not connected to another app.`);
  }
});

setInterval(() => {
  const hz = sensor.state === 'live' || sensor.state === 'demo' ? sensor.rate : 0;
  instruments.setRate(hz);
  if (sensor.state === 'live') {
    $('sensor-detail').textContent = hz > 0 && hz < 80 ? `${hz.toFixed(0)} Hz · expected 100` : `${hz.toFixed(0)} Hz`;
  }
}, 1000);

if (!Sensor.supported) {
  $('unsupported').hidden = false;
  connectBtn.title = 'This browser can’t use Bluetooth devices';
}

/* ------------------------------------------------------------ status lines */

function setStatus(which, state, text) {
  const line = $(`${which}-status`);
  line.dataset.state = state;
  $(`${which}-status-text`).textContent = text;
}

/* ------------------------------------------------------------------ trace */

const trace = {
  canvas: $('trace'),
  paper: $('paper'),
  samples: [],
  options: { method: 'movement', swap: false, flipX: false, flipY: false, ...store.get('airwrite.trace', {}) },
  resize() { this.draw(this.samples, this.final); },
  draw(samples, final = false) {
    this.samples = samples;
    this.final = final;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const box = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(box.width * dpr));
    c.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    this.paper.dataset.hasTrace = String(samples.length > 1);
    if (samples.length < 2) return;

    const { points: pts, minSpan } = tracePoints(samples, { ...this.options, still: segmenter.stop });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const left = 64 * dpr, pad = 36 * dpr;
    const w = c.width - left - pad, h = c.height - 2 * pad;
    const span = Math.max(maxX - minX, maxY - minY, minSpan); // keeps tiny jitter from filling the page
    const scale = Math.min(w, h) / span;
    const ox = left + (w - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = pad + (h - (maxY - minY) * scale) / 2 - minY * scale;
    const at = (p) => [ox + p[0] * scale, oy + p[1] * scale];

    const path = new Path2D();
    pts.forEach((p, i) => { const [x, y] = at(p); if (i) path.lineTo(x, y); else path.moveTo(x, y); });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = cssVar('--pink');
    ctx.globalAlpha = final ? 0.9 : 0.6;
    ctx.lineWidth = 16 * dpr;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cssVar('--plum');
    ctx.lineWidth = 5 * dpr;
    ctx.stroke(path);
    const [sx, sy] = at(pts[0]);
    ctx.fillStyle = cssVar('--rose');
    ctx.beginPath(); ctx.arc(sx, sy, 6 * dpr, 0, Math.PI * 2); ctx.fill();
  },
};
window.addEventListener('resize', () => trace.resize());

const settings = $('settings');
const opts = { swap: $('opt-swap'), flipX: $('opt-flipx'), flipY: $('opt-flipy') };
Object.entries(opts).forEach(([key, input]) => {
  input.checked = !!trace.options[key];
  input.addEventListener('change', () => { trace.options[key] = input.checked; store.set('airwrite.trace', trace.options); trace.resize(); });
});
document.querySelectorAll('input[name="trace-method"]').forEach((radio) => {
  radio.checked = radio.value === trace.options.method;
  radio.addEventListener('change', () => { trace.options.method = radio.value; store.set('airwrite.trace', trace.options); trace.resize(); });
});
$('open-settings').addEventListener('click', () => settings.showModal());

/* ---------------------------------------------------------------- letters */

let listening = true;
let calibration = null;   // { samples, until } while calibrating
let reading = false;
let wasWriting = false;
let traceQueued = false;
let text = store.get('airwrite.text', '');

function refreshLettersStatus() {
  if (calibration || reading) return;
  if (sensor.state === 'demo') return setStatus('letters', 'idle', 'The sample recording only has gestures. Connect your sensor to write letters.');
  if (sensor.state !== 'live') return setStatus('letters', 'idle', sensor.state === 'reconnecting' ? 'Reconnecting to the sensor…' : 'Connect your sensor to start.');
  if (!listening) return setStatus('letters', 'paused', 'Paused. Movements are ignored until you resume.');
  if (lettersHealth.state === 'loading') return setStatus('letters', 'ready', 'Ready to draw. Letter recognition is still starting up on the server…');
  if (lettersHealth.state !== 'ready') return setStatus('letters', 'error', 'Letter recognition isn’t available on this server right now. Your strokes are still drawn.');
  setStatus('letters', 'ready', 'Ready. Write a letter, then hold still.');
}

$('listen-toggle').addEventListener('click', (e) => {
  listening = !listening;
  segmenter.reset();
  e.currentTarget.textContent = listening ? 'Pause' : 'Resume';
  e.currentTarget.setAttribute('aria-pressed', String(!listening));
  refreshLettersStatus();
});

$('calibrate').addEventListener('click', () => {
  if (sensor.state !== 'live') { setStatus('letters', 'error', 'Connect your sensor first, then calibrate.'); return; }
  segmenter.reset();
  calibration = { samples: [], started: performance.now() };
  setStatus('letters', 'calibrating', 'Hold the sensor completely still…');
});

function finishCalibration() {
  try {
    const r = segmenter.calibrate(calibration.samples);
    calibration = null;
    setStatus('letters', 'ready', `Calibrated (resting noise ${r.baseline.toFixed(1)}). Write a letter, then hold still.`);
  } catch (err) {
    calibration = null;
    setStatus('letters', 'error', err.message);
  }
}

function showLetter(result) {
  const el = $('letter');
  el.textContent = result.letter || (result.top3 && result.top3[0] ? result.top3[0].letter : '?');
  el.dataset.empty = 'false';
  el.style.opacity = result.accepted ? '1' : '0.45';
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  const score = Number(result.confidence || 0).toFixed(2);
  const using = result.used_watch ? ' · pen + watch' : '';
  $('letter-meta').innerHTML = result.accepted
    ? `Match score <b>${score}</b>${using}`
    : `Low match score <b>${score}</b>, so it wasn’t added${using}`;
  const alts = (result.top3 || []).slice(1).map((t) => t.letter).filter(Boolean);
  $('letter-alts').hidden = !alts.length;
  $('letter-alts-list').replaceChildren(...alts.map((l) => Object.assign(document.createElement('span'), { textContent: l })));
}

async function readLetter(samples) {
  trace.draw(samples, true);
  if (lettersHealth.state !== 'ready') {
    segmenter.reset();
    refreshLettersStatus();
    return;
  }
  reading = true;
  setStatus('letters', 'reading', 'Reading your letter…');
  try {
    const result = await predictLetter(samples, { watchCode: watch.code });
    showLetter(result);
    if (result.accepted && result.letter) { text += result.letter; renderText(); }
    reading = false;
    setStatus('letters', 'ready', result.accepted ? 'Got it. Write the next letter.' : 'Not sure about that one. Try writing it again.');
  } catch (err) {
    reading = false;
    setStatus('letters', 'error', `Couldn’t read that letter: ${err.message}. Try again.`);
  } finally {
    segmenter.reset();
  }
}

function onLetterSample(s) {
  if (calibration) {
    calibration.samples.push(s);
    const left = 2 - (performance.now() - calibration.started) / 1000;
    if (left <= 0) finishCalibration();
    else setStatus('letters', 'calibrating', `Hold the sensor completely still… ${left.toFixed(1)} s`);
    return;
  }
  if (!listening || reading) return;
  const letter = segmenter.update(s);
  const writing = segmenter.state === State.WRITING;
  if (writing && !wasWriting) setStatus('letters', 'writing', 'Writing…');
  if (!writing && wasWriting && !letter) refreshLettersStatus(); // too short to count
  wasWriting = writing;
  if (writing && !traceQueued) {
    traceQueued = true;
    requestAnimationFrame(() => { traceQueued = false; if (segmenter.state === State.WRITING) trace.draw(segmenter.active); });
  }
  if (letter) { wasWriting = false; readLetter(letter); }
}

function renderText() {
  $('composed-text').textContent = text;
  $('composed-placeholder').hidden = text.length > 0;
  store.set('airwrite.text', text);
}
const addSpace = () => { text += ' '; renderText(); };
const backspace = () => { text = text.slice(0, -1); renderText(); };
$('add-space').addEventListener('click', addSpace);
$('backspace').addEventListener('click', backspace);
$('clear').addEventListener('click', () => { text = ''; renderText(); });
$('copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Couldn’t copy'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
});
document.addEventListener('keydown', (e) => {
  if (mode !== 'letters' || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || settings.open) return;
  if (e.key === ' ') { e.preventDefault(); addSpace(); }
  else if (e.key === 'Backspace') { e.preventDefault(); backspace(); }
});
renderText();

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    lettersHealth = data.letters || { state: 'unavailable' };
  } catch {
    lettersHealth = { state: 'unavailable', detail: 'server unreachable' };
  }
  refreshLettersStatus();
  if (lettersHealth.state === 'loading') setTimeout(checkHealth, 4000);
}
checkHealth();

/* ------------------------------------------------------------ apple watch */

const watchDialog = $('watch-dialog');

function renderWatch() {
  const chip = $('watch');
  const st = watch.status;
  chip.dataset.state = watch.state;
  $('watch-status').dataset.state = watch.state === 'receiving' ? 'receiving' : (watch.state === 'nomotion' || watch.state === 'expired') ? 'nomotion' : 'waiting';
  const detail = {
    off: 'Not paired',
    pairing: 'Getting a code…',
    waiting: `Code ${watch.code} · waiting`,
    receiving: `${st ? st.rate_hz.toFixed(0) : '?'} Hz · used for letters`,
    nomotion: 'Data has no motion values',
    expired: 'Pairing expired',
  }[watch.state];
  $('watch-detail').textContent = detail;
  $('watch-pair').textContent = watch.code ? 'Details' : 'Pair';
  $('watch-pair').disabled = watch.state === 'pairing';
  $('watch-url').textContent = watch.url;
  $('watch-status-text').textContent = {
    waiting: st && st.samples > 0 ? 'Data stopped arriving. Is SensorLog still streaming?' : 'Waiting for the first data…',
    receiving: `Receiving ${st ? st.rate_hz.toFixed(0) : ''} samples a second. Letters now use the pen and the watch.`,
    nomotion: 'Data is arriving, but it has no motion values the app recognises. Check SensorLog is sending the watch’s accelerometer, gyroscope and orientation.',
    expired: 'This pairing expired. Pair again to get a new address.',
    pairing: 'Getting a code…', off: '',
  }[watch.state];
  $('watch-unpair').hidden = !watch.code;
}
watch.addEventListener('change', renderWatch);

$('watch-pair').addEventListener('click', async () => {
  $('watch-local').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!watch.code) {
    try { await watch.pair(); } catch (err) { setStatus('letters', 'error', `${err.message}.`); return; }
  }
  renderWatch();
  watchDialog.showModal();
});
$('watch-unpair').addEventListener('click', () => { watch.unpair(); watchDialog.close(); });
$('watch-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(watch.url); btn.textContent = 'Copied'; } catch { btn.textContent = 'Select it'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
});
renderWatch();

/* --------------------------------------------------------------- gestures */

const stage = $('stage');
const glyphPath = $('glyph-path');
let fadeTimer = null;
let demoRows = null;

function refreshGestureStatus() {
  const demoBtn = $('demo');
  demoBtn.textContent = sensor.state === 'demo' ? 'Stop sample' : 'Play sample gestures';
  demoBtn.disabled = sensor.state === 'live' || sensor.state === 'reconnecting' || !gestures;
  if (!gestures) return setStatus('gestures', gestureModel === false ? 'error' : 'idle', gestureModel === false ? 'The gesture model didn’t load. Refresh the page to try again.' : 'Loading the gesture model…');
  if (sensor.state === 'live') return setStatus('gestures', 'ready', 'Listening. Make one quick swipe or circle, then pause.');
  if (sensor.state === 'demo') return setStatus('gestures', 'reading', 'Playing a recording of all six gestures…');
  if (sensor.state === 'reconnecting') return setStatus('gestures', 'paused', 'Reconnecting to the sensor…');
  setStatus('gestures', 'idle', 'Connect your sensor, or play the sample recording.');
}

function buildOdds(classes) {
  const order = [...GESTURES, 'return', 'idle'].filter((c) => classes.includes(c));
  $('odds').replaceChildren(...order.map((c) => {
    const li = document.createElement('li');
    li.dataset.cls = c;
    if (!GESTURES.includes(c)) li.classList.add('not-gesture');
    li.innerHTML = `<span>${LABELS[c] || c}</span><span class="track"><span class="fill"></span></span><span class="pct">0%</span>`;
    return li;
  }));
}

function miniGlyph(d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function showGesture(r) {
  const glyphKey = r.kind === 'gesture' ? r.label : r.kind;
  stage.dataset.kind = r.kind;
  stage.classList.remove('faded');
  glyphPath.setAttribute('d', GLYPHS[glyphKey]);
  glyphPath.classList.remove('draw'); void glyphPath.getBoundingClientRect(); glyphPath.classList.add('draw');

  const name = $('gesture-name'), meta = $('gesture-meta');
  if (r.kind === 'gesture') {
    name.textContent = LABELS[r.label];
    meta.innerHTML = `<b>${pct(r.confidence)}</b> sure`;
  } else if (r.kind === 'return') {
    name.textContent = 'Return stroke';
    meta.textContent = 'A slow movement back to the start. Not counted.';
  } else {
    name.textContent = 'Not sure';
    meta.innerHTML = `Best guess: ${LABELS[r.label] || r.label} (<b>${pct(r.confidence)}</b>)`;
  }

  const top = r.probs.indexOf(Math.max(...r.probs));
  for (const li of $('odds').children) {
    const i = r.classes.indexOf(li.dataset.cls);
    li.classList.toggle('top', i === top);
    li.querySelector('.fill').style.width = pct(r.probs[i]);
    li.querySelector('.pct').textContent = pct(r.probs[i]);
  }

  const list = $('gesture-history');
  list.querySelector('.history-empty')?.remove();
  const item = document.createElement('li');
  if (r.kind !== 'gesture') item.classList.add('dim');
  item.append(miniGlyph(GLYPHS[glyphKey]), document.createTextNode(r.kind === 'gesture' ? LABELS[r.label] : r.kind === 'return' ? 'return' : 'unsure'));
  list.prepend(item);
  while (list.children.length > 12) list.lastElementChild.remove();

  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => stage.classList.add('faded'), 4000);
}

$('demo').addEventListener('click', async () => {
  if (sensor.state === 'demo') { sensor.stopDemo(); sensor.setState('idle'); return; }
  try {
    if (!demoRows) {
      const res = await fetch('/demo/gestures.json');
      demoRows = (await res.json()).rows;
    }
    if (gestures) gestures.reset();
    sensor.playDemo(demoRows);
  } catch {
    setStatus('gestures', 'error', 'Couldn’t load the sample recording.');
  }
});

loadGestureModel().then((model) => {
  gestureModel = model;
  gestures = new GestureMode(model, showGesture);
  buildOdds(model.classes);
  refreshGestureStatus();
}).catch(() => { gestureModel = false; refreshGestureStatus(); });

/* ------------------------------------------------------- one sample stream */

sensor.addEventListener('sample', (e) => {
  const s = e.detail;
  instruments.push(s);
  if (mode === 'letters') { if (sensor.state === 'live') onLetterSample(s); }
  else if (gestures) gestures.push(gestureRow(s));
});

window.addEventListener('load', () => { if (!window.GestureCore) { gestureModel = false; refreshGestureStatus(); } });
setMode(mode);
renderSensor('idle');
