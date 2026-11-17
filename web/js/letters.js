// Letter mode: finds one written letter in the sample stream, then asks the
// server's model what it is. The detector mirrors processing/segmentation.py
// so the hosted site cuts letters the same way as the desktop app.

export const State = { IDLE: 'idle', WRITING: 'writing', PROCESSING: 'processing' };

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
export const intensity = (s) => norm(s.gyro) + Math.abs(norm(s.acc) - 1);

export class Segmenter {
  constructor({ start = 2.0, stop = 0.8, rest = 0.5, minDuration = 0.3, maxDuration = 5.0, preMotion = 0.15 } = {}) {
    Object.assign(this, { start, stop, rest, minDuration, maxDuration, preMotion });
    this.window = []; // last 0.1 s, for the motion-based stillness check (kept across resets)
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
    // Unlike the desktop app, hand tremor never counts as writing: the pen is
    // also "still" when it's barely rotating with a steady acceleration.
    this.window.push(s);
    if (this.window.length > STILL_WINDOW) this.window.shift();
    const steady = this.window.length < STILL_WINDOW || stillMask(this.window)[this.window.length - 1];

    if (this.state === State.IDLE && level >= this.start && !steady) {
      this.state = State.WRITING;
      this.startedAt = now;
      this.quietSince = null;
      this.active = [...this.recent];
    } else if (this.state === State.WRITING) {
      this.active.push(s);
      if (level < this.stop || steady) this.quietSince = this.quietSince ?? now;
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

// Constant accelerometer error, measured while the pen is held still: what the
// sensor reads minus the gravity it should read in that orientation (g units).
export function restingOffset(samples) {
  if (samples.length < 10) return [0, 0, 0];
  const sum = [0, 0, 0];
  for (const s of samples) {
    const R = rotationMatrix(s.angle); // body → room; gravity in the body frame is R^T·[0,0,1]
    for (let k = 0; k < 3; k++) sum[k] += s.acc[k] - R[2][k];
  }
  return sum.map((x) => x / samples.length);
}

function linearAcceleration(s, offset) {
  const acc = offset ? s.acc.map((x, k) => x - offset[k]) : s.acc;
  const a = mul(rotationMatrix(s.angle), acc);
  const lin = [a[0] * G, a[1] * G, (a[2] - 1) * G];
  const m = Math.hypot(...lin);
  if (m <= NOISE_FLOOR) return [0, 0, 0];
  const k = (m - NOISE_FLOOR) / m; // soft threshold: no jump at the noise floor
  return lin.map((x) => x * k);
}

// Whether the pen is still at each sample, judged from the last 0.1 s only (so
// it never changes for samples already drawn): barely rotating and with a
// steady acceleration. Hand tremor counts as still; any real stroke doesn't.
const STILL_WINDOW = 10;      // samples
const STILL_GYRO = 10;        // deg/s, the fastest allowed rotation in the window
const STILL_ACC_SPREAD = 0.02; // g, spread of the acceleration size in the window
export function stillMask(samples) {
  return samples.map((_, i) => {
    let gyroMax = 0, sum = 0, sumSq = 0, count = 0;
    for (let j = Math.max(0, i - STILL_WINDOW + 1); j <= i; j++) {
      const s = samples[j];
      gyroMax = Math.max(gyroMax, Math.hypot(...s.gyro));
      const a = Math.hypot(...s.acc);
      sum += a; sumSq += a * a; count++;
    }
    const spread = Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2));
    return gyroMax < STILL_GYRO && spread < STILL_ACC_SPREAD;
  });
}

// Stretches of movement between still periods.
function movingRuns(still) {
  const runs = [];
  let start = -1;
  still.forEach((isStill, i) => {
    if (!isStill && start < 0) start = i;
    if (isStill && start >= 0) { runs.push([start, i]); start = -1; }
  });
  if (start >= 0) runs.push([start, still.length - 1]);
  return runs;
}

// Pen position in metres (room coordinates, z up) for each sample.
// Gravity (and any measured accelerometer offset) is removed using the
// sensor's orientation and the rest is integrated twice. Whenever the pen is
// still, its speed is zero. Each finished stretch of movement must end at zero
// speed, so speed left over at its end is drift and is removed linearly over
// the stretch. With `live`, a stretch still in progress is integrated forward
// only (with damping), so lines already on screen don't move while you write.
export function movementPath(samples, { live = false, offset = null } = {}) {
  const n = samples.length;
  const p = samples.map(() => [0, 0, 0]);
  if (n < 3) return p;
  const lin = samples.map((s) => linearAcceleration(s, offset));
  const v = samples.map(() => [0, 0, 0]);
  const still = stillMask(samples);
  for (const [r0, r1] of movingRuns(still)) {
    const a = Math.max(0, r0 - 1);
    const open = live && !still[n - 1] && r1 === n - 1;
    const b = r1;
    for (let i = a + 1; i <= b; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      const damp = open ? Math.exp(-dt / 1.0) : 1;
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
export function projectToPage(path, samples, page = null) {
  if (page) return path.map((q) => [dot(q, page.right), -dot(q, page.up)]); // measured by the circle calibration
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

/* ---- circle calibration --------------------------------------------------
 * The writer draws one clockwise circle in front of them. Its plane is the
 * page, "clockwise as seen by the writer" fixes which side they're on (so the
 * page can't come out mirrored), and its size sets the scale.
 */

// Principal axes of a point cloud: eigenvalues (variances, largest first) and
// matching unit eigenvectors, via Jacobi rotations on the covariance matrix.
function principalAxes(points) {
  const n = points.length;
  const c = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / n);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += ((p[i] - c[i]) * (p[j] - c[j])) / n;
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[i][j]) < 1e-18) continue;
      const th = 0.5 * Math.atan2(2 * A[i][j], A[j][j] - A[i][i]);
      const co = Math.cos(th), si = Math.sin(th);
      for (let k = 0; k < 3; k++) { const a = A[k][i], b = A[k][j]; A[k][i] = co * a - si * b; A[k][j] = si * a + co * b; }
      for (let k = 0; k < 3; k++) { const a = A[i][k], b = A[j][k]; A[i][k] = co * a - si * b; A[j][k] = si * a + co * b; }
      for (let k = 0; k < 3; k++) { const a = V[k][i], b = V[k][j]; V[k][i] = co * a - si * b; V[k][j] = si * a + co * b; }
    }
  }
  const order = [0, 1, 2].sort((a, b) => A[b][b] - A[a][a]);
  return { values: order.map((i) => A[i][i]), vectors: order.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}

const norm3 = (v) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };

// Turns a drawn circle into a page: { right, up, size } in room coordinates.
// Throws an Error with a message for the writer if it doesn't look like a circle.
export function pageFromCircle(samples, { offset = null } = {}) {
  const path = movementPath(samples, { offset });
  const still = stillMask(samples);
  const moving = path.filter((_, i) => !still[i]);
  if (moving.length < 30) throw new Error('That was too short. Draw one full circle, then hold still');
  const { values: [l1, l2, l3], vectors: [, , normal0] } = principalAxes(moving);
  const diameter = 2 * Math.sqrt(l1 + l2); // for a circle of radius r, l1 = l2 = r²/2
  if (diameter < 0.03) throw new Error('That circle was too small to measure. Draw it about the size of a letter');
  if (diameter > 0.8) throw new Error('That circle came out far too big, so the measurement drifted. Try a smaller, quicker circle');
  if (l2 / l1 < 0.25) throw new Error('That looked more like a line than a circle. Try a rounder circle');
  if (l3 / l2 > 0.4) throw new Error('That circle wasn’t flat enough to find the page. Keep it on one imaginary surface');

  let normal = normal0;
  const page = () => {
    const z = [0, 0, 1];
    let up = z.map((v, k) => v - dot(z, normal) * normal[k]);
    if (Math.hypot(...up) < 0.4) { // a flat page (like a desk): "up" is away from the writer
      const yaw = samples[0].angle[2] * DEG;
      const f = [Math.cos(yaw), Math.sin(yaw), 0];
      up = f.map((v, k) => v - dot(f, normal) * normal[k]);
    }
    up = norm3(up);
    return { right: norm3(cross(normal, up)), up };
  };
  let { right, up } = page();
  // Signed area on screen (y down): positive means clockwise as the writer sees it.
  const pts = moving.map((q) => [dot(q, right), -dot(q, up)]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; area += x1 * y2 - x2 * y1; }
  if (area < 0) { normal = normal.map((v) => -v); ({ right, up } = page()); }
  return { right, up, size: diameter };
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
export function tracePoints(samples, { method = 'movement', live = false, page = null, offset = null, swap = false, flipX = false, flipY = false } = {}) {
  if (!samples.length) return { points: [], pageWidth: 1 };
  const movement = method === 'movement';
  const raw = movement ? projectToPage(movementPath(samples, { live, offset }), samples, page) : tiltPoints(samples);
  const points = raw.map(([x0, y0]) => {
    let [x, y] = swap ? [y0, x0] : [x0, y0];
    if (flipX) x = -x;
    if (flipY) y = -y;
    return [x, y];
  });
  // 30 cm (or 70° of turn); after circle calibration, the circle fills about 40% of the page width.
  return { points, pageWidth: movement ? (page ? page.size / 0.4 : 0.3) : 70 };
}
