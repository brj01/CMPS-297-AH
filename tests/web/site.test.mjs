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
  const pts = tracePoints([170, 179, -179, -170].map((yaw, i) => ({ t: i, acc: [0, 0, 1], gyro: [0, 0, 0], angle: [0, 0, yaw] })));
  const xs = pts.map((p) => p[0]);
  assert.ok(Math.abs(xs[3] + 20) < 1e-9); // 20° of continuous turn, not a 340° jump
});
