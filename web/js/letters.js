// Letter mode: finds one written letter in the sample stream, then asks the
// server's model what it is. The detector mirrors processing/segmentation.py
// so the hosted site cuts letters the same way as the desktop app.

export const State = { IDLE: 'idle', WRITING: 'writing', PROCESSING: 'processing' };

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
export const intensity = (s) => norm(s.gyro) + Math.abs(norm(s.acc) - 1);

export class Segmenter {
  constructor({ start = 2.0, stop = 0.8, rest = 0.5, minDuration = 0.3, maxDuration = 5.0, preMotion = 0.15 } = {}) {
    Object.assign(this, { start, stop, rest, minDuration, maxDuration, preMotion });
    this.reset();
  }

  reset() {
    this.state = State.IDLE;
    this.recent = [];
    this.active = [];
    this.startedAt = null;
    this.quietSince = null;
  }

  // Returns the finished letter's samples, or null while still waiting/writing.
  update(s) {
    const now = s.t;
    const level = intensity(s);
    this.recent.push(s);
    while (this.recent.length && now - this.recent[0].t > this.preMotion) this.recent.shift();

    if (this.state === State.IDLE && level >= this.start) {
      this.state = State.WRITING;
      this.startedAt = now;
      this.quietSince = null;
      this.active = [...this.recent];
    } else if (this.state === State.WRITING) {
      this.active.push(s);
      if (level < this.stop) this.quietSince = this.quietSince ?? now;
      else this.quietSince = null;
      const duration = now - this.startedAt;
      if (duration >= this.maxDuration || (this.quietSince !== null && now - this.quietSince >= this.rest)) {
        if (duration >= this.minDuration) {
          const letter = this.active;
          this.state = State.PROCESSING;
          this.recent = [];
          this.active = [];
          return letter;
        }
        this.reset();
      }
    }
    return null;
  }

  // Same rule as the desktop app: thresholds scale with how noisy the sensor is at rest.
  calibrate(samples) {
    if (samples.length < 10) throw new Error('Not enough resting samples to calibrate');
    const gyro = samples.map((s) => norm(s.gyro));
    const acc = samples.map((s) => Math.abs(norm(s.acc) - 1));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const baseline = Math.max(mean(gyro), mean(acc));
    this.start = Math.max(2.0, baseline * 5);
    this.stop = Math.max(0.8, baseline * 2);
    return { baseline, start: this.start, stop: this.stop };
  }
}

export async function predictLetter(samples, { signal, watchCode = null } = {}) {
  const body = { samples: samples.map((s) => ({ t: s.t, acc: s.acc, gyro: s.gyro, orientation: s.angle })) };
  if (watchCode) body.watch_code = watchCode;
  let res;
  try {
    res = await fetch('/api/letters/predict', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } catch {
    throw new Error('Could not reach the server');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Server error (${res.status})`);
  return data;
}

/* ----------------------------------------------------------------------------
 * Drawing the letter. This is only a picture for the person writing; the model
 * never sees it. Two methods:
 *   - movement (default): where the pen actually went, from its acceleration
 *   - tilt: how the pen turned (yaw/pitch), the simpler original method
 * ------------------------------------------------------------------------- */

const G = 9.80665;
const DEG = Math.PI / 180;

// Body → room rotation for WitMotion angles (roll X, pitch Y, yaw Z; Z-Y-X order).
export function rotationMatrix([roll, pitch, yaw]) {
  const [cr, sr] = [Math.cos(roll * DEG), Math.sin(roll * DEG)];
  const [cp, sp] = [Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  const [cy, sy] = [Math.cos(yaw * DEG), Math.sin(yaw * DEG)];
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
}
const mul = (R, v) => R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const NOISE_FLOOR = 0.15; // m/s² (~0.015 g): smaller accelerations are treated as sensor noise

function linearAcceleration(s) {
  const a = mul(rotationMatrix(s.angle), s.acc);
  const lin = [a[0] * G, a[1] * G, (a[2] - 1) * G];
  const m = Math.hypot(...lin);
  if (m <= NOISE_FLOOR) return [0, 0, 0];
  const k = (m - NOISE_FLOOR) / m; // soft threshold: no jump at the noise floor
  return lin.map((x) => x * k);
}

// Stretches of consecutive movement, ignoring 1–2 sample dropouts.
function movingRuns(samples, still) {
  const runs = [];
  let start = -1, lastMoving = -10;
  samples.forEach((s, i) => {
    if (intensity(s) < still) return;
    if (start < 0 || i - lastMoving > 3) { if (start >= 0) runs.push([start, lastMoving]); start = i; }
    lastMoving = i;
  });
  if (start >= 0) runs.push([start, lastMoving]);
  return runs;
}

// Pen position in metres (room coordinates, z up) for each sample.
// Gravity is removed using the sensor's orientation and the rest is integrated
// twice. Whenever the pen is still, its speed is reset to zero. Each finished
// stretch of movement must also end at zero speed, so speed left over at its
// end is drift and is removed linearly over the stretch. With `live`, a
// stretch still in progress is integrated forward only (with light damping),
// so lines already on screen don't move while you write.
export function movementPath(samples, { still = 0.8, live = false } = {}) {
  const n = samples.length;
  const p = samples.map(() => [0, 0, 0]);
  if (n < 3) return p;
  const lin = samples.map(linearAcceleration);
  const v = samples.map(() => [0, 0, 0]);
  for (const [r0, r1] of movingRuns(samples, still)) {
    const a = Math.max(0, r0 - 2);
    const open = live && r1 >= n - 2;
    const b = open ? n - 1 : Math.min(n - 1, r1 + 2);
    for (let i = a + 1; i <= b; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      const damp = open ? Math.exp(-dt / 1.5) : 1;
      for (let k = 0; k < 3; k++) v[i][k] = (v[i - 1][k] + 0.5 * (lin[i][k] + lin[i - 1][k]) * dt) * damp;
    }
    if (!open) {
      const t0 = samples[a].t, span = samples[b].t - t0 || 1, end = [...v[b]];
      for (let i = a; i <= b; i++) {
        const f = (samples[i].t - t0) / span;
        for (let k = 0; k < 3; k++) v[i][k] -= end[k] * f;
      }
    }
  }
  for (let i = 1; i < n; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    for (let k = 0; k < 3; k++) p[i][k] = p[i - 1][k] + 0.5 * (v[i][k] + v[i - 1][k]) * dt;
  }
  return p;
}

// Flattens the path onto an upright page, as seen by the writer. "Up" is
// always up (from gravity), so the drawing can never tumble. "Right" is the
// main horizontal direction of the first ~2 cm of sideways movement, then
// stays locked; before that (or for letters like I) it is taken from the
// pen's heading. The heading also decides which way is left, so a mirrored
// result can be fixed with the Mirror setting.
const LOCK_SPREAD = 0.02; // metres
export function projectToPage(path, samples) {
  const yaw = samples[0].angle[2] * DEG;
  const forward = [Math.cos(yaw), Math.sin(yaw), 0];
  let right = cross(forward, [0, 0, 1]);
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    const n = i + 1, cxx = sxx / n - (sx / n) ** 2, cyy = syy / n - (sy / n) ** 2, cxy = sxy / n - (sx / n) * (sy / n);
    if (n >= 10 && 2 * Math.sqrt(Math.max(cxx, cyy, 0)) >= LOCK_SPREAD) {
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const axis = [Math.cos(angle), Math.sin(angle), 0];
      right = dot(axis, right) >= 0 ? axis : axis.map((c) => -c);
      break;
    }
  }
  return path.map((q) => [dot(q, right), -q[2]]);
}

// Turn-based drawing: yaw moves left/right, pitch moves up/down. Yaw is
// unwrapped so crossing ±180° doesn't tear the stroke.
function tiltPoints(samples) {
  const pts = [];
  let yawPrev = samples[0].angle[2];
  let yaw = 0;
  const pitch0 = samples[0].angle[1];
  for (const s of samples) {
    let d = s.angle[2] - yawPrev;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    yaw += d;
    yawPrev = s.angle[2];
    pts.push([-yaw, -(s.angle[1] - pitch0)]);
  }
  return pts;
}

// 2D points for drawing, plus how much the page width represents in the
// points' units. The page has a fixed scale, so strokes keep their size.
export function tracePoints(samples, { method = 'movement', still = 0.8, live = false, swap = false, flipX = false, flipY = false } = {}) {
  if (!samples.length) return { points: [], pageWidth: 1 };
  const movement = method === 'movement';
  const raw = movement ? projectToPage(movementPath(samples, { still, live }), samples) : tiltPoints(samples);
  const points = raw.map(([x0, y0]) => {
    let [x, y] = swap ? [y0, x0] : [x0, y0];
    if (flipX) x = -x;
    if (flipY) y = -y;
    return [x, y];
  });
  return { points, pageWidth: movement ? 0.3 : 70 }; // 30 cm, or 70° of turn
}
