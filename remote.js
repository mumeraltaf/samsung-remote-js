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
