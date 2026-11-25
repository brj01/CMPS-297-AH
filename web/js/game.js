const FRUIT_COLORS = [
  { base: '#ed6485', light: '#ffb2a7', leaf: '#5d9c67' },
  { base: '#f0a52e', light: '#ffe28a', leaf: '#699a59' },
  { base: '#8a62cc', light: '#d8a7f2', leaf: '#699a59' },
  { base: '#55a86d', light: '#b5db7c', leaf: '#4d8c5a' },
  { base: '#e65e4e', light: '#ffad83', leaf: '#5d9c67' },
];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const DEG = Math.PI / 180;

// The sensor is an air mouse: turning the pen left/right moves the cursor
// left/right, tilting it up/down moves it up/down. A fast movement is a blade.
const DEGREES_ACROSS = 40;   // turning the pen this many degrees crosses the whole board
const SLICE_SPEED = 60;      // deg/s of pen turning: slower is aiming, faster is a slice
const TRAIL_MS = 160;        // how long the blade trail stays visible
const SMOOTHING = 0.45;      // 0..1, how much each new sample moves the cursor (jitter filter)

// Body -> room rotation for WitMotion angles (roll X, pitch Y, yaw Z; Z-Y-X order).
function pointing(angle, axis) {
  const [r, p, y] = angle.map((a) => a * DEG);
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(y), Math.sin(y)];
  const R = [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
  const d = R.map((row) => row[0] * axis[0] + row[1] * axis[1] + row[2] * axis[2]);
  const n = Math.hypot(...d) || 1;
  return { azimuth: Math.atan2(d[1], d[0]) / DEG, elevation: Math.asin(clamp(d[2] / n, -1, 1)) / DEG };
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1) : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

export class FruitGame {
  constructor({ canvas, score, time, lives, overlay, overlayTitle, overlayCopy, startButton, onStartRequested, onStateChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scoreElement = score;
    this.timeElement = time;
    this.livesElement = lives;
    this.overlay = overlay;
    this.overlayTitle = overlayTitle;
    this.overlayCopy = overlayCopy;
    this.startButton = startButton;
    this.onStartRequested = onStartRequested || (() => this.start());
    this.onStateChange = onStateChange || (() => {});
    this.state = 'ready';
    this.score = 0;
    this.lives = 3;
    this.remaining = 45;
    this.width = 0;
    this.height = 0;
    this.fruits = [];
    this.particles = [];
    this.lastFrame = 0;
    this.lastSpawn = 0;
    this.lastSlice = 0;
    this.combo = 0;
    this.active = false;
    this.animation = null;
    // sensor cursor
    this.axis = [1, 0, 0];   // the sensor axis the pen points along
    this.center = null;      // { azimuth, elevation } that maps to the middle of the board
    this.recenterNext = true;
    this.cursor = null;      // { x, y } in board pixels
    this.trail = [];         // recent cursor positions { x, y, time }
    this.lastSampleAt = 0;

    this.startButton.addEventListener('click', () => this.onStartRequested());
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.render();
  }

  setActive(active) {
    this.active = active;
    if (active) this.resize();
    this.lastFrame = 0;
    if (active) this.schedule();
    if (!active && this.animation !== null) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
  }

  // Which sensor axis points along the pen (from the Letters calibration, if any).
  setPointingAxis(axis) {
    const n = Math.hypot(...axis);
    this.axis = n > 1e-6 ? axis.map((v) => v / n) : [1, 0, 0];
    this.recenter();
  }

  // The next sample's direction becomes the middle of the board.
  recenter() {
    this.recenterNext = true;
    this.trail = [];
  }

  get sensorActive() { return performance.now() - this.lastSampleAt < 500; }
  get slicePxPerSecond() { return SLICE_SPEED * this.width / DEGREES_ACROSS; }

  observeSensorSample(sample) {
    this.lastSampleAt = performance.now();
    const { azimuth, elevation } = pointing(sample.angle, this.axis);
    if (this.recenterNext || !this.center) {
      this.center = { azimuth, elevation };
      this.recenterNext = false;
      this.cursor = null;
    }
    let dAz = azimuth - this.center.azimuth;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    const perDegree = this.width / DEGREES_ACROSS;
    const target = {
      x: clamp(this.width / 2 - dAz * perDegree, 0, this.width),
      y: clamp(this.height / 2 - (elevation - this.center.elevation) * perDegree, 0, this.height),
    };
    this.cursor = this.cursor
      ? { x: this.cursor.x + SMOOTHING * (target.x - this.cursor.x), y: this.cursor.y + SMOOTHING * (target.y - this.cursor.y) }
      : target;
    // Times come from the sample's own timestamp: several samples often arrive together.
    const now = performance.now();
    const last = this.trail[this.trail.length - 1];
    this.trail.push({ ...this.cursor, time: now, t: sample.t });
    while (this.trail.length && now - this.trail[0].time > TRAIL_MS) this.trail.shift();
    // a fast movement between two samples is a blade stroke
    if (last && this.state === 'running') {
      const dt = Math.max(1e-3, sample.t - last.t);
      if (Math.hypot(this.cursor.x - last.x, this.cursor.y - last.y) / dt >= this.slicePxPerSecond) this.cut(last, this.cursor);
    }
    this.schedule();
  }

  start() {
    this.state = 'running';
    this.score = 0;
    this.lives = 3;
    this.remaining = 45;
    this.fruits = [];
    this.particles = [];
    this.combo = 0;
    this.lastSlice = 0;
    this.lastSpawn = 0;
    this.lastFrame = 0;
    this.recenter();
    this.overlay.hidden = true;
    this.startButton.textContent = 'Restart';
    this.updateScoreboard();
    this.onStateChange();
    this.schedule();
  }

  stop(title, copy) {
    this.state = 'ready';
    this.fruits = [];
    this.overlay.hidden = false;
    this.overlayTitle.textContent = title;
    this.overlayCopy.textContent = copy;
    this.startButton.textContent = 'Start game';
    this.onStateChange();
    this.render();
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = bounds.width;
    this.height = bounds.height;
    this.canvas.width = Math.max(1, Math.round(bounds.width * dpr));
    this.canvas.height = Math.max(1, Math.round(bounds.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  schedule() {
    if (this.animation === null && this.active) {
      this.animation = requestAnimationFrame((time) => this.frame(time));
    }
  }

  frame(now) {
    this.animation = null;
    if (!this.active) return;
    if (this.state !== 'running') {
      // not playing: just show the cursor so it can be aimed and recentered
      this.render(now);
      if (this.sensorActive) this.schedule();
      return;
    }
    const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.04) : 0;
    this.lastFrame = now;
    this.remaining = Math.max(0, this.remaining - dt);

    if (now - this.lastSpawn > 1250 + Math.random() * 600) this.launchWave(now);
    for (const fruit of this.fruits) {
      fruit.x += fruit.vx * dt;
      fruit.y += fruit.vy * dt;
      fruit.vy += 980 * dt;
    }
    const missed = this.fruits.filter((fruit) => fruit.y - fruit.radius > this.height);
    if (missed.length) this.lives = Math.max(0, this.lives - missed.length);
    this.fruits = this.fruits.filter((fruit) => fruit.y - fruit.radius <= this.height);

    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 500 * dt;
      particle.life -= dt;
    }
    this.particles = this.particles.filter((particle) => particle.life > 0);
    this.updateScoreboard();
    this.render(now);

    if (this.lives <= 0 || this.remaining <= 0) {
      this.finish();
      return;
    }
    this.schedule();
  }

  launchWave(now) {
    this.lastSpawn = now;
    const count = 1 + Math.floor(Math.random() * 2);
    const margin = 52;
    for (let i = 0; i < count; i += 1) {
      const radius = 23 + Math.random() * 9;
      const spacing = this.width / (count + 1);
      const x = count === 1
        ? margin + Math.random() * Math.max(1, this.width - margin * 2)
        : clamp(spacing * (i + 1) + (Math.random() - 0.5) * 55, margin, this.width - margin);
      this.fruits.push({
        x,
        y: this.height + radius,
        radius,
        vx: (Math.random() - 0.5) * 180,
        vy: -(650 + Math.random() * 160),
        color: FRUIT_COLORS[Math.floor(Math.random() * FRUIT_COLORS.length)],
        tilt: (Math.random() - 0.5) * 0.4,
        spin: (Math.random() - 0.5) * 1.8,
      });
    }
  }

  cut(start, end) {
    const now = performance.now();
    const remaining = [];
    let sliced = 0;
    for (const fruit of this.fruits) {
      if (distanceToSegment(fruit, start, end) <= fruit.radius + 9) {
        this.score += 1;
        sliced += 1;
        this.combo = now - this.lastSlice < 700 ? this.combo + 1 : 1;
        this.lastSlice = now;
        this.burst(fruit);
      } else {
        remaining.push(fruit);
      }
    }
    this.fruits = remaining;
    if (sliced) this.updateScoreboard();
    return sliced;
  }

  burst(fruit) {
    for (let i = 0; i < 9; i += 1) {
      const angle = Math.PI * 2 * i / 9;
      const speed = 80 + Math.random() * 150;
      this.particles.push({
        x: fruit.x, y: fruit.y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 0.45 + Math.random() * 0.2,
        color: i % 2 ? fruit.color.base : fruit.color.light,
      });
    }
  }

  finish() {
    this.state = 'over';
    this.fruits = [];
    this.overlay.hidden = false;
    this.overlayTitle.textContent = this.lives ? 'Lovely slicing!' : 'One more round?';
    this.overlayCopy.textContent = `You sliced ${this.score} fruit${this.score === 1 ? '' : 's'}. Ready for another go?`;
    this.startButton.textContent = 'Play again';
    this.onStateChange();
  }

  updateScoreboard() {
    this.scoreElement.textContent = String(this.score);
    this.timeElement.textContent = String(Math.ceil(this.remaining));
    this.livesElement.textContent = Array.from({ length: 3 }, (_, index) => index < this.lives ? '♥' : '♡').join(' ');
    this.livesElement.setAttribute('aria-label', `${this.lives} ${this.lives === 1 ? 'life' : 'lives'} remaining`);
  }

  render(now = performance.now()) {
    const { ctx, width, height } = this;
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    for (const fruit of this.fruits) this.drawFruit(fruit);
    for (const particle of this.particles) {
      ctx.globalAlpha = clamp(particle.life * 2, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.drawBlade(now);
    this.drawCursor();
  }

  // The recent cursor path, drawn where the cursor moved fast enough to cut.
  drawBlade(now) {
    const { ctx, trail } = this;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i += 1) {
      const a = trail[i - 1], b = trail[i];
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-3, b.t - a.t);
      if (speed < this.slicePxPerSecond) continue;
      const fade = clamp(1 - (now - b.time) / TRAIL_MS, 0, 1);
      ctx.globalAlpha = fade;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = '#f6c4d6'; ctx.lineWidth = 13; ctx.stroke();
      ctx.strokeStyle = '#5b2f8c'; ctx.lineWidth = 5; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawCursor() {
    if (!this.cursor || !this.sensorActive) return;
    const { ctx } = this;
    const { x, y } = this.cursor;
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(91, 47, 140, 0.55)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#5b2f8c'; ctx.fill();
  }

  drawFruit(fruit) {
    const { ctx } = this;
    const { radius: r, color } = fruit;
    ctx.save();
    ctx.translate(fruit.x, fruit.y);
    ctx.rotate(fruit.tilt);
    const gradient = ctx.createRadialGradient(-r * 0.38, -r * 0.42, r * 0.08, 0, 0, r * 1.2);
    gradient.addColorStop(0, color.light);
    gradient.addColorStop(1, color.base);
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(42, 23, 49, 0.2)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.beginPath();
    ctx.moveTo(-r * 0.78, -r * 0.18);
    ctx.bezierCurveTo(-r * 1.18, -r * 1.05, -r * 0.18, -r * 1.1, 0, -r * 0.82);
    ctx.bezierCurveTo(r * 0.28, -r * 1.14, r * 1.12, -r * 0.7, r * 0.82, 0);
    ctx.bezierCurveTo(r * 0.7, r * 0.86, r * 0.24, r, 0, r * 0.83);
    ctx.bezierCurveTo(-r * 0.34, r * 1.08, -r * 1.05, r * 0.58, -r * 0.78, -r * 0.18);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = color.leaf;
    ctx.lineWidth = Math.max(2.5, r * 0.11);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.76);
    ctx.quadraticCurveTo(r * 0.08, -r * 1.2, r * 0.32, -r * 1.22);
    ctx.stroke();
    ctx.fillStyle = color.leaf;
    ctx.beginPath();
    ctx.ellipse(r * 0.38, -r * 1.13, r * 0.24, r * 0.11, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, -r * 0.42, r * 0.12, r * 0.23, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
