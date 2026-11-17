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

test('trace unwraps yaw across ±180°', () => {
  const { points: pts } = tracePoints([170, 179, -179, -170].map((yaw, i) => ({ t: i, acc: [0, 0, 1], gyro: [0, 0, 0], angle: [0, 0, yaw] })), { method: 'tilt' });
  const xs = pts.map((p) => p[0]);
  assert.ok(Math.abs(xs[3] + 20) < 1e-9); // 20° of continuous turn, not a 340° jump
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
