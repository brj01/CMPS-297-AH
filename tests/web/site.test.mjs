// Run with: node --test tests/web/
import test from 'node:test';
import assert from 'node:assert/strict';
import { PacketStream, gestureRow } from '../../web/js/sensor.js';
import { Segmenter, State, tracePoints } from '../../web/js/letters.js';

function packet(acc, gyro, angle) {
  const raw = [...acc.map((v) => v / 16), ...gyro.map((v) => v / 2000), ...angle.map((v) => v / 180)]
    .map((v) => Math.round(v * 32768));
  const bytes = [0x55, 0x61];
  for (const v of raw) { const u = v < 0 ? v + 65536 : v; bytes.push(u & 0xff, u >> 8); }
  return bytes;
}

test('decodes WitMotion packets with the same scaling as the Python parser', () => {
  const [s] = new PacketStream().push(packet([0.5, -1, 1], [100, 0, -250], [10, -20, 170]), 5);
  assert.ok(Math.abs(s.acc[1] + 1) < 1e-3 && Math.abs(s.gyro[2] + 250) < 0.1 && Math.abs(s.angle[2] - 170) < 0.01);
  assert.deepEqual(gestureRow(s).length, 8);
});

test('packets bundled in one notification get increasing timestamps', () => {
  const p = packet([0, 0, 1], [0, 0, 0], [0, 0, 0]);
  const stream = new PacketStream(0.01);
  const a = stream.push([...p, ...p, ...p], 10);
  assert.deepEqual(a.map((s) => +s.t.toFixed(3)), [9.98, 9.99, 10]);
  const b = stream.push([...p, ...p], 10.004); // arrives "too early"
  const times = [...a, ...b].map((s) => s.t);
  times.slice(1).forEach((t, i) => assert.ok(t > times[i]));
});

test('register replies and split notifications are handled', () => {
  const p = packet([0, 0, 1], [1, 2, 3], [0, 0, 0]);
  const reply = [0x55, 0x71, ...new Array(18).fill(0)];
  const stream = new PacketStream();
  assert.equal(stream.push([...reply, ...p.slice(0, 7)], 1).length, 0);
  assert.equal(stream.push(p.slice(7), 1.01).length, 1);
});

const still = (t) => ({ t, acc: [0, 0, 1], gyro: [0, 0, 0], angle: [0, 0, 0] });
const moving = (t) => ({ t, acc: [0.3, 0, 1], gyro: [120, 30, 0], angle: [0, 0, 0] });

test('segmenter returns one letter after movement followed by a pause', () => {
  const seg = new Segmenter();
  let letter = null;
  let t = 0;
  for (let i = 0; i < 20; i++) seg.update(still(t += 0.01));
  for (let i = 0; i < 60; i++) seg.update(moving(t += 0.01));
  assert.equal(seg.state, State.WRITING);
  for (let i = 0; i < 70 && !letter; i++) letter = seg.update(still(t += 0.01));
  assert.ok(letter && letter.length > 60);
  assert.equal(seg.state, State.PROCESSING);
  seg.reset();
  assert.equal(seg.state, State.IDLE);
});

test('non-stop movement is cut off at the 5 s maximum, like the desktop app', () => {
  const seg = new Segmenter();
  let t = 0;
  let out = null;
  let n = 0;
  while (!out && n < 700) { out = seg.update(moving(t += 0.01)); n++; }
  assert.ok(out);
  assert.ok(Math.abs(out[out.length - 1].t - out[0].t - 5) < 0.2);
});

test('calibration raises thresholds for a noisy sensor', () => {
  const seg = new Segmenter();
  const noisy = Array.from({ length: 50 }, (_, i) => ({ t: i / 100, acc: [0, 0, 1], gyro: [3, 0, 0], angle: [0, 0, 0] }));
  const r = seg.calibrate(noisy);
  assert.equal(r.start, 15);
  assert.equal(r.stop, 6);
});

// ---- movement drawing ------------------------------------------------------
import { rotationMatrix, movementPath, projectToPage } from '../../web/js/letters.js';

// Synthetic "L" written on an upright board in front of the writer: known pen
// positions -> accelerations a real sensor would report (gravity included,
// sensor tilted and wobbling, plus a constant accelerometer error).
function synthLetter({ yaw = 30, bias = [0.02, -0.015, 0.01], strokes } = {}) {
  const fs = 100, g = 9.80665;
  const h = [Math.cos(yaw * Math.PI / 180), Math.sin(yaw * Math.PI / 180), 0];
  const right = [h[1], -h[0], 0]; // forward x up
  const ease = (u) => 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5; // smooth start and stop
  const pts2 = [];
  const still = (n) => { for (let i = 0; i < n; i++) pts2.push(pts2.length ? pts2[pts2.length - 1] : [0, 0]); };
  still(30);
  for (const [dx, dy, secs] of strokes) {
    const [x0, y0] = pts2[pts2.length - 1];
    const n = Math.round(secs * fs);
    for (let i = 1; i <= n; i++) { const e = ease(i / n); pts2.push([x0 + dx * e, y0 + dy * e]); }
  }
  still(70);
  const pos = pts2.map(([x, y]) => [0, 1, 2].map((k) => right[k] * x + (k === 2 ? y : 0)));
  const samples = pos.map((_, i) => {
    const a = [0, 1, 2].map((k) => {
      const p = (j) => pos[Math.min(pos.length - 1, Math.max(0, j))][k];
      return (p(i + 1) - 2 * p(i) + p(i - 1)) * fs * fs;
    });
    const angle = [4 * Math.sin(i / 13), -8 + 5 * Math.sin(i / 17), yaw + 3 * Math.sin(i / 11)];
    const R = rotationMatrix(angle);
    const world = [a[0] / g, a[1] / g, a[2] / g + 1];
    const body = [0, 1, 2].map((c) => R[0][c] * world[0] + R[1][c] * world[1] + R[2][c] * world[2]).map((v, k) => v + bias[k]);
    return { t: 100 + i / fs, acc: body, gyro: [i > 30 && i < pos.length - 70 ? 90 : 0.1, 0, 0], angle };
  });
  return { samples, expected: pts2.map(([x, y]) => [x, -y]) }; // page coords: y down
}

function similarity(a, b) { // shape match after centring and scaling; 1 = identical, -1 = mirrored
  const centre = (p) => { const c = [0, 1].map((k) => p.reduce((s, q) => s + q[k], 0) / p.length); return p.map((q) => [q[0] - c[0], q[1] - c[1]]); };
  const A = centre(a), B = centre(b);
  const num = A.reduce((s, p, i) => s + p[0] * B[i][0] + p[1] * B[i][1], 0);
  const na = Math.sqrt(A.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2, 0)), nb = Math.sqrt(B.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2, 0));
  return num / (na * nb);
}

test('movement drawing recovers an "L" despite tilt and accelerometer error', () => {
  const { samples, expected } = synthLetter({ strokes: [[0, -0.12, 0.6], [0.08, 0, 0.5]] });
  const page = projectToPage(movementPath(samples), samples);
  const s = similarity(page, expected);
  assert.ok(s > 0.97, `similarity ${s.toFixed(3)}`);
});

test('movement drawing keeps left and right the right way round', () => {
  const { samples, expected } = synthLetter({ yaw: -70, strokes: [[0.1, 0, 0.5], [0, -0.06, 0.4], [-0.05, 0.03, 0.4]] });
  const page = projectToPage(movementPath(samples), samples);
  const s = similarity(page, expected);
  assert.ok(s > 0.95, `similarity ${s.toFixed(3)}`);
});

test('a single straight stroke (like "I") still draws as a vertical line', () => {
  const { samples, expected } = synthLetter({ strokes: [[0, -0.12, 0.6]] });
  const page = projectToPage(movementPath(samples), samples);
  assert.ok(similarity(page, expected) > 0.97);
});

test('a pen held still with sensor noise and hand tremor barely moves on the page', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2; // repeatable noise in [-1, 1]
  const samples = Array.from({ length: 300 }, (_, i) => {
    const angle = [2 + 0.3 * rnd(), -12 + 0.3 * rnd(), 50 + 0.3 * rnd()];
    const R = rotationMatrix(angle);
    const body = [0, 1, 2].map((c) => R[2][c] + 0.012 * rnd()); // gravity + ~0.01 g noise
    return { t: i / 100, acc: body, gyro: [2.5 * rnd(), 2.5 * rnd(), 1.5 * rnd()], angle }; // tremor around the threshold
  });
  const page = projectToPage(movementPath(samples), samples);
  const extent = Math.max(...page.map((p) => Math.hypot(p[0], p[1])));
  assert.ok(extent < 0.01, `moved ${(extent * 100).toFixed(2)} cm`);
});

test('while writing, lines already drawn stay where they are', () => {
  const { samples } = synthLetter({ strokes: [[0.1, -0.05, 1.2]] });
  const early = samples.slice(0, 30 + 80), later = samples.slice(0, 30 + 100); // both mid-stroke
  const a = projectToPage(movementPath(early, { live: true }), early);
  const b = projectToPage(movementPath(later, { live: true }), later);
  const maxShift = Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  assert.ok(maxShift < 1e-9, `shifted ${maxShift}`);
});

test('up on the page is always up in the room, whatever the heading', () => {
  for (const yaw of [-150, -40, 0, 75, 170]) {
    const { samples, expected } = synthLetter({ yaw, strokes: [[0, -0.1, 0.5], [0.06, 0, 0.4]] });
    const page = projectToPage(movementPath(samples), samples);
    const s = similarity(page, expected);
    assert.ok(s > 0.95, `yaw ${yaw}: similarity ${s.toFixed(3)}`);
  }
});

// ---- circle calibration ----------------------------------------------------
import { pageFromCircle, restingOffset } from '../../web/js/letters.js';

// Writing on a board the writer faces at `boardYaw` (tilted back by `tilt`),
// while the sensor's own heading is `sensorYaw` (it can point anywhere).
function synthOnBoard(path2d, { boardYaw = 20, tilt = 0, sensorYaw = 110 } = {}) {
  const fs = 100, g = 9.80665, D = Math.PI / 180;
  const f = [Math.cos(boardYaw * D), Math.sin(boardYaw * D), 0];
  const right = [f[1], -f[0], 0];
  const up = [-f[0] * Math.sin(tilt * D), -f[1] * Math.sin(tilt * D), Math.cos(tilt * D)];
  const pts = [...Array(30).fill(path2d[0]), ...path2d, ...Array(70).fill(path2d[path2d.length - 1])];
  const pos = pts.map(([x, y]) => [0, 1, 2].map((k) => right[k] * x + up[k] * y));
  const samples = pos.map((_, i) => {
    const at = (j, k) => pos[Math.min(pos.length - 1, Math.max(0, j))][k];
    const a = [0, 1, 2].map((k) => (at(i + 1, k) - 2 * at(i, k) + at(i - 1, k)) * fs * fs);
    const speed = Math.hypot(...[0, 1, 2].map((k) => at(i + 1, k) - at(i - 1, k)));
    const angle = [3 * Math.sin(i / 13), -15 + 4 * Math.sin(i / 17), sensorYaw + 3 * Math.sin(i / 11)];
    const R = rotationMatrix(angle);
    const w = [a[0] / g, a[1] / g, a[2] / g + 1];
    const acc = [0, 1, 2].map((c) => R[0][c] * w[0] + R[1][c] * w[1] + R[2][c] * w[2] + 0.01);
    return { t: 50 + i / fs, acc, gyro: speed > 1e-6 ? [80, 10, 5] : [0.1, 0, 0], angle };
  });
  return { samples, expected: pts.map(([x, y]) => [x, -y]) };
}
const smooth = (n) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n; return 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5; });
const clockwiseCircle = (r = 0.06, secs = 1.0) => smooth(secs * 100).map((e) => [r * Math.sin(2 * Math.PI * e), r * Math.cos(2 * Math.PI * e) - r]);
const letterL = () => [...smooth(60).map((e) => [0, -0.12 * e]), ...smooth(50).map((e) => [0.08 * e, -0.12])];

test('circle calibration finds the page even when the sensor points elsewhere', () => {
  const board = { boardYaw: 20, sensorYaw: 110 }; // sensor heading 90° off the board
  const circle = synthOnBoard(clockwiseCircle(), board);
  const page = pageFromCircle(circle.samples);
  assert.ok(Math.abs(page.size - 0.12) < 0.02, `size ${page.size.toFixed(3)} m`);
  const L = synthOnBoard(letterL(), board);
  const path = movementPath(L.samples);
  const calibrated = similarity(projectToPage(path, L.samples, page), L.expected);
  const guessed = similarity(projectToPage(path, L.samples), L.expected);
  assert.ok(calibrated > 0.95, `calibrated ${calibrated.toFixed(3)}`);
  assert.ok(guessed < 0.9, `without calibration ${guessed.toFixed(3)} (the case calibration exists for)`);
});

test('circle calibration handles a tilted page and keeps it un-mirrored', () => {
  const board = { boardYaw: -60, tilt: 35, sensorYaw: -60 };
  const page = pageFromCircle(synthOnBoard(clockwiseCircle(0.05, 0.9), board).samples);
  const shape = [...smooth(50).map((e) => [0.1 * e, 0]), ...smooth(40).map((e) => [0.1, -0.06 * e]), ...smooth(40).map((e) => [0.1 - 0.05 * e, -0.06 + 0.03 * e])];
  const s = synthOnBoard(shape, board);
  const sim = similarity(projectToPage(movementPath(s.samples), s.samples, page), s.expected);
  assert.ok(sim > 0.95, `similarity ${sim.toFixed(3)}`);
});

test('a line instead of a circle is rejected with a helpful message', () => {
  const line = synthOnBoard(smooth(80).map((e) => [0.12 * e, 0]));
  assert.throws(() => pageFromCircle(line.samples), /circle/); // rejected (as a line, or as too small)
});

// A real sensor at rest: a constant accelerometer offset (typical: a few
// hundredths of a g) plus tremor that keeps the rotation speed above the
// "still" threshold, so the whole time counts as one stroke in progress.
function restingPen({ secs = 3, offset = [0.03, -0.02, 0.025] } = {}) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  return Array.from({ length: secs * 100 }, (_, i) => {
    const angle = [4 + 0.2 * rnd(), -20 + 0.2 * rnd(), 75 + 0.2 * rnd()];
    const R = rotationMatrix(angle);
    const acc = [0, 1, 2].map((c) => R[2][c] + offset[c] + 0.008 * rnd());
    return { t: 10 + i / 100, acc, gyro: [1.5 + rnd(), 1.2 * rnd(), 1.0 * rnd()], angle };
  });
}

test('a resting pen with an accelerometer offset does not draw a growing line while "writing"', () => {
  const samples = restingPen();
  const page = projectToPage(movementPath(samples, { live: true }), samples);
  const extent = Math.max(...page.map((p) => Math.hypot(p[0], p[1])));
  assert.ok(extent < 0.015, `drew ${(extent * 100).toFixed(1)} cm while not moving`);
});

test('holding still measures the accelerometer offset', async () => {
  const { restingOffset } = await import('../../web/js/letters.js');
  const off = restingOffset(restingPen({ secs: 2, offset: [0.03, -0.02, 0.025] }));
  [0.03, -0.02, 0.025].forEach((want, k) => assert.ok(Math.abs(off[k] - want) < 0.003, `axis ${k}: ${off[k].toFixed(4)}`));
});

test('hand tremor alone never starts a letter, and a letter ends at a tremor-y pause', () => {
  const seg = new Segmenter();
  for (const s of restingPen({ secs: 2 })) assert.equal(seg.update(s), null);
  assert.equal(seg.state, State.IDLE);
  // a real stroke, then resting with tremor: the letter should end ~0.5 s into the pause
  let t = 20, letter = null;
  for (let i = 0; i < 60; i++) seg.update({ t: (t += 0.01), acc: [0.4, 0.1, 1.1], gyro: [120, 40, 10], angle: [0, 0, 0] });
  assert.equal(seg.state, State.WRITING);
  for (const s of restingPen({ secs: 2 })) { letter = letter || seg.update({ ...s, t: (t += 0.01) }); }
  assert.ok(letter, 'letter ended');
  assert.ok(letter[letter.length - 1].t - letter[0].t < 1.4, `letter lasted ${(letter[letter.length - 1].t - letter[0].t).toFixed(2)} s`);
});


// ---- sensor fusion with a realistic wrist model ------------------------------
// The pen is moved by rotating about a wrist pivot ~35 cm behind a virtual
// board, and the sensor is stuck on the pen at an angle. Gyroscope and
// accelerometer come from the same physical motion (plus offset and noise).
const mat = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((acc, x, k) => acc + x * B[k][j], 0)));
const T = (A) => A[0].map((_, j) => A.map((row) => row[j]));
function wristWriting(path2d, { boardYaw = 20, dist = 0.35, mount = [0, 0, 90], offset = [0.02, -0.012, 0.015], hold = [30, 80], armShare = 0 } = {}) {
  const fs = 100, g = 9.80665, D = Math.PI / 180;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const f = [Math.cos(boardYaw * D), Math.sin(boardYaw * D), 0], right = [f[1], -f[0], 0];
  const pts = [...Array(hold[0]).fill(path2d[0]), ...path2d, ...Array(hold[1]).fill(path2d[path2d.length - 1])];
  const pos = pts.map(([x, y]) => [0, 1, 2].map((k) => f[k] * dist + right[k] * x + (k === 2 ? y : 0)));
  const Rm = rotationMatrix(mount);
  // armShare: fraction of the movement made by the whole arm sliding (invisible to the gyroscope)
  const pivots = pts.map(([x, y]) => [0, 1, 2].map((k) => armShare * (right[k] * x + (k === 2 ? y : 0))));
  const Rs = pos.map((q0, i) => {
    const q = q0.map((x, k) => x - pivots[i][k]);
    const d = q.map((x) => x / Math.hypot(...q));
    const Rpen = rotationMatrix([8 + 2 * Math.sin(i / 23), -Math.asin(d[2]) / D, Math.atan2(d[1], d[0]) / D]);
    return mat(Rpen, Rm);
  });
  const euler = (R) => [Math.atan2(R[2][1], R[2][2]) / D, -Math.asin(R[2][0]) / D, Math.atan2(R[1][0], R[0][0]) / D];
  const samples = pos.map((_, i) => {
    const at = (j) => Math.min(pos.length - 1, Math.max(0, j));
    const a = [0, 1, 2].map((k) => (pos[at(i + 1)][k] - 2 * pos[i][k] + pos[at(i - 1)][k]) * fs * fs);
    const angle = euler(Rs[i]);
    const R = rotationMatrix(angle);
    const w = [a[0] / g, a[1] / g, a[2] / g + 1];
    const acc = [0, 1, 2].map((c) => R[0][c] * w[0] + R[1][c] * w[1] + R[2][c] * w[2] + offset[c] + 0.004 * rnd());
    const dR = Rs[at(i + 1)].map((row, r) => row.map((x, c) => (x - Rs[at(i - 1)][r][c]) * fs / 2));
    const O = mat(T(Rs[i]), dR); // skew matrix of the body angular velocity
    const gyro = [O[2][1], O[0][2], O[1][0]].map((x) => x / D + 0.3 * rnd());
    return { t: 30 + i / fs, acc, gyro, angle };
  });
  const lever = mat(T(Rs[hold[0]]), pos[hold[0]].map((x, k) => [x - pivots[hold[0]][k]])).map((r) => r[0]);
  return { samples, expected: pts.map(([x, y]) => [x, -y]), lever };
}
const ease5 = (n) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n; return 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5; });
const wristCircle = () => ease5(110).map((e) => [0.06 * Math.sin(2 * Math.PI * e), 0.06 * Math.cos(2 * Math.PI * e) - 0.06]);
const wristL = () => [...ease5(55).map((e) => [0, -0.12 * e]), ...ease5(45).map((e) => [0.08 * e, -0.12])];
const wristN = () => [...ease5(45).map((e) => [0, 0.12 * e]), ...ease5(50).map((e) => [0.08 * e, 0.12 - 0.12 * e]), ...ease5(45).map((e) => [0.08, 0.12 * e])];

test('circle calibration measures how rotation moves the pen (the lever)', () => {
  const { samples, lever } = wristWriting(wristCircle());
  const page = pageFromCircle(samples, { offset: restingOffset(samples.slice(0, 25)) });
  assert.ok(page.lever, 'lever found');
  const err = Math.hypot(...page.lever.map((x, k) => x - lever[k])) / Math.hypot(...lever);
  console.log(`  lever error ${(err * 100).toFixed(1)}%, length ${(Math.hypot(...page.lever) * 100).toFixed(1)} cm (true ${(Math.hypot(...lever) * 100).toFixed(1)} cm)`);
  assert.ok(err < 0.2, `lever off by ${(err * 100).toFixed(0)}%`);
});

for (const [name, shape] of [['L', wristL], ['N', wristN]]) {
  test(`live drawing of "${name}" is already accurate before the pause (fusion with gyroscope)`, () => {
    const cal = wristWriting(wristCircle());
    const offset = restingOffset(cal.samples.slice(0, 25));
    const page = pageFromCircle(cal.samples, { offset });
    const { samples, expected } = wristWriting(shape());
    const end = samples.length - 80; // the moment the stroke ends, before any pause is detected
    const live = projectToPage(movementPath(samples.slice(0, end), { live: true, offset, lever: page.lever }), samples, page);
    const noFusion = projectToPage(movementPath(samples.slice(0, end), { live: true, offset }), samples, page);
    const sLive = similarity(live, expected.slice(0, end));
    const sNoFusion = similarity(noFusion, expected.slice(0, end));
    const cm = (a, b) => { const e = b.map((q) => [q[0] - b[0][0], q[1] - b[0][1]]); return 100 * Math.sqrt(a.reduce((acc, q, i) => acc + (q[0] - e[i][0]) ** 2 + (q[1] - e[i][1]) ** 2, 0) / a.length); };
    const errLive = cm(live, expected.slice(0, end)), errNoFusion = cm(noFusion, expected.slice(0, end));
    console.log(`  ${name}: live error with fusion ${errLive.toFixed(2)} cm | without ${errNoFusion.toFixed(2)} cm (letter is 12 cm tall)`);
    assert.ok(errLive < 0.6 * errNoFusion, 'fusion should clearly beat no fusion');
    assert.ok(errLive < 1.0, `live error ${errLive.toFixed(2)} cm`);
    assert.ok(sLive > 0.95, `live with fusion ${sLive.toFixed(3)}`);
    assert.ok(sLive > sNoFusion, `fusion ${sLive.toFixed(3)} vs without ${sNoFusion.toFixed(3)}`);
    const final = projectToPage(movementPath(samples, { offset, lever: page.lever }), samples, page);
    assert.ok(similarity(final, expected) > 0.96, `final ${similarity(final, expected).toFixed(3)}`);
    // and the finished letter is a refinement of the live one, not a redraw
    const shift = Math.max(...live.map((q, i) => Math.hypot(q[0] - final[i][0], q[1] - final[i][1])));
    console.log(`  ${name}: final ${similarity(final, expected).toFixed(3)} | max live→final shift ${(shift * 100).toFixed(2)} cm`);
    assert.ok(shift < 0.025, `final moved up to ${(shift * 100).toFixed(1)} cm from live`);
  });
}

test('when half the movement comes from the arm (not the wrist), fusion still helps and never hurts', () => {
  const opts = { armShare: 0.5 };
  const cal = wristWriting(wristCircle(), opts);
  const offset = restingOffset(cal.samples.slice(0, 25));
  const page = pageFromCircle(cal.samples, { offset });
  const { samples, expected } = wristWriting(wristN(), opts);
  const end = samples.length - 80;
  const cm = (a, b) => { const e = b.map((q) => [q[0] - b[0][0], q[1] - b[0][1]]); return 100 * Math.sqrt(a.reduce((acc, q, i) => acc + (q[0] - e[i][0]) ** 2 + (q[1] - e[i][1]) ** 2, 0) / a.length); };
  const withF = cm(projectToPage(movementPath(samples.slice(0, end), { live: true, offset, lever: page.lever }), samples, page), expected.slice(0, end));
  const without = cm(projectToPage(movementPath(samples.slice(0, end), { live: true, offset }), samples, page), expected.slice(0, end));
  console.log(`  arm+wrist N: lever ${page.lever ? (Math.hypot(...page.lever) * 100).toFixed(1) + ' cm' : 'not found'} | live error with fusion ${withF.toFixed(2)} cm | without ${without.toFixed(2)} cm`);
  assert.ok(withF <= without * 1.05, 'fusion must not make it worse');
});

// ---- slow, big calibration circle; live processing driven by it ------------
import { stillGyroLimit } from '../../web/js/letters.js';
const errCm = (a, b) => { const e = b.map((q) => [q[0] - b[0][0], q[1] - b[0][1]]); return 100 * Math.sqrt(a.reduce((acc, q, i) => acc + (q[0] - e[i][0]) ** 2 + (q[1] - e[i][1]) ** 2, 0) / a.length); };
const bigSlowCircle = () => ease5(600).map((e) => [0.2 * Math.sin(2 * Math.PI * e), 0.2 * Math.cos(2 * Math.PI * e) - 0.2]);

function calibrateOn(circleShape, opts = {}) {
  const cal = wristWriting(circleShape, opts);
  const rest = cal.samples.slice(0, 25);
  const offset = restingOffset(rest), stillGyro = stillGyroLimit(rest);
  return { page: pageFromCircle(cal.samples, { offset, stillGyro }), offset, stillGyro, lever: cal.lever };
}

test('a slow, big circle (40 cm, 6 s) calibrates: right size, lever found', () => {
  const { page, lever } = calibrateOn(bigSlowCircle());
  console.log(`  slow circle: size ${(page.size * 100).toFixed(1)} cm (true 40), lever ${page.lever ? (Math.hypot(...page.lever) * 100).toFixed(1) : '-'} cm (true ${(Math.hypot(...lever) * 100).toFixed(1)})`);
  assert.ok(Math.abs(page.size - 0.4) < 0.04, `size ${(page.size * 100).toFixed(1)} cm`);
  assert.ok(page.lever, 'lever found');
});

for (const [label, circle] of [['quick circle', wristCircle], ['slow big circle', bigSlowCircle]]) {
  test(`after a ${label}, letters draw accurately live, even written slowly`, () => {
    const { page, offset, stillGyro } = calibrateOn(circle());
    for (const [name, shape] of [['L', wristL], ['slow L', () => [...ease5(300).map((e) => [0, -0.12 * e]), ...ease5(250).map((e) => [0.08 * e, -0.12])]]]) {
      const { samples, expected } = wristWriting(shape());
      const end = samples.length - 80;
      const live = projectToPage(movementPath(samples.slice(0, end), { live: true, offset, stillGyro, lever: page.lever }), samples, page);
      const final = projectToPage(movementPath(samples, { offset, stillGyro, lever: page.lever }), samples, page);
      // What you see: the shape (after matching size), and how far off the size is.
      const shapeErr = (a, b) => { const e = b.map((q) => [q[0] - b[0][0], q[1] - b[0][1]]);
        const k = a.reduce((acc, q, i) => acc + q[0] * e[i][0] + q[1] * e[i][1], 0) / a.reduce((acc, q) => acc + q[0] ** 2 + q[1] ** 2, 0);
        return { cm: errCm(a.map((q) => [q[0] * k, q[1] * k]), b), scale: 1 / k }; };
      const L = shapeErr(live, expected.slice(0, end)), F = shapeErr(final, expected);
      console.log(`  ${label} → ${name}: live shape error ${L.cm.toFixed(2)} cm (size ×${L.scale.toFixed(2)}), finished ${F.cm.toFixed(2)} cm (×${F.scale.toFixed(2)})`);
      assert.ok(L.cm < 0.6 && F.cm < 0.6, `${name}: live ${L.cm.toFixed(2)} cm, final ${F.cm.toFixed(2)} cm`);
      assert.ok(Math.abs(L.scale - 1) < 0.35, `${name}: size off by ×${L.scale.toFixed(2)}`);
    }
  });
}
