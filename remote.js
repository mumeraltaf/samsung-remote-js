// Talks directly to the monitor's Tizen WebSocket remote-control API.
// No backend involved: https://github.com/xchwarze/samsung-tv-ws-api documents the same protocol.

const APP_NAME = "samsung-remote-web";
const DEVICES_KEY = "samsung-remote-devices";
const MAX_DEVICES = 8;
const IGNORED_EVENTS = new Set(["ed.edenTV.update", "ms.voiceApp.hide"]);
const CONNECT_TIMEOUT_MS = 4000;

// Devices are stored most-recently-used first: [{host, token}, ...]
function loadDevices() {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICES_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveDevices(devices) {
  localStorage.setItem(DEVICES_KEY, JSON.stringify(devices));
}

function getDeviceToken(host) {
  const found = loadDevices().find((d) => d.host === host);
  return found ? found.token : null;
}

// Bumps `host` to the front of the list, merging its token (never
// overwriting a known token with a blank one on reconnect).
function rememberDevice(host, token) {
  const all = loadDevices();
  const existing = all.find((d) => d.host === host);
  const devices = all.filter((d) => d.host !== host);
  devices.unshift({ host, token: token || (existing && existing.token) || null });
  saveDevices(devices.slice(0, MAX_DEVICES));
}

function forgetDevice(host) {
  saveDevices(loadDevices().filter((d) => d.host !== host));
}

const KEY_MAP = {
  power: "KEY_POWER",
  vol_up: "KEY_VOLUP",
  vol_down: "KEY_VOLDOWN",
  mute: "KEY_MUTE",
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  enter: "KEY_ENTER",
  back: "KEY_RETURN",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  source: "KEY_SOURCE",
  exit: "KEY_EXIT",
  info: "KEY_INFO",
  play: "KEY_PLAY",
  pause: "KEY_PAUSE",
  stop: "KEY_STOP",
  rewind: "KEY_REWIND",
  fast_forward: "KEY_FF",
  ch_up: "KEY_CHUP",
  ch_down: "KEY_CHDOWN",
};

const statusEl = document.getElementById("status");
const setupEl = document.getElementById("setup");
const setupMessageEl = document.getElementById("setup-message");
const deviceListEl = document.getElementById("device-list");
const remoteEl = document.getElementById("remote");
const manualHost = document.getElementById("manual-host");
const manualConnect = document.getElementById("manual-connect");
const trustCertLink = document.getElementById("trust-cert-link");
const resetBtn = document.getElementById("reset-btn");

let ws = null;
let currentHost = null;

function renderDeviceList() {
  const devices = loadDevices();
  deviceListEl.innerHTML = "";
  devices.forEach(({ host }) => {
    const li = document.createElement("li");

    const connectBtn = document.createElement("button");
    connectBtn.className = "device-connect";
    connectBtn.textContent = host;
    connectBtn.onclick = () => connectTo(host);

    const removeBtn = document.createElement("button");
    removeBtn.className = "device-remove";
    removeBtn.textContent = "×";
    removeBtn.setAttribute("aria-label", `Forget ${host}`);
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      forgetDevice(host);
      renderDeviceList();
    };

    li.appendChild(connectBtn);
    li.appendChild(removeBtn);
    deviceListEl.appendChild(li);
  });
}

function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

function showSetup(message) {
  setupMessageEl.textContent = message || "Connect to your monitor first.";
  renderDeviceList();
  setupEl.classList.remove("hidden");
  remoteEl.classList.add("hidden");
}

function showRemote() {
  setupEl.classList.add("hidden");
  remoteEl.classList.remove("hidden");
}

function updateTrustLink(host) {
  if (host) {
    trustCertLink.href = `https://${host}:8002`;
    trustCertLink.classList.remove("disabled");
  } else {
    trustCertLink.href = "#";
    trustCertLink.classList.add("disabled");
  }
}

function buildWsUrl(host, token) {
  const name = btoa(APP_NAME);
  let url = `wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${name}`;
  if (token) url += `&token=${token}`;
  return url;
}

// Opens (or reuses) a WebSocket to `host`, resolving once the monitor
// confirms the channel (paired) and rejecting on refusal/timeout/error.
function connect(host) {
  if (ws && ws.readyState === WebSocket.OPEN && currentHost === host) {
    return Promise.resolve(ws);
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  currentHost = host;
  const token = getDeviceToken(host);
  const url = buildWsUrl(host, token);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    ws = socket;
    const openedAt = Date.now();
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("timeout"));
    }, CONNECT_TIMEOUT_MS);

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (IGNORED_EVENTS.has(msg.event)) return;

      if (msg.event === "ms.channel.connect") {
        const token = msg.data && msg.data.token;
        rememberDevice(host, token);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(socket);
        }
        return;
      }

      if (msg.event === "ms.channel.unauthorized") {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.close();
          reject(new Error("unauthorized"));
        }
      }
    };

    socket.onerror = () => {
      // Browsers give no detail here; onclose carries the useful signal.
    };

    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const quickFail = Date.now() - openedAt < 1500;
        reject(new Error(quickFail ? "cert-or-unreachable" : "closed"));
      } else if (remoteEl && !remoteEl.classList.contains("hidden")) {
        // Was connected, dropped later (monitor slept/turned off).
        setStatus("disconnected", "connection lost");
        showSetup("Lost connection to the monitor. Reconnect below.");
      }
    };
  });
}

async function connectTo(host) {
  setStatus("pairing", "connecting…");
  showSetup("Connecting… approve the prompt on the monitor if one appears.");
  try {
    await connect(host);
    setStatus("connected", host);
    showRemote();
    renderDeviceList();
  } catch (err) {
    if (err.message === "unauthorized") {
      setStatus("disconnected", "not connected");
      showSetup("Pairing was rejected or timed out on the monitor. Try again.");
    } else if (err.message === "cert-or-unreachable") {
      setStatus("disconnected", "not connected");
      showSetup(
        "Couldn't reach the monitor. If this is the first time from this browser, " +
          "open the certificate-trust link below, accept the warning, then try again."
      );
    } else {
      setStatus("disconnected", "not connected");
      showSetup("Couldn't reach the monitor. Check the IP address and try again.");
    }
  }
}

manualConnect.onclick = () => {
  const host = manualHost.value.trim();
  if (host) connectTo(host);
};

manualHost.addEventListener("input", () => updateTrustLink(manualHost.value.trim()));

resetBtn.onclick = () => {
  if (ws) {
    ws.close();
    ws = null;
  }
  currentHost = null;
  manualHost.value = "";
  updateTrustLink(null);
  setStatus("disconnected", "not connected");
  showSetup();
};

async function sendKey(label) {
  const key = KEY_MAP[label];
  if (!key) return;

  const devices = loadDevices();
  const host = currentHost || (devices[0] && devices[0].host);
  if (!host) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    try {
      await connect(host);
      setStatus("connected", host);
      showRemote();
    } catch {
      setStatus("disconnected", "not connected");
      showSetup("Lost connection to the monitor. Reconnect below.");
      return;
    }
  }

  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: { Cmd: "Click", DataOfCmd: key, Option: "false", TypeOfRemote: "SendRemoteKey" },
    })
  );
}

document.querySelectorAll(".key").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
    if (navigator.vibrate) navigator.vibrate(15);
    sendKey(btn.dataset.key);
  });
});

// --- Trackpad ---------------------------------------------------------

const SENSITIVITY = 1.5; // tune once we can see the real cursor move
const TAP_MAX_MOVE = 8; // px of total drag still counted as a "tap"
const LONG_PRESS_MS = 500; // held this long with no drag = right-click attempt

const trackpadEl = document.getElementById("trackpad");
const trackpadClickBtn = document.getElementById("trackpad-click");
const trackpadRightClickBtn = document.getElementById("trackpad-right-click");

const keyboardInput = document.getElementById("keyboard-input");
const keyboardSendBtn = document.getElementById("keyboard-send");
const keyboardDoneBtn = document.getElementById("keyboard-done");
let keyboardImeStarted = false; // whether we've sent the one-time "text session started" broadcast

const MODES = ["dpad", "trackpad", "keyboard"];
const modeButtons = Object.fromEntries(MODES.map((m) => [m, document.getElementById(`mode-${m}-btn`)]));
const modePanels = Object.fromEntries(MODES.map((m) => [m, document.getElementById(`${m}-mode`)]));

function setMode(mode) {
  MODES.forEach((m) => {
    modeButtons[m].classList.toggle("active", m === mode);
    modePanels[m].classList.toggle("hidden", m !== mode);
  });
  if (mode === "keyboard") {
    keyboardImeStarted = false;
    keyboardInput.focus();
  }
}

MODES.forEach((m) => {
  modeButtons[m].onclick = () => setMode(m);
});

async function ensureConnected() {
  const devices = loadDevices();
  const host = currentHost || (devices[0] && devices[0].host);
  if (!host) return false;
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  try {
    await connect(host);
    setStatus("connected", host);
    showRemote();
    return true;
  } catch {
    setStatus("disconnected", "not connected");
    showSetup("Lost connection to the monitor. Reconnect below.");
    return false;
  }
}

function sendMouseMove(dx, dy) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: "Move",
        Position: { x: Math.round(dx), y: Math.round(dy), Time: "0" },
        TypeOfRemote: "ProcessMouseDevice",
      },
    })
  );
}

async function sendMouseClick() {
  if (!(await ensureConnected())) return;
  if (navigator.vibrate) navigator.vibrate(15);
  // The ProcessMouseDevice "Click" command doesn't register on this monitor;
  // KEY_ENTER activates whatever the pointer is currently over instead.
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: { Cmd: "Click", DataOfCmd: "KEY_ENTER", Option: "false", TypeOfRemote: "SendRemoteKey" },
    })
  );
}

const RIGHT_CLICK_HOLD_MS = 700; // must exceed the TV's own long-press threshold

async function sendRightClick() {
  if (!(await ensureConnected())) return;
  if (navigator.vibrate) navigator.vibrate([15, 30, 15]);
  // Matches what the physical remote does: holding KEY_ENTER down (rather
  // than a plain Click) opens the browser's secondary-click/context menu.
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: { Cmd: "Press", DataOfCmd: "KEY_ENTER", Option: "false", TypeOfRemote: "SendRemoteKey" },
    })
  );
  await new Promise((resolve) => setTimeout(resolve, RIGHT_CLICK_HOLD_MS));
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: { Cmd: "Release", DataOfCmd: "KEY_ENTER", Option: "false", TypeOfRemote: "SendRemoteKey" },
    })
  );
}

let lastTouch = null;
let touchStartAt = 0;
let totalMove = 0;
let moveQueued = false;
let pendingDx = 0;
let pendingDy = 0;

function flushMove() {
  moveQueued = false;
  if (pendingDx || pendingDy) {
    sendMouseMove(pendingDx, pendingDy);
    pendingDx = 0;
    pendingDy = 0;
  }
}

trackpadEl.addEventListener("touchstart", async (e) => {
  e.preventDefault();
  trackpadEl.classList.add("active");
  const t = e.touches[0];
  lastTouch = { x: t.clientX, y: t.clientY };
  touchStartAt = Date.now();
  totalMove = 0;
  await ensureConnected();
});

trackpadEl.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (!lastTouch) return;
  const t = e.touches[0];
  const dx = (t.clientX - lastTouch.x) * SENSITIVITY;
  const dy = (t.clientY - lastTouch.y) * SENSITIVITY;
  totalMove += Math.abs(t.clientX - lastTouch.x) + Math.abs(t.clientY - lastTouch.y);
  lastTouch = { x: t.clientX, y: t.clientY };

  pendingDx += dx;
  pendingDy += dy;
  if (!moveQueued) {
    moveQueued = true;
    requestAnimationFrame(flushMove);
  }
});

trackpadEl.addEventListener("touchend", (e) => {
  e.preventDefault();
  trackpadEl.classList.remove("active");
  const heldWithoutDrag = totalMove < TAP_MAX_MOVE;
  const elapsed = Date.now() - touchStartAt;
  lastTouch = null;
  if (!heldWithoutDrag) return;
  if (elapsed >= LONG_PRESS_MS) {
    sendRightClick();
  } else {
    sendMouseClick();
  }
});

trackpadClickBtn.addEventListener("click", () => {
  trackpadClickBtn.classList.add("pressed");
  setTimeout(() => trackpadClickBtn.classList.remove("pressed"), 120);
  sendMouseClick();
});

trackpadRightClickBtn.addEventListener("click", () => {
  trackpadRightClickBtn.classList.add("pressed");
  setTimeout(() => trackpadRightClickBtn.classList.remove("pressed"), 120);
  sendRightClick();
});

// --- Keyboard -----------------------------------------------------------

const KEYBOARD_DEBOUNCE_MS = 200;
let keyboardDebounceTimer = null;

// SendInputString replaces the whole focused field's content each time
// (not per-keystroke), so we just resend the full current value.
async function sendTextInput(text) {
  if (!(await ensureConnected())) return;
  if (!keyboardImeStarted) {
    ws.send(
      JSON.stringify({
        method: "ms.channel.emit",
        params: { event: "custom.remote.textReceived", to: "host" },
      })
    );
    keyboardImeStarted = true;
  }
  const encoded = btoa(unescape(encodeURIComponent(text)));
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: { Cmd: encoded, DataOfCmd: "base64", TypeOfRemote: "SendInputString" },
    })
  );
}

async function sendTextInputEnd() {
  if (!(await ensureConnected())) return;
  ws.send(JSON.stringify({ method: "ms.remote.control", params: { TypeOfRemote: "SendInputEnd" } }));
  keyboardImeStarted = false;
}

keyboardInput.addEventListener("input", () => {
  clearTimeout(keyboardDebounceTimer);
  keyboardDebounceTimer = setTimeout(() => sendTextInput(keyboardInput.value), KEYBOARD_DEBOUNCE_MS);
});

keyboardSendBtn.addEventListener("click", () => {
  clearTimeout(keyboardDebounceTimer);
  sendTextInput(keyboardInput.value);
});

keyboardDoneBtn.addEventListener("click", () => {
  clearTimeout(keyboardDebounceTimer);
  sendTextInputEnd();
  keyboardInput.value = "";
  keyboardInput.blur();
});

// Bootstrap from any previously connected device.
(function init() {
  const devices = loadDevices();
  if (devices.length) {
    const mostRecent = devices[0].host;
    manualHost.value = mostRecent;
    updateTrustLink(mostRecent);
    connectTo(mostRecent);
  } else {
    setStatus("disconnected", "not connected");
    showSetup();
  }
})();
