// Gesture mode: a thin wrapper around gestures/core.js (loaded as a classic
// script that defines window.GestureCore). core.js and model.json are used
// as-is, so the model keeps the exact features it was trained on.

export const GESTURES = ['swipe_up', 'swipe_down', 'swipe_left', 'swipe_right', 'circle_right', 'circle_left'];
export const MIN_CONFIDENCE = 0.4;

export const LABELS = {
  swipe_up: 'Swipe up', swipe_down: 'Swipe down', swipe_left: 'Swipe left', swipe_right: 'Swipe right',
  circle_right: 'Circle right', circle_left: 'Circle left', return: 'Return stroke', idle: 'Still',
};

// SVG paths on a 120×120 canvas. Each is drawn as one stroke so it can be animated.
export const GLYPHS = {
  swipe_up: 'M60 92 V30 M38 52 L60 30 L82 52',
  swipe_down: 'M60 28 V90 M38 68 L60 90 L82 68',
  swipe_left: 'M92 60 H30 M52 38 L30 60 L52 82',
  swipe_right: 'M28 60 H90 M68 38 L90 60 L68 82',
  circle_right: 'M60 26 A34 34 0 1 1 26.5 66 M20.6 78.6 L26.5 66 L36.3 75.9',
  circle_left: 'M60 26 A34 34 0 1 0 93.5 66 M99.4 78.6 L93.5 66 L83.7 75.9',
  return: 'M30 60 C45 48 75 72 90 60',
  unsure: 'M44 46 C44 30 76 30 76 46 C76 58 60 58 60 72 M60 86 V88',
};

export async function loadGestureModel() {
  if (!window.GestureCore) throw new Error('Gesture code did not load');
  const res = await fetch('/gestures/model.json');
  if (!res.ok) throw new Error('Gesture model did not load');
  return res.json();
}

export class GestureMode {
  constructor(model, onResult) {
    this.model = model;
    this.onResult = onResult;
    this.reset();
  }

  reset() {
    const G = window.GestureCore;
    this.detector = new G.Detector((ev) => {
      const r = G.interpret(this.model, ev, MIN_CONFIDENCE);
      let kind = 'gesture';
      if (!r.isGesture) kind = r.label === 'return' && r.confidence >= MIN_CONFIDENCE ? 'return' : 'unsure';
      this.onResult({ ...r, kind, classes: this.model.classes });
    });
  }

  push(row) { this.detector.push(row); }
}
