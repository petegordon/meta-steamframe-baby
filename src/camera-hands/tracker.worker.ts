/// <reference lib="webworker" />
/**
 * MediaPipe Hand Landmarker, off the main thread so detection never costs a
 * rendered VR frame. Receives camera frames (VideoFrame or ImageBitmap),
 * replies with raw landmarks.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { TrackerRequest, TrackerResponse, RawHand } from './tracker-protocol.js';

let landmarker: HandLandmarker | null = null;
let lastTs = 0;

const post = (msg: TrackerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

async function init(wasmBase: string, modelUrl: string, numHands: number): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  const make = (delegate: 'GPU' | 'CPU') =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    landmarker = await make('GPU');
  } catch (err) {
    console.warn('[camera-hands] GPU delegate failed, using CPU', err);
    delegate = 'CPU';
    landmarker = await make('CPU');
  }
  post({ type: 'ready', delegate });
}

function detect(frame: VideoFrame | ImageBitmap, t: number, width: number, height: number): void {
  if (!landmarker) {
    frame.close();
    return;
  }
  const t0 = performance.now();
  // MediaPipe needs strictly increasing timestamps.
  const ts = Math.max(lastTs + 1, Math.round(t));
  lastTs = ts;
  let hands: RawHand[] = [];
  try {
    const r = landmarker.detectForVideo(frame as unknown as ImageBitmap, ts);
    hands = r.landmarks.map((image, i) => ({
      label: (r.handedness[i]?.[0]?.categoryName ?? 'Right') as 'Left' | 'Right',
      score: r.handedness[i]?.[0]?.score ?? 0,
      image: image.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      world: (r.worldLandmarks[i] ?? []).map((p) => ({ x: p.x, y: p.y, z: p.z })),
    }));
  } catch (err) {
    post({ type: 'error', message: String(err) });
  } finally {
    frame.close();
  }
  post({ type: 'result', t, width, height, hands, ms: performance.now() - t0 });
}

self.onmessage = (e: MessageEvent<TrackerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg.wasmBase, msg.modelUrl, msg.numHands).catch((err) => post({ type: 'error', message: `init failed: ${err}` }));
  } else if (msg.type === 'frame') {
    detect(msg.frame, msg.t, msg.width, msg.height);
  }
};
