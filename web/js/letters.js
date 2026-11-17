// Letter mode: finds one written letter in the sample stream, then asks the
// server's model what it is. The detector mirrors processing/segmentation.py
// so the hosted site cuts letters the same way as the desktop app.

export const State = { IDLE: 'idle', WRITING: 'writing', PROCESSING: 'processing' };

const norm = (v) => Math.hypot(v[0], v[1], v[2]);
export const intensity = (s) => norm(s.gyro) + Math.abs(norm(s.acc) - 1);

export class Segmenter {
  constructor({ start = 2.0, stop = 0.8, rest = 0.5, minDuration = 0.3, maxDuration = 5.0, preMotion = 0.15, stillGyro = 10 } = {}) {
    Object.assign(this, { start, stop, rest, minDuration, maxDuration, preMotion, stillGyro });
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
    const steady = this.window.length < STILL_WINDOW || stillMask(this.window, this.stillGyro)[this.window.length - 1];

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
 * never sees it. It shows where the pen actually went, fusing the
 * accelerometer (detail) with the gyroscope (drift-free speed) below.
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

// Acceleration of the pen in the room (m/s², z up) with gravity removed.
function linearAcceleration(s, offset) {
  const acc = offset ? s.acc.map((x, k) => x - offset[k]) : s.acc;
  const a = mul(rotationMatrix(s.angle), acc);
  return [a[0] * G, a[1] * G, (a[2] - 1) * G];
}

// How slow a rotation still counts as movement, from the sensor's noise while
// held still: just above the noisiest resting readings (between 4 and 10 deg/s).
export function stillGyroLimit(restSamples) {
  if (restSamples.length < 10) return STILL_GYRO;
  const g = restSamples.map((s) => Math.hypot(...s.gyro)).sort((a, b) => a - b);
  return Math.min(STILL_GYRO, Math.max(4, 1.5 * g[Math.floor(0.99 * (g.length - 1))]));
}

// Whether the pen is still at each sample, judged from the last 0.1 s only (so
// it never changes for samples already drawn): barely rotating and with a
// steady acceleration. Hand tremor counts as still; any real stroke doesn't.
const STILL_WINDOW = 10;       // samples
const STILL_GYRO = 10;         // deg/s, the fastest allowed rotation in the window
const STILL_ACC_SPREAD = 0.02; // g, spread of the acceleration size in the window
export function stillMask(samples, gyroLimit = STILL_GYRO) {
  return samples.map((_, i) => {
    let gyroMax = 0, sum = 0, sumSq = 0, count = 0;
    for (let j = Math.max(0, i - STILL_WINDOW + 1); j <= i; j++) {
      const s = samples[j];
      gyroMax = Math.max(gyroMax, Math.hypot(...s.gyro));
      const a = Math.hypot(...s.acc);
      sum += a; sumSq += a * a; count++;
    }
    const spread = Math.sqrt(Math.max(0, sumSq / count - (sum / count) ** 2));
    return gyroMax < gyroLimit && spread < STILL_ACC_SPREAD;
  });
}

/* ----------------------------------------------------------------------------
 * Sensor fusion for position: a Kalman filter per room axis with state
 * [position, speed, accelerometer error]. The accelerometer (gravity removed)
 * drives the prediction. After the circle calibration, the gyroscope-based
 * orientation gives a drift-free position, p = R·r (the rotation model fitted
 * to the circle), which corrects it on every sample; the accelerometer adds
 * what rotation misses. Before calibration, speed is pinned to zero when the
 * pen is still and gently pulled towards zero when it barely rotates.
 * Live, the filter output is drawn directly: it only uses the past, so lines
 * already drawn never move. The finished letter also runs the model backwards
 * (Rauch–Tung–Striebel smoother), so the change at the pause is small.
 * ------------------------------------------------------------------------- */
const ACC_NOISE = 0.6;     // m/s²: accelerometer noise plus orientation error
const BIAS_WALK = 0.02;    // m/s² per √s: how fast the accelerometer error may wander
const BIAS_START = 0.08;   // m/s²: initial uncertainty of the accelerometer error
const STILL_SPEED = 0.003; // m/s: speed uncertainty when the pen is still

const ROTATION_POSITION_SD = 0.008; // m: how far the hand may stray from the pure-rotation model

// Speed measurement for one sample, or null for none.
function speedMeasurement(s, isStill, lever) {
  if (lever) return null; // position from rotation already pins speed (and stillness)
  if (isStill) return { z: [0, 0, 0], sd: STILL_SPEED };
  // Without the lever: hands rarely move the pen fast without also turning it.
  return { z: [0, 0, 0], sd: 0.05 + 0.006 * Math.hypot(...s.gyro) };
}

function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-30;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const mm = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, x, k) => s + x * B[k][j], 0)));
const tr = (A) => A[0].map((_, j) => A.map((row) => row[j]));

// Pen position in metres (room coordinates, z up) for each sample.
// With a lever (from the circle), the pen's position comes straight from its
// orientation, p = R·r, which doesn't drift at all; the accelerometer adds the
// detail the rotation model misses. Without one, only speed is constrained.
export function movementPath(samples, { live = false, offset = null, lever = null, stillGyro = STILL_GYRO } = {}) {
  const n = samples.length;
  if (n < 3) return samples.map(() => [0, 0, 0]);
  const lin = samples.map((s) => linearAcceleration(s, offset));
  const still = stillMask(samples, stillGyro);
  const meas = samples.map((s, i) => speedMeasurement(s, still[i], lever));
  let rotPos = null;
  if (lever) {
    const p0 = mul(rotationMatrix(samples[0].angle), lever);
    rotPos = samples.map((s) => { const q = mul(rotationMatrix(s.angle), lever); return [q[0] - p0[0], q[1] - p0[1], q[2] - p0[2]]; });
  }
  const out = samples.map(() => [0, 0, 0]);

  for (let k = 0; k < 3; k++) {
    let x = [0, 0, 0];
    let P = [[1e-8, 0, 0], [0, 1e-8, 0], [0, 0, BIAS_START ** 2]];
    const xf = [], Pf = [], xp = [], Pp = [], Fs = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const dt = Math.max(1e-4, samples[i].t - samples[i - 1].t);
        const a = 0.5 * (lin[i][k] + lin[i - 1][k]);
        const F = [[1, dt, -0.5 * dt * dt], [0, 1, -dt], [0, 0, 1]];
        x = [x[0] + x[1] * dt + 0.5 * dt * dt * (a - x[2]), x[1] + dt * (a - x[2]), x[2]];
        const g = [0.5 * dt * dt, dt, 0];
        P = mm(mm(F, P), tr(F));
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P[r][c] += ACC_NOISE ** 2 * g[r] * g[c];
        P[2][2] += BIAS_WALK ** 2 * dt;
        Fs[i] = F;
      }
      xp[i] = [...x]; Pp[i] = P.map((row) => [...row]);
      const update = (j, z, sd) => { // measure state j (0 = position, 1 = speed)
        const S = P[j][j] + sd * sd;
        const K = [P[0][j] / S, P[1][j] / S, P[2][j] / S];
        const y = z - x[j];
        x = x.map((v, r) => v + K[r] * y);
        const row = [...P[j]];
        P = P.map((pr, r) => pr.map((v, c) => v - K[r] * row[c]));
      };
      if (rotPos) update(0, rotPos[i][k], ROTATION_POSITION_SD);
      if (meas[i]) update(1, meas[i].z[k], meas[i].sd);
      xf[i] = [...x]; Pf[i] = P.map((pr) => [...pr]);
    }
    if (live) {
      for (let i = 0; i < n; i++) out[i][k] = xf[i][0];
      continue;
    }
    let xs = xf[n - 1];
    out[n - 1][k] = xs[0];
    for (let i = n - 2; i >= 0; i--) {
      const C = mm(mm(Pf[i], tr(Fs[i + 1])), inv3(Pp[i + 1]));
      const d = xs.map((v, r) => v - xp[i + 1][r]);
      xs = xf[i].map((v, r) => v + C[r][0] * d[0] + C[r][1] * d[1] + C[r][2] * d[2]);
      out[i][k] = xs[0];
    }
  }
  // The page is anchored where the letter started.
  const o = out[0];
  return out.map((p) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
}

// Calibration helpers --------------------------------------------------------

function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let sum = M[r][n]; for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k]; x[r] = sum / M[r][r]; }
  return x;
}

// Finds where the sensor sits relative to the pivot the hand turns about (r,
// in sensor axes) and the leftover accelerometer error (b, room axes) such
// that the rotation alone explains the measured acceleration:
//   a(t) = d²/dt² [R(t)·r] + b = R''(t)·r + b
// Both sides are compared directly, with no integration, so it works for a
// slow 6-second circle as well as a quick one. Returns null if rotation
// doesn't explain the movement well.
const RDD_STEP = 4; // samples: second differences over ±40 ms
export function fitRotationModel(samples, { offset = null, stillGyro = STILL_GYRO } = {}) {
  const n = samples.length, h = RDD_STEP;
  if (n < 4 * h + 30) return null;
  const R = samples.map((s) => rotationMatrix(s.angle));
  const lin = samples.map((s) => linearAcceleration(s, offset));
  const still = stillMask(samples, stillGyro);
  const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0)), Atb = new Array(6).fill(0);
  const rows = [];
  for (let i = h; i < n - h; i++) {
    if (still[i]) continue;
    const dt = (samples[i + h].t - samples[i - h].t) / (2 * h);
    const Rdd = R[i].map((row, r) => row.map((v, c) => (R[i + h][r][c] - 2 * v + R[i - h][r][c]) / (h * dt) ** 2));
    // the same triangular smoothing that a second difference applies, on the acceleration
    const a = [0, 0, 0];
    for (let j = -h; j <= h; j++) { const w = (h - Math.abs(j)) / (h * h); for (let k = 0; k < 3; k++) a[k] += w * lin[i + j][k]; }
    for (let k = 0; k < 3; k++) {
      const row = [Rdd[k][0], Rdd[k][1], Rdd[k][2], k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
      rows.push([row, a[k]]);
      for (let r = 0; r < 6; r++) { Atb[r] += row[r] * a[k]; for (let c = 0; c < 6; c++) AtA[r][c] += row[r] * row[c]; }
    }
  }
  if (rows.length < 90) return null;
  const sol = solve(AtA, Atb);
  if (!sol) return null;
  const lever = sol.slice(0, 3), bias = sol.slice(3);
  const mean = rows.reduce((acc, [, y]) => acc + y, 0) / rows.length;
  let ssr = 0, sst = 0;
  for (const [row, y] of rows) { const pred = row.reduce((acc, v, j) => acc + v * sol[j], 0); ssr += (y - pred) ** 2; sst += (y - mean) ** 2; }
  const explained = 1 - ssr / (sst || 1e-12);
  const length = Math.hypot(...lever);
  if (!(explained > 0.5) || length < 0.03 || length > 1.5) return null;
  return { lever, bias, explained };
}

// Simple, model-free path for a closed calibration stroke: integrate between
// still periods and remove drift so each stretch ends at rest. Used to measure
// the circle (and the lever) without assuming anything about the lever.
function restToRestVelocity(samples, offset) {
  const n = samples.length;
  const lin = samples.map((s) => linearAcceleration(s, offset));
  const still = stillMask(samples);
  const v = samples.map(() => [0, 0, 0]);
  let start = -1;
  const close = (a, b) => {
    for (let i = a + 1; i <= b; i++) {
      const dt = samples[i].t - samples[i - 1].t;
      for (let k = 0; k < 3; k++) v[i][k] = v[i - 1][k] + 0.5 * (lin[i][k] + lin[i - 1][k]) * dt;
    }
    const t0 = samples[a].t, span = samples[b].t - t0 || 1, end = [...v[b]];
    for (let i = a; i <= b; i++) for (let k = 0; k < 3; k++) v[i][k] -= end[k] * ((samples[i].t - t0) / span);
  };
  still.forEach((isStill, i) => {
    if (!isStill && start < 0) start = Math.max(0, i - 1);
    if ((isStill || i === n - 1) && start >= 0) { close(start, i); start = -1; }
  });
  const p = samples.map(() => [0, 0, 0]);
  for (let i = 1; i < n; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    for (let k = 0; k < 3; k++) p[i][k] = p[i - 1][k] + 0.5 * (v[i][k] + v[i - 1][k]) * dt;
  }
  return { v, p, still };
}

// Least-squares fit of v = R·(ω × r) for r (sensor position relative to the
// wrist pivot, in sensor axes). Returns null if rotation doesn't explain the
// movement well enough to trust.
function fitLever(samples, v, still) {
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
  let total = 0, used = 0;
  const rows = [];
  samples.forEach((s, i) => {
    if (still[i]) return;
    const w = s.gyro.map((x) => x * DEG);
    const W = [[0, -w[2], w[1]], [w[2], 0, -w[0]], [-w[1], w[0], 0]]; // ω × r = W·r
    const A = mm(rotationMatrix(s.angle), W);
    rows.push([A, v[i]]);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) AtA[r][c] += A[0][r] * A[0][c] + A[1][r] * A[1][c] + A[2][r] * A[2][c];
      Atb[r] += A[0][r] * v[i][0] + A[1][r] * v[i][1] + A[2][r] * v[i][2];
    }
    total += dot(v[i], v[i]); used++;
  });
  if (used < 30 || total < 1e-6) return null;
  for (let r = 0; r < 3; r++) AtA[r][r] += 1e-9;
  const inv = inv3(AtA);
  const lever = inv.map((row) => row[0] * Atb[0] + row[1] * Atb[1] + row[2] * Atb[2]);
  let resid = 0;
  for (const [A, vi] of rows) { const pred = mul(A, lever); resid += (pred[0] - vi[0]) ** 2 + (pred[1] - vi[1]) ** 2 + (pred[2] - vi[2]) ** 2; }
  const explained = 1 - resid / total;
  const length = Math.hypot(...lever);
  if (explained < 0.6 || length < 0.03 || length > 0.8) return null;
  return lever;
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
export function pageFromCircle(samples, { offset = null, stillGyro = STILL_GYRO } = {}) {
  const model = fitRotationModel(samples, { offset, stillGyro });
  let path, still, v = null;
  if (model) { // positions straight from rotation: no drift, however slow the circle
    path = movementPath(samples, { offset, lever: model.lever, stillGyro });
    still = stillMask(samples, stillGyro);
  } else {     // quick circle fallback: integrate between pauses
    ({ v, p: path, still } = restToRestVelocity(samples, offset));
  }
  const moving = path.filter((_, i) => !still[i]);
  if (moving.length < 30) throw new Error('That was too short. Draw one full circle, then hold still');
  const { values: [l1, l2, l3], vectors: [, , normal0] } = principalAxes(moving);
  const diameter = 2 * Math.sqrt(l1 + l2); // for a circle of radius r, l1 = l2 = r²/2
  if (diameter < 0.03) throw new Error('That circle was too small to measure. Draw it about the size of a letter');
  if (diameter > 1.2) throw new Error('That circle came out over a metre wide, so the measurement went wrong. Try again, keeping your arm steady');
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
  if (area < 0) { normal = normal.map((x) => -x); ({ right, up } = page()); }
  // How rotation turns into movement for this person and this sensor mounting.
  const lever = model ? model.lever : fitLever(samples, v, still);
  return { right, up, size: diameter, lever };
}

// 2D points for drawing (metres), plus how much the page width represents.
// The page has a fixed scale, so strokes keep their size.
export function tracePoints(samples, { live = false, page = null, offset = null, stillGyro = STILL_GYRO, swap = false, flipX = false, flipY = false } = {}) {
  if (!samples.length) return { points: [], pageWidth: 1 };
  const path = movementPath(samples, { live, offset, stillGyro, lever: page ? page.lever : null });
  const raw = projectToPage(path, samples, page);
  const points = raw.map(([x0, y0]) => {
    let [x, y] = swap ? [y0, x0] : [x0, y0];
    if (flipX) x = -x;
    if (flipY) y = -y;
    return [x, y];
  });
  // 30 cm; after circle calibration, sized from the circle (between 15 and 45 cm,
  // so a big calibration circle doesn't make letters tiny). Bigger strokes still fit.
  return { points, pageWidth: page ? Math.min(0.45, Math.max(0.15, page.size / 0.4)) : 0.3 };
}
