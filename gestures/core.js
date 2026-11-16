// shared code for the gesture classifier (used by the site and the node tests)
// sensor bytes -> PacketParser -> samples -> Detector -> 1s window -> random forest -> label
(function (root) {
  const FS = 100;            // sample rate the model was trained on (Hz)
  const WIN = 100;           // 1 second window
  const THR_EVENT = 60;      // gyro magnitude (deg/s) that counts as movement
  const MERGE_S = 0.6;       // bursts closer than this get merged into one event
  const MIN_EVENT_S = 0.2;   // anything shorter is ignored

  // parser
  // witmotion packets are 20 bytes: 0x55, flag, then 18 bytes of data.
  // flag 0x61 = acc + gyro + angle, all int16 little endian
  class PacketParser {
    constructor(onSample) { this.buf = []; this.onSample = onSample; }
    push(bytes) {
      for (const b of bytes) this.buf.push(b);
      let i = 0;
      while (this.buf.length - i >= 20) {
        if (this.buf[i] !== 0x55) { i++; continue; }          // not a header, keep looking
        if (this.buf[i + 1] !== 0x61) {
          if (this.buf[i + 1] === 0x71) { i += 20; continue; }  // 0x71 = register read reply, skip it
          i++; continue;
        }
        const s = (k) => {
          const v = this.buf[i + k] | (this.buf[i + k + 1] << 8);
          return v >= 32768 ? v - 65536 : v;
        };
        this.onSample([
          s(2) / 32768 * 16, s(4) / 32768 * 16, s(6) / 32768 * 16,        // ax ay az in g
          s(8) / 32768 * 2000, s(10) / 32768 * 2000, s(12) / 32768 * 2000, // gx gy gz in deg/s
          s(14) / 32768 * 180, s(16) / 32768 * 180,                       // roll, pitch in deg
        ]);
        i += 20;
      }
      this.buf = this.buf.slice(i);
    }
  }

  // detector
  // same segmentation we used for the training data: gyro magnitude > 60,
  // gaps under 0.6s are merged, event has to last at least 0.2s.
  // the window passed to the model is the 100 samples centred on the peak
  class Detector {
    constructor(onEvent) {
      this.onEvent = onEvent;
      this.hist = [];            // last few seconds of samples
      this.base = 0;             // index of hist[0] in the full stream
      this.n = 0;                // total samples so far
      this.inEv = false; this.start = 0; this.last = 0; this.peak = 0; this.peakV = 0;
    }
    push(s) {
      const i = this.n++;
      this.hist.push(s);
      const gm = Math.hypot(s[3], s[4], s[5]);
      if (gm > THR_EVENT) {
        if (!this.inEv) { this.inEv = true; this.start = i; this.peakV = 0; }
        this.last = i;
        if (gm > this.peakV) { this.peakV = gm; this.peak = i; }
      } else if (this.inEv && (i - this.last) / FS >= MERGE_S) {
        this.inEv = false;
        if ((this.last - this.start) / FS >= MIN_EVENT_S) {
          const a = this.peak - WIN / 2 - this.base;
          if (a >= 0 && a + WIN <= this.hist.length)
            this.onEvent({ window: this.hist.slice(a, a + WIN), peak: this.peakV, index: this.peak });
        }
      }
      // don't let the buffer grow forever
      if (this.hist.length > 600) { this.hist.splice(0, 200); this.base += 200; }
    }
  }

  // features + model
  // W is 100 x 8. 8 stats per channel -> 64 features.
  // the order has to match the python training code or the model breaks
  function features(W) {
    const C = 8, n = W.length, out = [];
    const stat = [[], [], [], [], [], [], [], []];
    for (let c = 0; c < C; c++) {
      let sum = 0, mn = Infinity, mx = -Infinity, ab = 0;
      for (let t = 0; t < n; t++) { const v = W[t][c]; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; if (Math.abs(v) > ab) ab = Math.abs(v); }
      const mean = sum / n; let sq = 0, imax = 0, imin = 0;
      for (let t = 0; t < n; t++) { sq += (W[t][c] - mean) ** 2; if (W[t][c] > W[imax][c]) imax = t; if (W[t][c] < W[imin][c]) imin = t; }
      stat[6].push(imax / n); stat[7].push(imin / n);   // position of max / min in the window
      stat[0].push(mean); stat[1].push(Math.sqrt(sq / n)); stat[2].push(mn); stat[3].push(mx); stat[4].push(ab); stat[5].push(W[n - 1][c] - W[0][c]);
    }
    for (const s of stat) out.push(...s);
    return out;
  }

  // walk every tree to a leaf and average the class probabilities
  function predictProba(model, W) {
    const x = features(W), K = model.classes.length, p = new Array(K).fill(0);
    for (const t of model.trees) {
      let k = 0;
      while (t.l[k] !== -1) k = x[t.f[k]] <= t.t[k] ? t.l[k] : t.r[k];
      const v = t.v[k]; for (let j = 0; j < K; j++) p[j] += v[j];
    }
    return p.map((v) => v / model.trees.length);
  }

  // detector event -> final result. 'return' and 'idle' are never gestures
  function interpret(model, ev, minConf = 0.4) {
    const probs = predictProba(model, ev.window);
    let k = 0; for (let i = 1; i < probs.length; i++) if (probs[i] > probs[k]) k = i;
    const label = model.classes[k];
    const gesture = label.startsWith('swipe_') || label.startsWith('circle_');
    return { label, confidence: probs[k], probs, peak: ev.peak, isGesture: gesture && probs[k] >= minConf };
  }

  root.GestureCore = { FS, WIN, PacketParser, Detector, features, predictProba, interpret };
  if (typeof module !== 'undefined') module.exports = root.GestureCore;
})(typeof window !== 'undefined' ? window : globalThis);
