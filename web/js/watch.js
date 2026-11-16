// Apple Watch via the SensorLog app. The watch can't use Web Bluetooth, so it
// streams to the server instead: the page gets a pairing code, SensorLog posts
// to /api/watch/<code>, and letters are classified with both sensors.

const KEY = 'airwrite.watchCode';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode */ } };

export class WatchLink extends EventTarget {
  constructor() {
    super();
    this.code = read();
    this.status = null;
    this.state = this.code ? 'waiting' : 'off'; // off | pairing | waiting | receiving | nomotion | expired
    this.timer = null;
    if (this.code) this.startPolling();
  }

  get url() { return this.code ? `${location.origin}/api/watch/${this.code}` : ''; }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('change'));
  }

  async pair() {
    this.setState('pairing');
    try {
      const res = await fetch('/api/watch/pair', { method: 'POST' });
      if (!res.ok) throw new Error();
      this.code = (await res.json()).code;
      write(this.code);
      this.status = null;
      this.setState('waiting');
      this.startPolling();
    } catch {
      this.setState('off');
      throw new Error('Could not get a pairing code from the server');
    }
  }

  unpair() {
    if (this.code) fetch(`/api/watch/${this.code}`, { method: 'DELETE' }).catch(() => {});
    this.stopPolling();
    this.code = null;
    this.status = null;
    write(null);
    this.setState('off');
  }

  startPolling() {
    this.stopPolling();
    const tick = async () => {
      if (!this.code) return;
      try {
        const res = await fetch(`/api/watch/${this.code}/status`);
        if (res.status === 404) { this.stopPolling(); this.code = null; write(null); this.setState('expired'); return; }
        if (!res.ok) return;
        this.status = await res.json();
        if (!this.status.receiving) this.setState('waiting');
        else this.setState(this.status.motion_fields ? 'receiving' : 'nomotion');
      } catch { /* offline for a moment; keep trying */ }
    };
    tick();
    this.timer = setInterval(tick, 1500);
  }

  stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
