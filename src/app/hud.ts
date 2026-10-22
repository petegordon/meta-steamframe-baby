import { CameraTracker } from '../camera-hands/camera-tracker.js';
import type { CameraHands } from '../camera-hands/index.js';
import { RIG_PRESETS, type CameraHandSettings, type HandMode, type RigPreset } from '../camera-hands/settings.js';

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get(s: CameraHandSettings): number;
  set(v: number, s: CameraHandSettings): Partial<CameraHandSettings>;
}

const SLIDERS: SliderSpec[] = [
  { label: 'Camera FOV°', min: 40, max: 160, step: 1, get: (s) => s.hfovDeg, set: (v) => ({ hfovDeg: v }) },
  { label: 'Cam pitch°', min: -60, max: 60, step: 1, get: (s) => s.camRotDeg[0], set: (v, s) => ({ camRotDeg: [v, s.camRotDeg[1], s.camRotDeg[2]] }) },
  { label: 'Cam yaw°', min: -180, max: 180, step: 1, get: (s) => s.camRotDeg[1], set: (v, s) => ({ camRotDeg: [s.camRotDeg[0], v, s.camRotDeg[2]] }) },
  { label: 'Cam X (m)', min: -0.3, max: 0.3, step: 0.005, get: (s) => s.camPos[0], set: (v, s) => ({ camPos: [v, s.camPos[1], s.camPos[2]] }) },
  { label: 'Cam Y (m)', min: -0.3, max: 0.3, step: 0.005, get: (s) => s.camPos[1], set: (v, s) => ({ camPos: [s.camPos[0], v, s.camPos[2]] }) },
  { label: 'Cam Z (m)', min: -1, max: 0.2, step: 0.005, get: (s) => s.camPos[2], set: (v, s) => ({ camPos: [s.camPos[0], s.camPos[1], v] }) },
  { label: 'Hand size ×', min: 0.7, max: 1.4, step: 0.01, get: (s) => s.handScale, set: (v) => ({ handScale: v }) },
  { label: 'Latency (ms)', min: 0, max: 200, step: 5, get: (s) => s.latencyMs, set: (v) => ({ latencyMs: v }) },
  { label: 'Pinch start', min: 0.1, max: 0.6, step: 0.01, get: (s) => s.pinchStart, set: (v) => ({ pinchStart: v, pinchEnd: Math.max(v + 0.08, 0) }) },
  { label: 'Smoothing', min: 0.2, max: 4, step: 0.1, get: (s) => s.minCutoff, set: (v) => ({ minCutoff: v }) },
];

/** The flat-screen control panel (hidden inside VR). */
export class Hud {
  readonly root: HTMLDivElement;
  private camBtn!: HTMLButtonElement;
  private camSelect!: HTMLSelectElement;
  private status!: HTMLDivElement;
  private sliders: Array<{ spec: SliderSpec; input: HTMLInputElement; out: HTMLOutputElement }> = [];

  constructor(private hands: CameraHands, previewCanvas: HTMLCanvasElement, private onEnterXR: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <header>
        <h1>Camera Hands</h1>
        <p>Meta-style WebXR hand tracking from a camera, for headsets without it (Steam Frame).</p>
        <div class="build" data-id="build"></div>
      </header>
      <div class="row">
        <button class="primary" data-id="cam">Start camera</button>
        <button class="primary vr" data-id="vr">Enter VR</button>
      </div>
      <div class="status" data-id="vrmsg" hidden></div>
      <div class="status" data-id="status">Camera off</div>
      <div class="preview"></div>
      <label>Camera <select data-id="device"><option value="">Default camera</option></select></label>
      <label>Camera is <select data-id="rig">
        <option value="headset">on the headset, looking out</option>
        <option value="webcam">a webcam in front of me</option>
      </select></label>
      <label>Hands in VR <select data-id="mode">
        <option value="auto">auto (when no controller in that hand)</option>
        <option value="replace">always camera hands</option>
        <option value="off">off</option>
      </select></label>
      <label class="check"><input type="checkbox" data-id="swap"> Swap left/right labels</label>
      <details>
        <summary>Tuning</summary>
        <div class="sliders"></div>
      </details>
    `;
    this.root.querySelector('.preview')!.append(previewCanvas);
    this.status = this.q('status');
    const built = new Date(__BUILD_INFO__.time);
    this.q('build').textContent = `build ${__BUILD_INFO__.commit} · ${built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    this.q('build').title = __BUILD_INFO__.time;
    console.info(`[camera-hands] build ${__BUILD_INFO__.commit} ${__BUILD_INFO__.time}`);
    this.camBtn = this.q('cam');
    this.camSelect = this.q('device');

    this.camBtn.onclick = () => {
      if (this.hands.tracker.running) this.hands.stopCamera();
      else void this.hands.startCamera().then(() => this.refreshDevices()).catch(() => {});
    };
    this.q<HTMLButtonElement>('vr').onclick = () => this.onEnterXR();
    this.camSelect.onchange = () => this.hands.update({ deviceId: this.camSelect.value });

    const rig = this.q<HTMLSelectElement>('rig');
    rig.value = hands.settings.rig;
    rig.onchange = () => {
      const r = rig.value as RigPreset;
      this.hands.update({ rig: r, ...structuredClone(RIG_PRESETS[r]) });
      this.syncSliders();
    };
    const mode = this.q<HTMLSelectElement>('mode');
    mode.value = hands.settings.mode;
    mode.onchange = () => this.hands.update({ mode: mode.value as HandMode });
    const swap = this.q<HTMLInputElement>('swap');
    swap.checked = hands.settings.swapHandedness;
    swap.onchange = () => this.hands.update({ swapHandedness: swap.checked });

    const box = this.root.querySelector('.sliders')!;
    for (const spec of SLIDERS) {
      const label = document.createElement('label');
      label.className = 'slider';
      label.innerHTML = `<span>${spec.label}</span><input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}"><output></output>`;
      const input = label.querySelector('input')!;
      const out = label.querySelector('output')!;
      input.oninput = () => {
        this.hands.update(spec.set(Number(input.value), this.hands.settings));
        out.value = input.value;
      };
      box.append(label);
      this.sliders.push({ spec, input, out });
    }
    this.syncSliders();
    document.body.append(this.root);
    void this.refreshDevices();
  }

  setStatus(text: string, running: boolean): void {
    this.status.textContent = text;
    this.camBtn.textContent = running ? 'Stop camera' : 'Start camera';
  }

  /**
   * Warn (but keep the button usable) when the browser says it can't do VR:
   * some browsers report "unsupported" up front yet still start a session.
   */
  setVr(supported: boolean, reason: string): void {
    this.q<HTMLButtonElement>('vr').title = reason;
    this.setVrMessage(supported ? '' : `${reason} (you can still try Enter VR)`);
  }

  setVrMessage(text: string): void {
    const el = this.q('vrmsg');
    el.textContent = text;
    el.hidden = !text;
  }

  setVisible(v: boolean): void {
    this.root.hidden = !v;
  }

  private syncSliders(): void {
    for (const { spec, input, out } of this.sliders) {
      input.value = String(spec.get(this.hands.settings));
      out.value = input.value;
    }
  }

  /** Device labels only appear after camera permission is granted. */
  private async refreshDevices(): Promise<void> {
    try {
      const cams = await CameraTracker.listCameras();
      const cur = this.hands.settings.deviceId;
      this.camSelect.innerHTML = '<option value="">Default camera</option>';
      cams.forEach((c, i) => {
        const o = document.createElement('option');
        o.value = c.deviceId;
        o.textContent = c.label || `Camera ${i + 1}`;
        this.camSelect.append(o);
      });
      this.camSelect.value = cams.some((c) => c.deviceId === cur) ? cur : '';
    } catch {
      // no mediaDevices (insecure context)
    }
  }

  private q<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.root.querySelector(`[data-id="${id}"]`) as T;
  }
}
