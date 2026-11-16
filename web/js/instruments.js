// The secondary "instruments" drawer: live charts and readouts.
// Charts are only drawn while the drawer is open.

const WINDOW = 400; // samples on screen (4 s at 100 Hz)

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { ctx: canvas.getContext('2d'), w, h, dpr };
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawLines(canvas, rows, pick, range) {
  const { ctx, w, h, dpr } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = cssVar('--rule');
  ctx.lineWidth = dpr;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  const colors = [cssVar('--c1'), cssVar('--c2'), cssVar('--c3')];
  ctx.lineWidth = 1.6 * dpr;
  ctx.lineJoin = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.strokeStyle = colors[k];
    ctx.beginPath();
    rows.forEach((s, i) => {
      const v = Math.max(-range, Math.min(range, pick(s)[k]));
      const x = ((i + WINDOW - rows.length) / (WINDOW - 1)) * w; // newest at the right
      const y = h / 2 - (v / range) * (h / 2 - 4 * dpr);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
}

export class Instruments {
  constructor(els) {
    this.els = els;
    this.rows = [];
    this.count = 0;
    this.open = false;
    els.toggle.addEventListener('click', () => this.setOpen(!this.open));
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this.lastSpark = 0;
  }

  setOpen(open) {
    this.open = open;
    this.els.toggle.setAttribute('aria-expanded', String(open));
    this.els.body.hidden = !open;
  }

  push(s) {
    this.rows.push(s);
    if (this.rows.length > WINDOW) this.rows.shift();
    this.count++;
  }

  clear() { this.rows = []; }

  loop(ts) {
    requestAnimationFrame(this.loop);
    if (ts - this.lastSpark < 66) return; // ~15 fps is plenty
    this.lastSpark = ts;
    this.drawSpark();
    if (!this.open) return;
    drawLines(this.els.acc, this.rows, (s) => s.acc, 2.5);
    drawLines(this.els.gyro, this.rows, (s) => s.gyro, 500);
    const last = this.rows[this.rows.length - 1];
    const fmt = (v) => `${v >= 0 ? ' ' : ''}${v.toFixed(1)}°`;
    if (last) {
      this.els.roll.textContent = fmt(last.angle[0]);
      this.els.pitch.textContent = fmt(last.angle[1]);
      this.els.yaw.textContent = fmt(last.angle[2]);
      this.els.motion.textContent = `${Math.hypot(...last.gyro).toFixed(0)} °/s`;
    }
    this.els.count.textContent = this.count.toLocaleString();
  }

  // One-line summary: rotation speed over the last few seconds.
  drawSpark() {
    const { ctx, w, h, dpr } = fitCanvas(this.els.spark);
    ctx.clearRect(0, 0, w, h);
    if (this.rows.length < 2) {
      ctx.strokeStyle = cssVar('--rule'); ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(0, h - dpr); ctx.lineTo(w, h - dpr); ctx.stroke();
      return;
    }
    ctx.strokeStyle = cssVar('--plum');
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const rows = this.rows;
    rows.forEach((s, i) => {
      const v = Math.min(400, Math.hypot(...s.gyro));
      const x = ((i + WINDOW - rows.length) / (WINDOW - 1)) * w; // newest at the right
      const y = h - dpr - (v / 400) * (h - 3 * dpr);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  setRate(hz) {
    const text = hz > 0 ? `${hz.toFixed(0)} Hz` : '— Hz';
    this.els.rate.textContent = text;
    this.els.rateRo.textContent = text;
  }
}
