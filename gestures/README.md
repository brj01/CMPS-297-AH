# Gesture classifier (WitMotion WT9011DCL)

| File | What it is |
|---|---|
| `core.js` | Parses the sensor's Bluetooth packets, detects gesture events and runs the classifier. Plain JavaScript, no dependencies. |
| `model.json` | The trained random forest (100 trees, 64 features). When the model is retrained, only this file changes. |

## How it works

sensor (100 Hz) -> `PacketParser` -> `Detector` -> `interpret(model, event)` -> label

- **PacketParser** converts the raw 20-byte packets into samples (ax, ay, az, gx, gy, gz, roll, pitch).
- **Detector** looks for a burst of gyro movement and passes on the 100 samples (1 s) around its peak. It fires about 0.7 s after the movement stops.
- **interpret** runs the classifier and returns `{ label, confidence, probs, peak, isGesture }`.

Gesture labels: `swipe_up`, `swipe_down`, `swipe_left`, `swipe_right`, `circle_right`, `circle_left`.
`return` (the slow stroke back) and `idle` aren't gestures. `isGesture` is false for them, and for anything below 40% confidence.

## Usage

```js
const model = await (await fetch('model.json')).json();

const detector = new GestureCore.Detector(ev => {
  const r = GestureCore.interpret(model, ev);   // r.label, r.confidence, r.isGesture
  if (r.isGesture) console.log(r.label, r.confidence);
});
const parser = new GestureCore.PacketParser(s => detector.push(s));

// feed it the bytes from each Bluetooth notification:
// parser.push(new Uint8Array(value.buffer));
```

## Sensor notes

- BLE service `0000ffe5-0000-1000-8000-00805f9a34fb`, notify characteristic `...ffe4...`, write characteristic `...ffe9...`.
- **The sensor has to be set to 100 Hz.** The default is 10 Hz, and the model doesn't work at that rate. After connecting, write `FF AA 03 09 00` to the write characteristic. The setting isn't saved on the sensor, so this has to happen on every connection.
- The sensor only accepts one connection at a time, so close the WitMotion app first.

## Limitations

- Accuracy is about 95% on a small held-out set that was recorded in the same session as the training data. Expect it to be lower with a different strap position or swipe speed.
- There are no "random movement" examples in the training data yet, so normal hand movement can sometimes be detected as a gesture.
- `core.js` and `model.json` have to match: the model expects the exact 64 features `core.js` computes. If the feature code changes, the model has to be retrained.