// WitMotion WT9011DCL over Web Bluetooth.
// One connection feeds every mode on the page: each decoded sample is
// dispatched as a "sample" event and the modes listen to it.

export const SERVICE = '0000ffe5-0000-1000-8000-00805f9a34fb';
const NOTIFY = '0000ffe4-0000-1000-8000-00805f9a34fb';
const WRITE = '0000ffe9-0000-1000-8000-00805f9a34fb';
const SET_100_HZ = new Uint8Array([0xff, 0xaa, 0x03, 0x09, 0x00]); // not saved on the sensor
export const SAMPLE_PERIOD = 0.01; // 100 Hz, what both models expect

const nowSeconds = () => (performance.timeOrigin + performance.now()) / 1000;

function decode(p, t) {
  const v = (k) => { const x = p[k] | (p[k + 1] << 8); return x >= 32768 ? x - 65536 : x; };
  return {
    t,
    acc: [v(2), v(4), v(6)].map((x) => (x / 32768) * 16),        // g
    gyro: [v(8), v(10), v(12)].map((x) => (x / 32768) * 2000),   // deg/s
    angle: [v(14), v(16), v(18)].map((x) => (x / 32768) * 180),  // roll, pitch, yaw in deg
  };
}

// Turns notification bytes into samples. One notification often carries
// several packets but arrives with a single time, so each packet gets its own
// timestamp, spaced one sample period apart and always increasing.
export class PacketStream {
  constructor(period = SAMPLE_PERIOD) { this.buf = []; this.period = period; this.last = null; }

  push(bytes, now = nowSeconds()) {
    for (const b of bytes) this.buf.push(b);
    const packets = [];
    let i = 0;
    while (this.buf.length - i >= 20) {
      if (this.buf[i] !== 0x55) { i++; continue; }
      const flag = this.buf[i + 1];
      if (flag === 0x61) { packets.push(this.buf.slice(i, i + 20)); i += 20; }
      else if (flag === 0x71) i += 20; // register read reply
      else i++;
    }
    this.buf = this.buf.slice(i);
    return packets.map((p, k) => {
      let t = now - (packets.length - 1 - k) * this.period;
      if (this.last !== null) t = Math.max(t, this.last + 0.001);
      this.last = t;
      return decode(p, t);
    });
  }
}

// The 8-channel row the gesture model was trained on.
export const gestureRow = (s) => [...s.acc, ...s.gyro, s.angle[0], s.angle[1]];

export class Sensor extends EventTarget {
  constructor() {
    super();
    this.state = 'idle'; // idle | choosing | connecting | live | reconnecting | demo
    this.name = null;
    this.device = null;
    this.stream = new PacketStream();
    this.arrivals = [];
    this.demoTimer = null;
    this.wantConnected = false;
  }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  get rate() {
    const cutoff = performance.now() - 2000;
    while (this.arrivals.length && this.arrivals[0] < cutoff) this.arrivals.shift();
    return this.arrivals.length / 2;
  }

  setState(state, detail = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, detail } }));
  }

  emit(sample) {
    this.arrivals.push(performance.now());
    this.dispatchEvent(new CustomEvent('sample', { detail: sample }));
  }

  async connect() {
    if (!Sensor.supported) throw new Error('This browser cannot use Bluetooth devices.');
    this.stopDemo();
    this.setState('choosing');
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE] });
    } catch (err) {
      this.setState('idle');
      if (err && err.name === 'NotFoundError') return false; // picker closed
      throw err;
    }
    this.device = device;
    this.name = device.name || 'Motion sensor';
    this.wantConnected = true;
    device.addEventListener('gattserverdisconnected', () => this.onDropped());
    await this.open();
    return true;
  }

  async open() {
    this.setState('connecting');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    const notify = await service.getCharacteristic(NOTIFY);
    notify.addEventListener('characteristicvaluechanged', (e) => {
      for (const s of this.stream.push(new Uint8Array(e.target.value.buffer))) this.emit(s);
    });
    await notify.startNotifications();
    try {
      const write = await service.getCharacteristic(WRITE);
      await write.writeValueWithoutResponse(SET_100_HZ);
    } catch { /* older firmware: keep its current rate */ }
    this.setState('live');
  }

  async onDropped() {
    if (!this.wantConnected) return;
    for (let attempt = 1; attempt <= 3 && this.wantConnected; attempt++) {
      this.setState('reconnecting', `attempt ${attempt} of 3`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
      try { await this.open(); return; } catch { /* try again */ }
    }
    this.wantConnected = false;
    this.setState('idle', 'lost');
  }

  disconnect() {
    this.wantConnected = false;
    this.stopDemo();
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* already gone */ }
    this.setState('idle');
  }

  // Plays recorded 8-channel rows (no yaw) as if they came from the sensor.
  playDemo(rows, onDone) {
    this.stopDemo();
    this.name = 'Sample recording';
    this.setState('demo');
    let i = 0;
    let t = nowSeconds();
    this.demoTimer = setInterval(() => {
      for (let k = 0; k < 5 && i < rows.length; k++, i++) {
        const r = rows[i];
        t += SAMPLE_PERIOD;
        this.emit({ t, acc: r.slice(0, 3), gyro: r.slice(3, 6), angle: [r[6], r[7], 0] });
      }
      if (i >= rows.length) { this.stopDemo(); this.setState('idle'); if (onDone) onDone(); }
    }, 50);
  }

  stopDemo() {
    if (this.demoTimer) { clearInterval(this.demoTimer); this.demoTimer = null; }
  }
}
