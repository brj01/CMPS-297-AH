const FRUIT_COLORS = [
  { base: '#ed6485', light: '#ffb2a7', leaf: '#5d9c67' },
  { base: '#f0a52e', light: '#ffe28a', leaf: '#699a59' },
  { base: '#8a62cc', light: '#d8a7f2', leaf: '#699a59' },
  { base: '#55a86d', light: '#b5db7c', leaf: '#4d8c5a' },
  { base: '#e65e4e', light: '#ffad83', leaf: '#5d9c67' },
];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1) : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

export class FruitGame {
  constructor({ canvas, score, time, lives, overlay, overlayTitle, overlayCopy, startButton, onStateChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scoreElement = score;
    this.timeElement = time;
    this.livesElement = lives;
    this.overlay = overlay;
    this.overlayTitle = overlayTitle;
    this.overlayCopy = overlayCopy;
    this.startButton = startButton;
    this.onStateChange = onStateChange;
    this.state = 'ready';
    this.score = 0;
    this.lives = 3;
    this.remaining = 45;
    this.width = 0;
    this.height = 0;
    this.fruits = [];
    this.particles = [];
    this.slashes = [];
    this.lastFrame = 0;
    this.lastSpawn = 0;
    this.lastSlice = 0;
    this.combo = 0;
    this.active = false;
    this.animation = null;
    this.pointer = null;

    this.startButton.addEventListener('click', () => this.start());
    this.canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.canvas.addEventListener('pointerup', () => { this.pointer = null; });
    this.canvas.addEventListener('pointercancel', () => { this.pointer = null; });
    this.canvas.addEventListener('keydown', (event) => {
      const direction = { ArrowUp: 'swipe_up', ArrowDown: 'swipe_down', ArrowLeft: 'swipe_left', ArrowRight: 'swipe_right' }[event.key];
      if (direction && this.state === 'running') {
        event.preventDefault();
        this.swipe(direction);
      }
    });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.render();
  }

  setActive(active) {
    this.active = active;
    if (active) this.resize();
    this.lastFrame = 0;
    if (active && this.state === 'running') this.schedule();
    if (!active && this.animation !== null) {
      cancelAnimationFrame(this.animation);
      this.animation = null;
    }
  }

  start() {
    this.state = 'running';
    this.score = 0;
    this.lives = 3;
    this.remaining = 45;
    this.fruits = [];
    this.particles = [];
    this.slashes = [];
    this.combo = 0;
    this.lastSlice = 0;
    this.lastSpawn = 0;
    this.overlay.hidden = true;
    this.startButton.textContent = 'Restart';
    this.updateScoreboard();
    this.onStateChange();
    if (this.active) this.schedule();
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
    if (this.animation === null && this.active && this.state === 'running') {
      this.animation = requestAnimationFrame((time) => this.frame(time));
    }
  }

  frame(now) {
    this.animation = null;
    if (!this.active || this.state !== 'running') return;
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
    this.slashes = this.slashes.filter((slash) => now - slash.time < 220);
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

  pointerPosition(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  pointerDown(event) {
    if (this.state !== 'running') return;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointer = this.pointerPosition(event);
    event.preventDefault();
  }

  pointerMove(event) {
    if (!this.pointer || this.state !== 'running') return;
    const next = this.pointerPosition(event);
    this.cut(this.pointer, next);
    this.pointer = next;
  }

  swipe(direction) {
    if (!this.active || this.state !== 'running') return;
    const paths = {
      swipe_up: [0.39, 0.8, 0.62, 0.24],
      swipe_down: [0.62, 0.24, 0.39, 0.8],
      swipe_left: [0.82, 0.57, 0.18, 0.42],
      swipe_right: [0.18, 0.42, 0.82, 0.57],
    };
    const path = paths[direction];
    if (!path) return;
    const points = path.map((value, index) => value * (index % 2 === 0 ? this.width : this.height));
    this.cut({ x: points[0], y: points[1] }, { x: points[2], y: points[3] });
  }

  cut(start, end) {
    const now = performance.now();
    this.slashes.push({ start, end, time: now });
    const remaining = [];
    for (const fruit of this.fruits) {
      if (distanceToSegment(fruit, start, end) <= fruit.radius + 9) {
        this.score += 1;
        this.combo = now - this.lastSlice < 700 ? this.combo + 1 : 1;
        this.lastSlice = now;
        this.burst(fruit);
      } else {
        remaining.push(fruit);
      }
    }
    this.fruits = remaining;
    this.updateScoreboard();
    this.render(now);
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
    for (const slash of this.slashes) {
      const alpha = clamp(1 - (now - slash.time) / 220, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(slash.start.x, slash.start.y);
      ctx.lineTo(slash.end.x, slash.end.y);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#f6c4d6';
      ctx.lineWidth = 13;
      ctx.stroke();
      ctx.strokeStyle = '#5b2f8c';
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
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
