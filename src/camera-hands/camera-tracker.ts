/**
 * Camera capture + the MediaPipe worker.
 *
 * Frames are pulled with MediaStreamTrackProcessor where available (Chromium),
 * which keeps flowing during an immersive session, when window
 * requestAnimationFrame / requestVideoFrameCallback may be paused. Otherwise
 * we fall back to a timer + createImageBitmap(video).
 *
 * Only one frame is in flight at a time; extra frames are dropped, so latency
 * stays at one detection rather than piling up.
 */
import type { Observation, TrackerRequest, TrackerResponse } from './tracker-protocol.js';

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
} | undefined;

export interface TrackerStatus {
  state: 'idle' | 'starting' | 'running' | 'error';
  message: string;
  delegate?: 'GPU' | 'CPU';
  /** Detections per second. */
  fps: number;
  /** Worker time per detection (ms). */
  inferMs: number;
  width: number;
  height: number;
  label: string;
}

export class CameraTracker {
  readonly video: HTMLVideoElement;
  status: TrackerStatus = { state: 'idle', message: 'Camera off', fps: 0, inferMs: 0, width: 0, height: 0, label: '' };
  onObservation: (o: Observation) => void = () => {};
  onStatus: (s: TrackerStatus) => void = () => {};

  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private busy = false;
  private stopPump: (() => void) | null = null;
  private count = 0;
  private countStart = 0;
  private ready = false;

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  get running(): boolean {
    return this.status.state === 'running' || this.status.state === 'starting';
  }

  async start(opts: { deviceId?: string; width: number; height: number }): Promise<void> {
    this.stop();
    this.setStatus({ state: 'starting', message: 'Opening camera…' });
    try {
      const video: MediaTrackConstraints = {
        width: { ideal: opts.width },
        height: { ideal: opts.height },
        frameRate: { ideal: 30 },
      };
      if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      this.setStatus({ state: 'error', message: `Camera blocked or missing: ${(err as Error).message ?? err}` });
      throw err;
    }
    const track = this.stream.getVideoTracks()[0];
    const s = track.getSettings();
    this.video.srcObject = this.stream;
    void this.video.play().catch(() => {});

    this.setStatus({ message: 'Loading hand model…', width: s.width ?? 0, height: s.height ?? 0, label: track.label });
    this.ready = false;
    this.worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<TrackerResponse>) => this.onWorker(e.data);
    this.worker.onerror = (e) => this.setStatus({ state: 'error', message: `Worker failed: ${e.message}` });
    const base = new URL(import.meta.env.BASE_URL, location.href);
    this.send({
      type: 'init',
      wasmBase: new URL('mediapipe', base).href,
      modelUrl: new URL('models/hand_landmarker.task', base).href,
      numHands: 2,
    });
    this.stopPump = typeof MediaStreamTrackProcessor !== 'undefined' ? this.pumpProcessor(track) : this.pumpTimer();
  }

  stop(): void {
    this.stopPump?.();
    this.stopPump = null;
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.busy = false;
    this.ready = false;
    this.setStatus({ state: 'idle', message: 'Camera off', fps: 0, inferMs: 0 });
  }

  private send(msg: TrackerRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private onWorker(msg: TrackerResponse): void {
    if (msg.type === 'ready') {
      this.ready = true;
      this.countStart = performance.now();
      this.count = 0;
      this.setStatus({ state: 'running', message: 'Tracking', delegate: msg.delegate });
    } else if (msg.type === 'error') {
      console.error('[camera-hands]', msg.message);
      if (!this.ready) this.setStatus({ state: 'error', message: msg.message });
    } else {
      this.busy = false;
      this.count++;
      const now = performance.now();
      if (now - this.countStart > 1000) {
        this.setStatus({ fps: Math.round((this.count * 1000) / (now - this.countStart)), inferMs: Math.round(msg.ms) });
        this.count = 0;
        this.countStart = now;
      }
      this.onObservation(msg);
    }
  }

  /** Pull VideoFrames straight off the track (keeps running inside XR). */
  private pumpProcessor(track: MediaStreamTrack): () => void {
    const clone = track.clone();
    const reader = new MediaStreamTrackProcessor!({ track: clone }).readable.getReader();
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        if (stopped || !this.ready || this.busy) {
          frame.close();
          continue;
        }
        this.busy = true;
        // VideoFrame timestamps aren't on the performance.now() clock, so use arrival time.
        this.send({ type: 'frame', frame, t: performance.now(), width: frame.displayWidth, height: frame.displayHeight }, [frame]);
      }
    };
    void loop().catch((err) => console.warn('[camera-hands] frame pump stopped', err));
    return () => {
      stopped = true;
      void reader.cancel().catch(() => {});
      clone.stop();
    };
  }

  /** Fallback: grab the <video> on a timer (timers keep running inside XR). */
  private pumpTimer(): () => void {
    const id = window.setInterval(async () => {
      const v = this.video;
      if (!this.ready || this.busy || v.readyState < 2 || !v.videoWidth) return;
      this.busy = true;
      const t = performance.now();
      try {
        const bmp = await createImageBitmap(v);
        this.send({ type: 'frame', frame: bmp, t, width: bmp.width, height: bmp.height }, [bmp]);
      } catch {
        this.busy = false;
      }
    }, 1000 / 30);
    return () => window.clearInterval(id);
  }

  private setStatus(p: Partial<TrackerStatus>): void {
    this.status = { ...this.status, ...p };
    this.onStatus(this.status);
  }
}
