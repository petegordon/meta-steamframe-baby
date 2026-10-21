import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import type { CameraHands } from '../camera-hands/index.js';

const BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/**
 * What the camera sees + the detected landmarks + status text, drawn on one
 * canvas. Shown in the HTML HUD outside VR and as a floating panel inside.
 */
export class CameraPreview {
  readonly canvas = document.createElement('canvas');
  readonly texture: CanvasTexture;
  readonly panel: Mesh;
  private ctx: CanvasRenderingContext2D;
  private last = 0;

  constructor(private hands: CameraHands) {
    this.canvas.width = 640;
    this.canvas.height = 480 + 72;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const aspect = this.canvas.width / this.canvas.height;
    this.panel = new Mesh(
      new PlaneGeometry(0.36 * aspect, 0.36),
      new MeshBasicMaterial({ map: this.texture, side: DoubleSide, toneMapped: false }),
    );
    this.panel.name = 'CameraPreview';
  }

  /** Redraw (throttled to ~20 Hz). */
  draw(now: number): void {
    if (now - this.last < 50) return;
    this.last = now;
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = 480;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, canvas.height);
    const video = this.hands.tracker.video;
    if (video.readyState >= 2 && video.videoWidth) {
      // Fit the video into W x H.
      const s = Math.min(W / video.videoWidth, H / video.videoHeight);
      const w = video.videoWidth * s;
      const h = video.videoHeight * s;
      const x0 = (W - w) / 2;
      const y0 = (H - h) / 2;
      ctx.drawImage(video, x0, y0, w, h);
      const obs = this.hands.lastObservation;
      if (obs && now - obs.t < 500) {
        for (const raw of obs.hands) {
          const side = this.hands.solver.sideOf(raw);
          ctx.strokeStyle = side === 'left' ? '#55c8ff' : '#ffa64d';
          ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = 3;
          const P = (i: number) => [x0 + raw.image[i].x * w, y0 + raw.image[i].y * h] as const;
          ctx.beginPath();
          for (const [a, b] of BONES) {
            ctx.moveTo(...P(a));
            ctx.lineTo(...P(b));
          }
          ctx.stroke();
          for (let i = 0; i < 21; i++) {
            const [x, y] = P(i);
            ctx.fillRect(x - 3, y - 3, 6, 6);
          }
          const [wx, wy] = P(0);
          ctx.font = 'bold 20px system-ui';
          ctx.fillText(`${side} ${(raw.score * 100) | 0}%`, wx + 8, wy + 22);
        }
      }
    } else {
      ctx.fillStyle = '#888';
      ctx.font = '24px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Camera off', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
    // Status bar.
    const st = this.hands.tracker.status;
    const hl = this.hands.hands.left;
    const hr = this.hands.hands.right;
    const handTxt = (h: typeof hl) =>
      h.isTracked(now) ? `${h.pinching ? 'PINCH' : 'open'} ${h.pinch.toFixed(2)}` : '—';
    ctx.fillStyle = '#222';
    ctx.fillRect(0, H, W, canvas.height - H);
    ctx.fillStyle = '#eee';
    ctx.font = '20px system-ui';
    ctx.fillText(`${st.message}${st.delegate ? ` (${st.delegate})` : ''} · ${st.fps} fps · ${st.inferMs} ms · mode ${this.hands.settings.mode}`, 12, H + 28);
    ctx.fillText(`L: ${handTxt(hl)}${this.hands.presented.left ? ' (XR)' : ''}   R: ${handTxt(hr)}${this.hands.presented.right ? ' (XR)' : ''}`, 12, H + 58);
    this.texture.needsUpdate = true;
  }
}
