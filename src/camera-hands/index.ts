/**
 * Camera hand tracking for headsets whose runtime has no bare-hand tracking
 * (e.g. Valve Steam Frame in WebXR): camera -> MediaPipe -> 3D WebXR hands.
 *
 *   const hands = new CameraHands();
 *   await hands.startCamera();          // from a user gesture, before entering VR
 *   renderer.xr.addEventListener('sessionstart', () => hands.attach(renderer.xr.getSession()!));
 *
 * Inside XR, the hands appear as ordinary `XRInputSource.hand` sources.
 * Outside XR, call `updateFlat(camera.matrixWorld)` every frame and read
 * `hands.hands.left/right` directly.
 */
import type { Matrix4 } from '@iwsdk/core';
import { CameraTracker, type TrackerStatus } from './camera-tracker.js';
import { HandSolver, type Side } from './hand-solver.js';
import { PoseHistory } from './pose-history.js';
import { loadSettings, saveSettings, type CameraHandSettings } from './settings.js';
import type { Observation } from './tracker-protocol.js';
import { XRHandPolyfill } from './xr-hand-polyfill.js';

export type { CameraHand, Side } from './hand-solver.js';
export type { CameraHandSettings } from './settings.js';

export class CameraHands {
  settings: CameraHandSettings;
  readonly tracker = new CameraTracker();
  readonly solver: HandSolver;
  readonly history = new PoseHistory();
  polyfill: XRHandPolyfill | null = null;
  /** Latest raw observation (for the preview overlay). */
  lastObservation: Observation | null = null;
  presented: Record<Side, boolean> = { left: false, right: false };
  onStatus: (s: TrackerStatus) => void = () => {};

  constructor() {
    this.settings = loadSettings();
    this.solver = new HandSolver(this.settings);
    this.tracker.onStatus = (s) => this.onStatus(s);
    this.tracker.onObservation = (o) => {
      this.lastObservation = o;
      this.solver.solve(o, this.history);
    };
  }

  get hands() {
    return this.solver.hands;
  }

  startCamera(): Promise<void> {
    return this.tracker.start({ deviceId: this.settings.deviceId || undefined, width: this.settings.width, height: this.settings.height });
  }

  stopCamera(): void {
    this.tracker.stop();
    this.solver.reset();
  }

  update(patch: Partial<CameraHandSettings>): void {
    const restart = ('deviceId' in patch && patch.deviceId !== this.settings.deviceId) || 'width' in patch;
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.solver.applySettings(this.settings);
    if (restart && this.tracker.running) void this.startCamera().catch(() => {});
  }

  /** Non-XR: the head is the 3D camera. Call once per rendered frame. */
  updateFlat(cameraWorld: Matrix4): void {
    if (this.polyfill) return;
    this.history.push(performance.now(), cameraWorld);
  }

  /** Start presenting camera hands inside this XR session. */
  attach(session: XRSession): XRHandPolyfill {
    this.detach();
    // Poses from flat mode were in a different space.
    this.history.clear();
    this.solver.reset();
    const poly = new XRHandPolyfill(session, {
      hands: this.solver.hands,
      getMode: () => this.settings.mode,
      onViewerPose: (t, m) => this.history.push(t, m),
      onChange: (p) => (this.presented = p),
    });
    this.polyfill = poly;
    session.addEventListener('end', () => {
      if (this.polyfill === poly) this.detach();
    });
    void poly.start();
    return poly;
  }

  detach(): void {
    this.polyfill?.stop();
    this.polyfill = null;
    this.presented = { left: false, right: false };
    this.history.clear();
    this.solver.reset();
  }
}
