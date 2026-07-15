# Samsung Odyssey G7 Remote

A phone-friendly WiFi remote for a Samsung Smart Monitor / Tizen-based
Odyssey G7. Pure client-side: `index.html` + `style.css` + `remote.js`,
no backend, no build step, no dependencies. The browser talks directly to
the monitor's WebSocket remote-control API.

## Running it

There's no server-side logic, so any of these work:

- Open `index.html` directly in a browser.
- Serve the folder with anything static, e.g. `python3 -m http.server 5050`
  (only used to make the files reachable from your phone over WiFi — it
  doesn't run any app logic).
- Host it on GitHub Pages, Netlify, etc.

Then load the page on your phone (same WiFi network as the monitor).

## First-time setup (per browser/device)

Two one-time steps are required by browser security, not by this app:

1. **Trust the monitor's certificate.** The monitor's remote-control
   endpoint uses a self-signed TLS certificate. Browsers refuse WebSocket
   connections to untrusted certs with no prompt to override — you must
   first visit `https://<monitor-ip>:8002` in the same browser and click
   through the "connection is not private" warning once. The app shows a
   link for this once you've entered the monitor's IP.
2. **Approve pairing on the monitor.** After trusting the cert, hit
   Connect. The monitor will show an on-screen prompt asking to allow the
   connection — accept it once. The pairing token is then cached in the
   browser's `localStorage`, so you won't be asked again on that
   browser/device.

## Notes / limitations

- **No auto-discovery.** Browsers can't send the raw UDP packets SSDP
  needs, so you enter the monitor's IP manually. It's remembered in
  `localStorage` after the first connection.
- **Per-device pairing.** Since there's no shared backend, each
  browser/phone you use will need to go through the trust + pairing steps
  once.
- Only works if the monitor has Samsung's Smart Hub / Tizen apps and is
  already joined to your WiFi network (Settings → Network on the
  monitor).
- Protocol reference:
  [`samsungtvws`](https://github.com/xchwarze/samsung-tv-ws-api) (Python
  library implementing the same WebSocket API this app replicates in JS).

## `_flask_backend_old/`

The original Python/Flask implementation (server-side discovery + control)
is kept here for reference. It's not used by the app anymore and can be
deleted at any time.
