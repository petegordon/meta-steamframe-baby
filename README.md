# meta-steamframe-baby: Camera Hands

Meta-Quest-style **bare-hand tracking for WebXR on headsets that don't have it**, aimed at Valve's Steam Frame. A camera feed runs through MediaPipe and is lifted into 3D. The result is presented to the page as **standard WebXR hand input** (`XRInputSource.hand`, `frame.getJointPose`, pinch → `select` events).

Code written for Quest hand tracking therefore runs unchanged. That covers Meta's Immersive Web SDK ([IWSDK](https://iwsdk.dev)) hand visuals, pinch-grab and poke, and loops like the one in [sandquest-puzzle](https://github.com/petegordon/sandquest-puzzle)'s `hand-sand.ts`.

> **Native version:** [`native/`](native/README.md) is a standalone Steam Frame app (Godot + OpenXR, no browser or PC). It uses the headset's cameras for hand tracking, and you point and make a fist to click or grab. Download the latest build from the [`native-latest` release](https://github.com/petegordon/meta-steamframe-baby/releases/tag/native-latest).

## Why

On Steam Frame, WebXR runs in a community-patched Chromium. Its `XRHand` joints come from the **controllers' finger sensors**. Put the controllers down and the hands disappear, so pages that need bare hands don't work. This project fills that gap from the camera.

## How it works

```
camera ─▶ MediaPipe Hand Landmarker (Web Worker, GPU) ─▶ 21 landmarks (2D + metric 3D shape)
       ─▶ lift: solve the hand's depth so the 3D shape matches the 2D image   (src/camera-hands/lift.ts)
       ─▶ camera → head (camera mount offsets) → world (head pose *at capture time*)
       ─▶ One Euro smoothing ─▶ 25 WebXR joints with orientations             (joints.ts, hand-solver.ts)
       ─▶ XR polyfill: synthetic XRInputSource + patched XRFrame.getPose/getJointPose/fillPoses,
          pinch → selectstart/select/selectend                                (xr-hand-polyfill.ts)
```

- **World-stable hands.** Each detection is placed with the head pose from when the camera frame was captured (`latencyMs`), so hands don't swing when you turn your head.
- **Auto mode.** A camera hand replaces the runtime's input for that side only when the controller isn't in that hand (the camera hand is more than 15 cm from the controller). Pick up a controller and it takes over again. `replace` always uses camera hands; `off` disables them.
- **Off the main thread.** Detection runs in a worker. Frames are pulled with `MediaStreamTrackProcessor`, which keeps flowing during an immersive session, with a timer fallback. Measured at about 15 ms per frame on an M1 after a one-time GPU warm-up of a few seconds.

## Run it

Use Node 20.19+ or 22.12+ (`.nvmrc` says 22.12). Node 21 works with a warning.

```bash
npm install          # also copies MediaPipe's WASM into public/mediapipe
npm run dev          # IWSDK-managed dev server + browser with the Quest emulator (IWER)
# or: npm run dev:runtime   (plain Vite, https://localhost:8081)
npm test             # unit tests for the lift / joint / filter math
npm run smoke        # headless end-to-end check (needs the dev server running)
```

**Desktop test with a webcam:** set "Camera is" to *a webcam in front of me* (or open `?rig=webcam`). Click **Start camera**, and your hands appear as a skeleton in front of the 3D view.

**On the headset:** open `https://<your-computer's-LAN-IP>:8081` in the Frame's WebXR-capable browser and accept the dev certificate. Then:

1. Click **Start camera** and allow access. Do this on the 2D page first, because a permission prompt can't appear inside VR.
2. Pick the camera in the dropdown.
3. Click **Enter VR**.

A floating panel shows the camera view, the detected landmarks and the tracking status. Pinch the blocks to grab them, and poke the red button to recolour them.

## Tuning (the Tuning panel, saved per browser)

| Setting | What it does |
|---|---|
| Camera FOV | Horizontal field of view. Wrong FOV = wrong hand distance. |
| Cam pitch / yaw, X/Y/Z | Where the camera sits relative to your eyes (`headset` preset: just in front, tilted 10° down) |
| Hand size × | Your hand vs MediaPipe's average. Also scales depth. |
| Latency | Camera-to-detection delay used to pick the matching head pose |
| Pinch start | Thumb–index distance (fraction of palm length) that counts as a pinch |
| Swap left/right | MediaPipe labels assume a mirrored selfie image; raw frames need swapping (default on) |

URL overrides: `?rig=webcam|headset&mode=auto|replace|off&fov=100&latency=45&swap=0`.

## Steam Frame: you need a WebXR-enabled browser

Stock Chromium on the Frame (the Flathub app) exposes `navigator.xr` but can't start VR. `isSessionSupported('immersive-vr')` is false, and Enter VR fails with *NotSupportedError: The specified session configuration is not supported*. The cause is that upstream Chromium only builds its OpenXR backend for Windows and Android, so this happens on every WebXR site.

Use a community Chromium build with OpenXR enabled, such as [saphid/chromium-webxr-steam-frame](https://github.com/saphid/chromium-webxr-steam-frame) ([notes](https://github.com/saphid/frame-control/blob/main/docs/webxr-chromium.md)):

- Build it on an x86-64 Linux machine. It needs about 90 GB and several hours.
- Install it on the Frame with `frame/install.sh`. That adds a "Chromium XR" Steam shortcut.
- Launch it from that shortcut, and close any other Chromium first.
- It runs with `--enable-features=OpenXR --disable-seccomp-filter-sandbox`, so use it for VR sites only.

## Known unknowns / next steps

- **Camera access on Steam Frame is unverified.** Whether the Frame's cameras show up to `getUserMedia` in its browser depends on the browser build. If they don't, a native-side camera bridge would be needed. Community work (e.g. CadeXR) has shown local camera-based hand tracking on the Frame.
- **Lens distortion.** The headset's tracking cameras are wide-angle and probably fisheye. The lift assumes a pinhole camera, so accuracy drops toward the edges. Adding undistortion is the next accuracy step.
- **Calibration.** The camera mount offsets are hand-tuned. An automatic calibration (hold a tracked controller and wave, then solve the camera→head transform) would make this plug-and-play.

## Layout

- `src/camera-hands/`: the reusable library (no app code). `index.ts` → `CameraHands`.
- `src/app/`: the demo. `demo-system.ts` holds the scene and reads hands via the standard WebXR API; `hud.ts` is the 2D control panel; `camera-preview.ts` and `hand-skeleton.ts` are debug views.
- `scripts/smoke.mjs`: headless test. It uses a fake camera plus injected detections inside IWSDK's Quest emulator.
