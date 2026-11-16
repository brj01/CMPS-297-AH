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
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

// Pen position in metres (room coordinates, z up) for each sample.
// Gravity is removed using the sensor's orientation, then acceleration is
// integrated twice. The pen is assumed still before and after the stroke, so
// any speed left over at the end is drift and is removed linearly over time;
// that also cancels a constant accelerometer or tilt error exactly.
export function movementPath(samples, { still = 0.8 } = {}) {
  const n = samples.length;
  const zero = samples.map(() => [0, 0, 0]);
  if (n < 3) return zero;
  const lin = samples.map((s) => { const a = mul(rotationMatrix(s.angle), s.acc); return [a[0] * G, a[1] * G, (a[2] - 1) * G]; });
  const moving = samples.map((s) => intensity(s) >= still);
  let i0 = moving.indexOf(true);
  let i1 = moving.lastIndexOf(true);
  if (i0 < 0 || i1 <= i0) return zero;
  i0 = Math.max(0, i0 - 2);
  i1 = Math.min(n - 1, i1 + 2);

  const v = samples.map(() => [0, 0, 0]);
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    for (let k = 0; k < 3; k++) v[i][k] = v[i - 1][k] + 0.5 * (lin[i][k] + lin[i - 1][k]) * dt;
  }
  const t0 = samples[i0].t, span = samples[i1].t - t0 || 1, vEnd = [...v[i1]];
  for (let i = i0; i <= i1; i++) {
    const f = (samples[i].t - t0) / span;
    for (let k = 0; k < 3; k++) v[i][k] -= vEnd[k] * f;
  }
  const p = samples.map(() => [0, 0, 0]);
  for (let i = 1; i < n; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    for (let k = 0; k < 3; k++) p[i][k] = p[i - 1][k] + 0.5 * (v[i][k] + v[i - 1][k]) * dt;
  }
  return p;
}

// Smallest-variance direction of a point cloud (the normal of the plane it
// lies in), via Jacobi rotations on the 3×3 covariance matrix.
function planeNormal(points) {
  const c = [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k], 0) / points.length);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += (p[i] - c[i]) * (p[j] - c[j]);
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 20; sweep++) {
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[i][j]) < 1e-15) continue;
      const th = 0.5 * Math.atan2(2 * A[i][j], A[j][j] - A[i][i]);
      const [co, si] = [Math.cos(th), Math.sin(th)];
      for (let k = 0; k < 3; k++) { const a = A[k][i], b = A[k][j]; A[k][i] = co * a - si * b; A[k][j] = si * a + co * b; }
      for (let k = 0; k < 3; k++) { const a = A[i][k], b = A[j][k]; A[i][k] = co * a - si * b; A[j][k] = si * a + co * b; }
      for (let k = 0; k < 3; k++) { const a = V[k][i], b = V[k][j]; V[k][i] = co * a - si * b; V[k][j] = si * a + co * b; }
    }
  }
  const eig = [A[0][0], A[1][1], A[2][2]];
  const order = [0, 1, 2].sort((a, b) => eig[a] - eig[b]);
  return { normal: [V[0][order[0]], V[1][order[0]], V[2][order[0]]], flatness: eig[order[0]] / (eig[order[1]] || 1e-12) };
}

// Flattens the 3D path onto the plane it was written in, as seen by the writer.
// "Forward" is where the pen pointed at the start (sensor x axis); if the page
// comes out mirrored, the Mirror setting fixes it.
export function projectToPage(path, samples) {
  const up = [0, 0, 1];
  const fwd0 = mul(rotationMatrix(samples[0].angle), [1, 0, 0]);
  const forward = unit([fwd0[0], fwd0[1], 0]);
  let { normal, flatness } = planeNormal(path);
  if (!(flatness < 0.35)) normal = forward; // too straight to tell the plane: assume a board in front
  if (dot(normal, forward) < 0) normal = normal.map((x) => -x);
  let pageUp;
  if (Math.abs(normal[2]) < 0.75) pageUp = unit(up.map((u, k) => u - normal[2] * normal[k])); // upright page
  else pageUp = unit(forward.map((f, k) => f - dot(forward, normal) * normal[k]));           // flat page
  const right = unit(cross(pageUp, normal.map((x) => -x)));
  return path.map((p) => [dot(p, right), -dot(p, pageUp)]);
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

// 2D points for drawing, plus the smallest span (in the points' units) worth
// filling the page with, so tiny jitter isn't blown up to full size.
export function tracePoints(samples, { method = 'movement', still = 0.8, swap = false, flipX = false, flipY = false } = {}) {
  if (!samples.length) return { points: [], minSpan: 1 };
  const movement = method === 'movement';
  const raw = movement ? projectToPage(movementPath(samples, { still }), samples) : tiltPoints(samples);
  const points = raw.map(([x0, y0]) => {
    let [x, y] = swap ? [y0, x0] : [x0, y0];
    if (flipX) x = -x;
    if (flipY) y = -y;
    return [x, y];
  });
  return { points, minSpan: movement ? 0.04 : 25 }; // 4 cm or 25°
}
