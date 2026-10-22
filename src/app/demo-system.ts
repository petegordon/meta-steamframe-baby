import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OneHandGrabbable,
  PokeInteractable,
  Pressed,
  RayInteractable,
  SphereGeometry,
  Vector3,
  VisibilityState,
  createSystem,
} from '@iwsdk/core';
import { CameraHands } from '../camera-hands/index.js';
import { XR_JOINTS } from '../camera-hands/joints.js';
import { CameraPreview } from './camera-preview.js';
import { HandSkeleton } from './hand-skeleton.js';
import { Hud } from './hud.js';

const TABLE_Z = -0.55;
const TABLE_H = 0.78;
const PALETTE = [0xff6b6b, 0xffd93d, 0x6bcB77, 0x4d96ff, 0xc77dff];

/**
 * Demo: a table with blocks you can pinch-grab and a big button you can poke,
 * driven by camera hand tracking (or real hands/controllers if the headset
 * has them). Hands are read here through the *standard* WebXR API
 * (`frame.getJointPose`), exactly like code written for Meta Quest.
 */
export class DemoSystem extends createSystem({
  pressed: { required: [PokeInteractable, Pressed] },
}) {
  private hands!: CameraHands;
  private preview!: CameraPreview;
  private hud!: Hud;
  private skel = { left: new HandSkeleton('left'), right: new HandSkeleton('right') };
  private blocks: Mesh[] = [];
  private colorIndex = 0;
  private refToWorld = new Matrix4();
  private jointMats = new Float32Array(25 * 16);
  private radii = new Float32Array(25);
  private placePanel = false;
  private headPos = new Vector3();
  private headDir = new Vector3();
  private seen = { left: false, right: false };
  private watchingDevices = false;

  init(): void {
    const world = this.world;
    this.hands = new CameraHands();
    this.preview = new CameraPreview(this.hands);
    this.hud = new Hud(this.hands, this.preview.canvas, () => this.enterXR());
    // Handy from the devtools console (and used by scripts/smoke.mjs).
    Object.assign(window, { cameraHands: this.hands, demo: this });
    this.hands.onStatus = (s) =>
      this.hud.setStatus(
        s.state === 'running' ? `${s.label || 'Camera'} · ${s.width}×${s.height} · ${s.fps} fps · ${s.inferMs} ms/frame (${s.delegate})` : s.message,
        s.state === 'running' || s.state === 'starting',
      );

    void this.checkXRSupport();
    this.buildScene();
    for (const s of Object.values(this.skel)) world.createTransformEntity(s.root, { persistent: true });
    world.createTransformEntity(this.preview.panel, { persistent: true });
    this.preview.panel.visible = false;

    // Hand the camera hands to every XR session (the polyfill).
    const xr = this.renderer.xr;
    const onStart = () => {
      const session = xr.getSession();
      if (!session) return;
      this.hands.attach(session);
      // Permission is usually already granted from the 2D page; this covers "Enter VR" first.
      if (!this.hands.tracker.running) void this.hands.startCamera().catch(() => {});
    };
    xr.addEventListener('sessionstart', onStart);
    this.cleanupFuncs.push(() => xr.removeEventListener('sessionstart', onStart));

    // Read hands the standard WebXR way, every XR frame.
    this.cleanupFuncs.push(
      world.onXRFrame((frame) => {
        const space = world.xrReferenceSpace;
        if (!space) return;
        world.player.updateWorldMatrix(true, false);
        this.refToWorld.copy(world.player.matrixWorld);
        this.readXRHands(frame, space);
      }),
    );

    this.cleanupFuncs.push(
      world.visibilityState.subscribe((state) => {
        const immersive = state !== VisibilityState.NonImmersive;
        this.hud.setVisible(!immersive);
        this.preview.panel.visible = immersive;
        if (immersive) this.placePanel = true;
      }),
    );

    // Poke the button: recolour the blocks.
    this.queries.pressed.subscribe('qualify', () => {
      this.colorIndex = (this.colorIndex + 1) % PALETTE.length;
      this.blocks.forEach((b, i) => ((b.material as MeshStandardMaterial).color = new Color(PALETTE[(this.colorIndex + i) % PALETTE.length])));
    });
  }

  /** Tell the HUD whether this browser can enter VR at all. */
  private async checkXRSupport(): Promise<void> {
    const xr = navigator.xr;
    if (!xr) {
      this.hud.setVr(false, window.isSecureContext ? 'No WebXR in this browser' : 'VR needs https://');
      return;
    }
    // Re-check when a headset connects or the runtime wakes up.
    if (!this.watchingDevices) {
      this.watchingDevices = true;
      xr.addEventListener('devicechange', () => void this.checkXRSupport());
    }
    try {
      const ok = await xr.isSessionSupported('immersive-vr');
      this.hud.setVr(ok, ok ? '' : 'Browser reports no VR headset');
    } catch (e) {
      this.hud.setVr(false, `VR check failed: ${(e as Error).message}`);
    }
  }

  /**
   * Must call requestSession synchronously inside the click: browsers only
   * allow it with "transient user activation", which is gone by the time a
   * camera prompt + model load finishes. The camera starts on sessionstart.
   */
  private enterXR(): void {
    if (!navigator.xr) {
      this.hud.setVrMessage('This browser has no WebXR, so it cannot enter VR.');
      return;
    }
    // IWSDK only console.error()s a failed request, so catch that to show it.
    const origError = console.error;
    let failure = '';
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[XR]')) failure = args.slice(1).map(String).join(' ') || args[0];
      origError.apply(console, args);
    };
    this.hud.setVrMessage('Starting VR…');
    try {
      this.world.launchXR();
    } catch (e) {
      failure = (e as Error).message;
    }
    const started = performance.now();
    const poll = () => {
      if (this.world.sessionRequestPending && performance.now() - started < 30000) return void setTimeout(poll, 100);
      console.error = origError;
      if (this.world.session) this.hud.setVrMessage('');
      else this.hud.setVrMessage(`Couldn't enter VR${failure ? `: ${failure}` : ''}`);
    };
    poll();
  }

  private buildScene(): void {
    const world = this.world;
    const floor = new Mesh(new CylinderGeometry(3, 3, 0.02, 48), new MeshStandardMaterial({ color: 0x3a3d46, roughness: 0.95 }));
    floor.position.y = -0.01;
    floor.name = 'Floor';
    world.createTransformEntity(floor, { persistent: true });

    const table = new Mesh(new BoxGeometry(1.1, 0.04, 0.6), new MeshStandardMaterial({ color: 0x8b6b4a, roughness: 0.7 }));
    table.position.set(0, TABLE_H - 0.02, TABLE_Z);
    table.name = 'Table';
    world.createTransformEntity(table, { persistent: true });
    const legGeo = new BoxGeometry(0.04, TABLE_H - 0.04, 0.04);
    const legMat = new MeshStandardMaterial({ color: 0x5c4630 });
    for (const [x, z] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.5, 0.25]]) {
      const leg = new Mesh(legGeo, legMat);
      leg.position.set(x, (TABLE_H - 0.04) / 2, TABLE_Z + z);
      world.createTransformEntity(leg, { persistent: true });
    }

    // Grabbable blocks (pinch to grab).
    const sizes = [0.06, 0.05, 0.07, 0.045];
    sizes.forEach((s, i) => {
      const geo = i === 3 ? new SphereGeometry(s / 1.6, 24, 16) : new BoxGeometry(s, s, s);
      const block = new Mesh(geo, new MeshStandardMaterial({ color: PALETTE[i], roughness: 0.45 }));
      block.position.set(-0.3 + i * 0.16, TABLE_H + s / 2 + 0.002, TABLE_Z + 0.05);
      block.name = `Block${i}`;
      const e = world.createTransformEntity(block, { persistent: true });
      e.addComponent(RayInteractable);
      e.addComponent(OneHandGrabbable, {});
      this.blocks.push(block);
    });

    // Poke button.
    const button = new Mesh(new CylinderGeometry(0.045, 0.05, 0.03, 32), new MeshStandardMaterial({ color: 0xe8453c, roughness: 0.35 }));
    button.position.set(0.38, TABLE_H + 0.015, TABLE_Z + 0.12);
    button.name = 'PokeButton';
    const be = world.createTransformEntity(button, { persistent: true });
    be.addComponent(PokeInteractable);
    be.addComponent(RayInteractable);

    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(-1, 3, 1.5);
    world.createTransformEntity(sun, { persistent: true });
  }

  /** Standard WebXR Hand Input: works for Quest hands and for our camera hands alike. */
  private readXRHands(frame: XRFrame, space: XRReferenceSpace): void {
    this.seen.left = this.seen.right = false;
    for (const source of frame.session.inputSources) {
      const side = source.handedness;
      if (!source.hand || (side !== 'left' && side !== 'right')) continue;
      let ok = true;
      XR_JOINTS.forEach((name, j) => {
        const joint = source.hand!.get(name);
        const pose = joint && frame.getJointPose?.(joint, space);
        if (!pose) {
          ok = false;
          return;
        }
        this.jointMats.set(pose.transform.matrix, j * 16);
        this.radii[j] = pose.radius ?? 0.008;
      });
      if (ok) {
        this.skel[side].set(this.jointMats, this.radii, this.refToWorld);
        this.seen[side] = true;
      }
    }
    if (!this.seen.left) this.skel.left.hide();
    if (!this.seen.right) this.skel.right.hide();
  }

  update(): void {
    const now = performance.now();
    this.preview.draw(now);
    if (this.world.session) {
      if (this.placePanel) this.placePanelInView();
      return;
    }
    // Flat screen: the 3D camera is the "head"; show the solver's hands directly.
    const cam = this.world.camera;
    cam.updateWorldMatrix(true, false);
    this.hands.updateFlat(cam.matrixWorld);
    for (const side of ['left', 'right'] as const) {
      const h = this.hands.hands[side];
      if (h.isTracked(now)) this.skel[side].set(h.joints);
      else this.skel[side].hide();
    }
  }

  /** Float the camera preview up and to the left of where you're looking. */
  private placePanelInView(): void {
    const head = this.player.head;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(this.headPos);
    if (this.headPos.y < 0.3) return;
    head.getWorldDirection(this.headDir);
    this.headDir.set(-this.headDir.x, 0, -this.headDir.z).normalize();
    const left = new Vector3(this.headDir.z, 0, -this.headDir.x);
    const p = this.preview.panel;
    p.position.copy(this.headPos).addScaledVector(this.headDir, 0.8).addScaledVector(left, 0.45);
    p.position.y = this.headPos.y + 0.05;
    p.lookAt(this.headPos.x, p.position.y, this.headPos.z);
    this.placePanel = false;
  }
}
