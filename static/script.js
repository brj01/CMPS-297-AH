const $ = (id) => document.querySelector(id);
const history = { acc: [[], [], []], gyro: [[], [], []] };
const watchHistory = { acc: [[], [], []], gyro: [[], [], []] };
const maxPoints = 180;
let chartTimer;

function drawChart(canvas, series, colors, labels, min, max) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width = canvas.clientWidth * devicePixelRatio;
  const height = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#dbe3ef"; ctx.lineWidth = devicePixelRatio;
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  series.forEach((values, index) => {
    if (!values.length) return;
    ctx.strokeStyle = colors[index]; ctx.lineWidth = 2 * devicePixelRatio; ctx.beginPath();
    values.forEach((value, point) => {
      const x = point / (maxPoints - 1) * width;
      const y = height - ((Math.max(min, Math.min(max, value)) - min) / (max - min) * height);
      point ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  ctx.font = `${12 * devicePixelRatio}px system-ui`;
  labels.forEach((label, index) => { ctx.fillStyle = colors[index]; ctx.fillText(label, 10 * devicePixelRatio + index * 55 * devicePixelRatio, 18 * devicePixelRatio); });
}

function addSeries(target, values) {
  values.forEach((value, index) => { target[index].push(Number(value)); if (target[index].length > maxPoints) target[index].shift(); });
}

function showSample(sample) {
  if (!sample || !sample.acc) return;
  const acc = sample.acc, gyro = sample.gyro, orientation = sample.orientation || [0, 0, 0];
  ["x", "y", "z"].forEach((axis, i) => {
    $(`#acc-${axis}`).textContent = Number(acc[i]).toFixed(3);
    $(`#gyro-${axis}`).textContent = Number(gyro[i]).toFixed(2);
  });
  ["x", "y", "z"].forEach((axis, i) => $(`#angle-${axis}`).textContent = Number(orientation[i] || 0).toFixed(3));
  $("#orientation-cube").style.transform = `rotateX(${-orientation[1]}deg) rotateY(${orientation[0]}deg) rotateZ(${-orientation[2]}deg)`;
  $("#compass-needle").style.transform = `rotate(${orientation[2] || 0}deg)`;
  $("#level-bubble").style.transform = `translate(${Math.max(-65, Math.min(65, orientation[0] || 0))}px, ${Math.max(-65, Math.min(65, orientation[1] || 0))}px)`;
  addSeries(history.acc, acc); addSeries(history.gyro, gyro);
  clearTimeout(chartTimer);
  chartTimer = setTimeout(() => {
    drawChart($("#acc-chart"), history.acc, ["#ef4444", "#22a06b", "#2563eb"], ["X", "Y", "Z"], -16, 16);
    drawChart($("#gyro-chart"), history.gyro, ["#ef4444", "#22a06b", "#2563eb"], ["X", "Y", "Z"], -2000, 2000);
  }, 20);
}

function showWatch(sample) {
  if (!sample || !sample.acc) return;
  const acc = sample.acc, gyro = sample.gyro;
  $("#watch-acc-norm").textContent = Number(sample.acc_norm ?? Math.hypot(...acc)).toFixed(3);
  $("#watch-gyro-norm").textContent = Number(sample.gyro_norm ?? Math.hypot(...gyro)).toFixed(2);
  addSeries(watchHistory.acc, acc); addSeries(watchHistory.gyro, gyro);
}

async function status() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    const data = await response.json();
    const live = data.pen_connected && data.packet_age_seconds !== null && data.packet_age_seconds < 2;
    $("#status").innerHTML = `<span class="dot ${live ? "on" : ""}"></span><strong>${live ? "CONNECTED & RECEIVING" : data.pen_connected ? "CONNECTED — NO DATA" : "OFFLINE"}</strong>`;
    $("#rate").textContent = `${data.packet_rate_hz || 0} Hz`;
    $("#packets").textContent = data.packets || 0;
    $("#details").textContent = data.pen_address ? `Address: ${data.pen_address} | Notify: ${data.notification_characteristic || "unknown"}` : "Not connected";
    $("#device-address").textContent = data.pen_address || $("#devices").value;
    $("#device-dot").classList.toggle("on", live);
    $("#device-state").textContent = live ? "Connected and receiving" : data.pen_connected ? "Connected — no decoded data" : "Offline";
    $("#packet-health").textContent = live ? `Valid decoded packets are arriving. Last packet ${data.packet_age_seconds.toFixed(2)} seconds ago.` : "No recent decoded packet. Check power, address, and whether WitMotion software is closed.";
    $("#raw").textContent = `Raw packet: ${data.raw_packet || "—"}`;
    $("#sync").textContent = JSON.stringify(data.sync);
    const watchLive = data.watch_connected && data.watch_age_seconds !== null && data.watch_age_seconds < 3;
    $("#watch-dot").classList.toggle("on", watchLive);
    $("#watch-state").textContent = watchLive ? "RECEIVING" : "OFFLINE";
    $("#watch-details").textContent = watchLive ? "SensorLog is sending live samples over LAN." : "Send SensorLog data to the configured LAN URL.";
    $("#watch-rate").textContent = data.watch_rate_hz || 0;
    $("#watch-packets").textContent = data.watch_packets || 0;
    const active = Boolean(data.session_active);
    $("#session-state").textContent = active ? (data.state === "PROCESSING" ? "PROCESSING LETTER" : "SESSION LIVE") : "SESSION STOPPED";
    $("#session-state").className = `session-pill ${active ? (data.state === "PROCESSING" ? "processing" : "live") : ""}`;
    $("#workflow").textContent = active ? "Write one letter, pause, and wait for the next prediction." : "Connect sensors, then start a session";
  } catch (error) { $("#error").textContent = error.message; }
}

async function responseData(response) {
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; }
  catch { throw new Error(`Server returned ${response.status}: ${body.slice(0, 180)}`); }
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
  return data;
}

$("#scan").onclick = async () => {
  $("#error").textContent = "Scanning...";
  try {
    const response = await fetch("/api/bluetooth/scan");
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json(), select = $("#devices");
    select.innerHTML = "";
    (data.devices || []).forEach(device => {
      const option = document.createElement("option");
      option.value = device.address; option.textContent = `${device.name} (${device.address})`; select.append(option);
    });
    $("#error").textContent = `${data.devices.length} device(s) found`;
  } catch (error) { $("#error").textContent = error.message; }
};
$("#connect").onclick = async () => {
  $("#error").textContent = "Connecting and discovering notifications...";
  try {
    const response = await fetch("/api/bluetooth/connect", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({address: $("#devices").value}) });
    const data = await responseData(response);
    $("#error").textContent = `Connected; listening on ${data.notification_characteristic}`;
    await status();
  } catch (error) { $("#error").textContent = error.message; }
};
$("#disconnect").onclick = () => fetch("/api/bluetooth/disconnect", {method: "POST"}).then(status);
$("#simulate").onclick = () => fetch("/api/simulation", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({enabled: true})}).then(status);
$("#start-session").onclick = async () => { await fetch("/api/session/start", {method: "POST"}); $("#error").textContent = "Session started. Write one letter."; status(); };
$("#stop-session").onclick = async () => { await fetch("/api/session/stop", {method: "POST"}); $("#error").textContent = "Session stopped."; status(); };
document.querySelectorAll("[data-action]").forEach(button => button.onclick = () => fetch(`/api/text/${button.dataset.action}`, {method: "POST"}).then(response => response.json()).then(data => $("#text").value = data.text));
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.data) {
    const sample = message.data.latest && message.data.latest.pen;
    showSample(sample); showWatch(message.data.latest && message.data.latest.watch); $("#text").value = message.data.text;
  }
  if (message.type === "prediction") {
    const prediction = message.data;
    if (prediction.status === "error") {
      $("#error").textContent = `Couldn't classify that letter: ${prediction.error}. Try writing it again.`;
      return;
    }
    $("#letter").textContent = prediction.letter || `class ${prediction.class_id}`;
    const historyEl = $("#prediction-history");
    const empty = historyEl.querySelector(".empty"); if (empty) empty.remove();
    const item = document.createElement("span");
    item.className = `prediction ${prediction.accepted ? "" : "rejected"}`;
    item.innerHTML = `<strong>${prediction.letter || `#${prediction.class_id}`}</strong><small>${prediction.status} · ${Number(prediction.latency_ms || 0).toFixed(1)} ms</small>`;
    historyEl.prepend(item);
    while (historyEl.children.length > 12) historyEl.lastElementChild.remove();
  }
};
ws.onerror = () => $("#error").textContent = "WebSocket disconnected; refresh the page.";
status(); setInterval(status, 1000);
