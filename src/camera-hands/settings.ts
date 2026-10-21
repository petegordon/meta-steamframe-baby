/**
 * Tunables for camera hand tracking. Saved per browser (localStorage) and
 * overridable from the URL, e.g. `?rig=webcam&fov=78&mode=replace`.
 */

export type HandMode =
  /** Camera hands only fill in when the runtime has no hand/controller for that side. */
  | 'auto'
  /** Always use camera hands; hide the runtime's own hands (keeps controllers). */
  | 'replace'
  /** Don't inject anything. */
  | 'off';

export type RigPreset = 'headset' | 'webcam';

export interface CameraHandSettings {
  mode: HandMode;
  rig: RigPreset;
  deviceId: string;
  /** Requested capture size. */
  width: number;
  height: number;
  /** Horizontal field of view of the camera (degrees). */
  hfovDeg: number;
  /** Camera position relative to the head/viewer (meters, three.js axes: x right, y up, z back). */
  camPos: [number, number, number];
  /** Camera rotation relative to the head (degrees: pitch, yaw, roll). */
  camRotDeg: [number, number, number];
  /** MediaPipe labels hands as if the image were a mirrored selfie. Raw camera frames need swapping. */
  swapHandedness: boolean;
  /** Your hand size relative to MediaPipe's average hand (affects depth). */
  handScale: number;
  /** Camera-to-detection latency (ms): hands are placed using the head pose from this long ago. */
  latencyMs: number;
  /** Pinch starts below / ends above this thumb-index distance (fraction of palm length). */
  pinchStart: number;
  pinchEnd: number;
  /** One Euro smoothing. */
  minCutoff: number;
  beta: number;
  /** Ignore detections below this confidence. */
  minScore: number;
}

export const RIG_PRESETS: Record<RigPreset, Pick<CameraHandSettings, 'hfovDeg' | 'camPos' | 'camRotDeg'>> = {
  // A forward-looking camera on the headset, just in front of the eyes.
  headset: { hfovDeg: 100, camPos: [0, -0.01, -0.06], camRotDeg: [-10, 0, 0] },
  // A laptop / desk webcam about 55 cm in front of you, looking back at you.
  webcam: { hfovDeg: 65, camPos: [0, -0.08, -0.55], camRotDeg: [0, 180, 0] },
};

export const DEFAULT_SETTINGS: CameraHandSettings = {
  mode: 'auto',
  rig: 'headset',
  deviceId: '',
  width: 640,
  height: 480,
  ...RIG_PRESETS.headset,
  swapHandedness: true,
  handScale: 1,
  latencyMs: 45,
  pinchStart: 0.28,
  pinchEnd: 0.42,
  minCutoff: 1.2,
  beta: 25,
  minScore: 0.5,
};

const KEY = 'camera-hands.settings.v1';

function fromQuery(s: CameraHandSettings): CameraHandSettings {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  const rig = q.get('rig');
  if (rig === 'headset' || rig === 'webcam') Object.assign(s, { rig }, RIG_PRESETS[rig]);
  const mode = q.get('mode');
  if (mode === 'auto' || mode === 'replace' || mode === 'off') s.mode = mode;
  const fov = num('fov');
  if (fov) s.hfovDeg = fov;
  const lat = num('latency');
  if (lat !== undefined) s.latencyMs = lat;
  if (q.has('swap')) s.swapHandedness = q.get('swap') !== '0';
  return s;
}

export function loadSettings(): CameraHandSettings {
  let saved: Partial<CameraHandSettings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    // Private mode / blocked storage: just use defaults.
  }
  return fromQuery({ ...DEFAULT_SETTINGS, ...saved });
}

export function saveSettings(s: CameraHandSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
