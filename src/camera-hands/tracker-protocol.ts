/** Messages between the main thread and the MediaPipe worker. */

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface RawHand {
  /** MediaPipe's label (assumes a mirrored selfie image). */
  label: 'Left' | 'Right';
  score: number;
  /** 21 normalised image landmarks. */
  image: P3[];
  /** 21 metric landmarks (meters, centred on the hand). */
  world: P3[];
}

export type TrackerRequest =
  | { type: 'init'; wasmBase: string; modelUrl: string; numHands: number }
  | { type: 'frame'; frame: VideoFrame | ImageBitmap; t: number; width: number; height: number };

export type TrackerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  /** `t`: when the frame was captured (performance.now() ms). */
  | { type: 'result'; t: number; width: number; height: number; hands: RawHand[]; ms: number };

export type Observation = Extract<TrackerResponse, { type: 'result' }>;
