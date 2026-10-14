# MotionDrive — Anything but a Game Controller

**MotionDrive turns a real phone into a live motion controller for a browser-based arcade racer.** Tilt left/right to steer, use a quick shake for a boost, or press the in-app boost control. The browser can also be played with arrow keys as a fallback.

## Why this stack

- **Mobile app:** Expo + React Native + `expo-sensors` for device motion and an installable Android APK.
- **Game:** HTML Canvas and vanilla JavaScript; no game-engine download or GPU requirement.
- **Realtime transport:** WebSocket (`ws`) for low-overhead bidirectional messages.
- **Local server:** Node.js + Express. The server serves the game page and relays validated inputs. No cloud account or API key is required to demo locally.

## Requirements

- Node.js **22.13+** and npm (required by the current Expo SDK used for the phone app).
- A phone with motion sensors. Expo Go is enough for the first test; Android APK builds use Expo EAS Build.
- The laptop and phone connected to the same Wi-Fi network.

## 1. Start the game server on the laptop

From the project root:

```bash
npm install
npm test
npm start
```

Then open **http://localhost:3000** on the laptop. The game screen creates a six-digit room code and displays your laptop's local IPv4 address (for example `192.168.1.24:3000`). Keep this terminal running.

If macOS asks whether Node may accept incoming connections, allow it on your private network. If your Wi-Fi uses client isolation or a guest network, phone-to-laptop communication may be blocked; move both devices to the same ordinary Wi-Fi network.

## 2. Run the phone app during development

Open a second terminal:

```bash
cd mobile
npm install
npx expo start --lan
```

Install **Expo Go** on the phone and scan the QR code shown by Expo. The phone should open the MotionDrive controller screen. Expo Go is just the quick development runner; make a separate APK using section 4 for a standalone submission.

In the app:

1. Enter the laptop IP address and port exactly as shown on the game page, such as `192.168.1.24:3000`.
2. Enter the six-digit room code displayed by the game page.
3. Tap **Connect** and wait for `LINK ESTABLISHED` (the game tab must remain open).
4. Hold the phone upright in a comfortable neutral position and tap **Calibrate**.
5. Tilt left/right to steer. Shake for a short boost, or press and hold **Boost** if you do not want to shake the phone.

You should see the phone connection indicator turn on in the browser, and the app's ping display should update. Use the browser's arrow keys and space bar if you need a keyboard fallback.

### Address tips

- Do **not** type `localhost:3000` into the app: on a phone, `localhost` means the phone itself.
- Use the IPv4 address shown on the browser page. If several interfaces are listed in the title/tooltip, choose the one for your active Wi-Fi adapter.
- If connecting fails, make sure the server terminal is still running, both devices are on the same Wi-Fi, the room code matches the currently open tab, and the laptop firewall permits incoming connections to the Node process.

## 3. Test the game without a phone

Open the browser page and use:

- **Left / Right arrow** or **A / D** — steer.
- **Space** — boost.
- **Generate New Room** — create a new pairing code.
- **Run It Back** — restart after losing all three shields.

This fallback is useful for verifying the game loop, scoring, collisions, HUD, and canvas rendering independently from the motion sensor.

## 4. Build an Android APK

From the `mobile` directory:

```bash
npx eas-cli login
npx eas-cli init
npx eas-cli build --platform android --profile preview
```

When `init` asks, create or link the Expo project; this adds the project identifier to the app configuration. Keep the project's `eas.json` preview profile that sets `android.buildType` to `apk`. EAS performs the Android build in the cloud and gives you a URL when the APK is ready. Open that URL on the Android phone to download and install the APK. Android may ask you to allow installation from that source.

The first EAS build needs an Expo account and internet access. The resulting APK does **not** package the Node server/game; start the server on the laptop during the demo. That is intentional: the phone is the motion controller, while the game runs in the laptop browser.

### iPhone note

The same Expo app can be run on iOS for testing. The requested submission asks for an APK **or** build link, so this repo's fastest standalone artifact is the Android APK. For iOS device distribution, Expo/EAS signing and Apple provisioning requirements apply.

## Message protocol

All live traffic uses `/ws` over the LAN:

- First packet: `{"type":"join","role":"controller|game","code":"123456"}`.
- Motion packet: `{"type":"input","steer":-1..1,"throttle":-1..1,"boost":false,"seq":1,"clientTime":1730000000000}`.
- Server clamps numeric controls, checks packet shape/size/rate, acknowledges input with `ack`, and forwards input packets only to the paired game socket.
- The mobile app reconnects after transient WebSocket closures. The game endpoint also attempts to reconnect while its browser tab remains open. Disconnecting a role resets the last input to neutral.

### Latency approach

The phone requests motion samples at approximately 30 Hz (33 ms). Each control packet carries a sequence number and the phone's send timestamp. The server immediately acknowledges the sequence/timestamp and relays the sanitized input to the game socket. The phone computes the displayed ping from the echoed phone timestamp, so it measures observed client round-trip time (network plus app/server scheduling), not an unsynchronised subtraction of laptop and phone clocks. The game never waits for an AI/API/cloud call; it applies the latest controls on its next animation frame. The browser also falls back to keyboard input when controller packets go stale.

The WebSocket traffic is intentionally plain `ws://` for a local Wi-Fi demo. Treat this as a hackathon prototype for a trusted network, not an internet-facing production service. Do not port-forward it to the public internet. A production version should use TLS, authenticated pairing, explicit origin/access controls, deployment-level abuse protection, and a stronger pairing handshake.

## Project tree

```text
MotionDrive/
├── server/
│   ├── index.js
│   ├── src/
│   │   ├── create-server.js
│   │   ├── protocol.js
│   │   └── session-store.js
│   └── test/
│       ├── integration.test.js
│       ├── protocol.test.js
│       └── session-store.test.js
├── web/
│   ├── index.html
│   ├── styles.css
│   └── game.js
├── mobile/
│   ├── App.js
│   ├── app.json
│   ├── eas.json
│   └── package.json
└── package.json
```

## Troubleshooting

**The game loads but does not show a room code:** look at the server terminal, refresh `http://localhost:3000`, and check that port 3000 is available.

**The phone says it cannot reach the laptop:** verify the LAN IP rather than localhost, same Wi-Fi, port `3000`, and macOS firewall permissions. Some campus/guest Wi-Fi networks isolate devices; a personal hotspot can be a useful test network.

**The app connects but motion is flat:** use a physical phone (not a simulator), grant motion access if prompted, tap Calibrate with the phone held normally, and then tilt gently. The touch boost and keyboard fallback can still be used to demonstrate the loop.

**The installed APK behaves differently from Expo Go:** rebuild after changing `app.json` or native configuration; test the exact release APK before recording the submission video.

## License

MIT — see `LICENSE`.
