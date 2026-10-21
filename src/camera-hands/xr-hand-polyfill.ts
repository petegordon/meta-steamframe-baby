/**
 * Makes camera-tracked hands look like native WebXR hand input.
 *
 * During an XR session this:
 *   - adds synthetic XRInputSources (with an `XRHand` of 25 joint spaces) to
 *     `session.inputSources`, and fires `inputsourceschange`
 *   - patches XRFrame `getPose`, `getJointPose`, `fillPoses` and
 *     `fillJointRadii` to answer for those synthetic spaces
 *   - turns a thumb-index pinch into `selectstart` / `select` / `selectend`
 *
 * Anything written against the standard WebXR Hand Input API (three.js,
 * IWSDK's hand visuals, grabbing and poke, your own `frame.getJointPose`
 * loops) then works unchanged, the same way it does with Meta Quest hand
 * tracking.
 */
import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import type { CameraHand, Side } from './hand-solver.js';
import { JOINT_RADII, XR_JOINTS } from './joints.js';
import type { HandMode } from './settings.js';

const SYN = Symbol('camera-hand-space');
type SpaceKind = 'joint' | 'grip' | 'ray';
interface SynInfo {
  hand: CameraHand;
  kind: SpaceKind;
  index: number;
}
type SynSpace = XRSpace & { [SYN]: SynInfo };

const isSyn = (s: unknown): s is SynSpace => !!s && typeof s === 'object' && SYN in (s as object);

/** The polyfill serving the current session (there is only ever one XR session). */
let active: XRHandPolyfill | null = null;

type FrameProto = {
  getPose(space: XRSpace, base: XRSpace): XRPose | null | undefined;
  getJointPose?(joint: XRJointSpace, base: XRSpace): XRJointPose | null | undefined;
  fillPoses?(spaces: Iterable<XRSpace>, base: XRSpace, out: Float32Array): boolean;
  fillJointRadii?(joints: Iterable<XRJointSpace>, out: Float32Array): boolean;
};
const PATCHED = Symbol('camera-hands-patched');
let origGetPose: FrameProto['getPose'];

function patchFrame(proto: FrameProto & { [PATCHED]?: boolean }): void {
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  const getPose = proto.getPose;
  const getJointPose = proto.getJointPose;
  const fillPoses = proto.fillPoses;
  const fillJointRadii = proto.fillJointRadii;
  origGetPose = getPose;

  proto.getPose = function (space, base) {
    if (active && (isSyn(space) || isSyn(base))) return active.getPose(this as unknown as XRFrame, space, base);
    return getPose.call(this, space, base);
  };
  proto.getJointPose = function (joint, base) {
    if (active && (isSyn(joint) || isSyn(base))) return active.getPose(this as unknown as XRFrame, joint, base, true) as XRJointPose | null;
    return getJointPose?.call(this, joint, base);
  };
  proto.fillPoses = function (spaces, base, out) {
    const list = Array.from(spaces);
    if (active && (isSyn(base) || list.some(isSyn))) return active.fillPoses(this as unknown as XRFrame, list, base, out);
    return fillPoses ? fillPoses.call(this, list, base, out) : false;
  };
  proto.fillJointRadii = function (joints, out) {
    const list = Array.from(joints);
    if (list.some(isSyn)) {
      list.forEach((j, i) => (out[i] = isSyn(j) ? JOINT_RADII[j[SYN].index] : 0.01));
      return true;
    }
    return fillJointRadii ? fillJointRadii.call(this, list, out) : false;
  };
}

/** Find the native getter for `inputSources` somewhere up the prototype chain. */
function nativeInputSourcesGetter(session: XRSession): () => XRInputSourceArray {
  let p: object | null = Object.getPrototypeOf(session);
  while (p) {
    const d = Object.getOwnPropertyDescriptor(p, 'inputSources');
    if (d?.get) return d.get as () => XRInputSourceArray;
    p = Object.getPrototypeOf(p);
  }
  return () => [] as unknown as XRInputSourceArray;
}

interface SynSource {
  side: Side;
  source: XRInputSource;
  hand: CameraHand;
  presented: boolean;
  pinching: boolean;
  /** Auto mode: the camera hand is far from the native controller, so it isn't holding it. */
  overriding: boolean;
}

export interface PolyfillOptions {
  hands: Record<Side, CameraHand>;
  getMode(): HandMode;
  /** Called every XR frame with the viewer pose in the polyfill's anchor space. */
  onViewerPose(timeMs: number, viewer: Matrix4): void;
  onChange?(presented: Record<Side, boolean>): void;
}

export class XRHandPolyfill {
  readonly session: XRSession;
  /** The reference space hand joints are solved in. */
  anchor: XRReferenceSpace | null = null;
  private readonly nativeSources: () => XRInputSourceArray;
  private syn: Record<Side, SynSource>;
  private raf = 0;
  private stopped = false;
  private frameCache = new Map<XRSpace, Matrix4 | null>();
  private cachedFrame: XRFrame | null = null;
  private hidden = new Set<XRInputSource>();
  private merged: XRInputSource[] = [];

  // scratch
  private mA = new Matrix4();
  private mB = new Matrix4();
  private mInv = new Matrix4();
  private viewer = new Matrix4();
  private p = new Vector3();
  private q = new Quaternion();
  private s = new Vector3();
  private p2 = new Vector3();

  constructor(session: XRSession, private opts: PolyfillOptions) {
    this.session = session;
    this.nativeSources = nativeInputSourcesGetter(session).bind(session);
    this.syn = {
      left: this.makeSource('left', opts.hands.left),
      right: this.makeSource('right', opts.hands.right),
    };
  }

  async start(): Promise<void> {
    const session = this.session;
    try {
      this.anchor = await session.requestReferenceSpace('local-floor');
    } catch {
      this.anchor = await session.requestReferenceSpace('local');
    }
    if (this.stopped) return;
    active = this;
    Object.defineProperty(session, 'inputSources', {
      configurable: true,
      get: () => this.currentSources(),
    });
    session.addEventListener('end', () => this.stop(), { once: true });
    const loop = (_t: number, frame: XRFrame) => {
      if (this.stopped) return;
      this.raf = session.requestAnimationFrame(loop);
      this.tick(frame);
    };
    this.raf = session.requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.session.cancelAnimationFrame(this.raf);
    } catch {
      // session already ended
    }
    delete (this.session as unknown as Record<string, unknown>).inputSources;
    if (active === this) active = null;
  }

  /** Is a camera hand currently presented for this side? */
  presented(side: Side): boolean {
    return this.syn[side].presented;
  }

  // ---------------------------------------------------------------- per frame

  private tick(frame: XRFrame): void {
    patchFrame(Object.getPrototypeOf(frame));
    this.beginFrame(frame);
    const anchor = this.anchor!;
    const vp = frame.getViewerPose(anchor);
    if (vp) {
      this.viewer.fromArray(vp.transform.matrix);
      this.opts.onViewerPose(performance.now(), this.viewer);
    }
    this.updatePresence(frame);
  }

  private beginFrame(frame: XRFrame): void {
    if (this.cachedFrame !== frame) {
      this.cachedFrame = frame;
      this.frameCache.clear();
    }
  }

  private updatePresence(frame: XRFrame): void {
    const mode = this.opts.getMode();
    const now = performance.now();
    const native = Array.from(this.nativeSources());
    const added: XRInputSource[] = [];
    const removed: XRInputSource[] = [];
    const changed: Record<Side, boolean> = { left: false, right: false };

    for (const side of ['left', 'right'] as const) {
      const syn = this.syn[side];
      const tracked = mode !== 'off' && syn.hand.isTracked(now);
      const nativeSame = native.filter((s) => s.handedness === side);
      let show = tracked;
      if (tracked && mode === 'auto' && nativeSame.length) {
        // Is the camera hand holding that controller? If it's close, the controller wins.
        const d = this.distanceToNative(frame, syn.hand, nativeSame);
        syn.overriding = d === null ? true : syn.overriding ? d > 0.1 : d > 0.15;
        show = syn.overriding;
      }
      if (show !== syn.presented) {
        syn.presented = show;
        changed[side] = true;
        if (show) added.push(syn.source);
        else {
          if (syn.pinching) this.fireSelect(syn, false, frame);
          removed.push(syn.source);
        }
      }
    }

    // Which native sources to hide.
    const hide = new Set<XRInputSource>();
    for (const src of native) {
      const side = src.handedness as Side;
      if (side !== 'left' && side !== 'right') continue;
      if (mode === 'replace' && src.hand) hide.add(src);
      if (this.syn[side].presented) hide.add(src);
    }
    for (const src of hide) if (!this.hidden.has(src)) removed.push(src);
    for (const src of this.hidden) if (!hide.has(src) && native.includes(src)) added.push(src);
    this.hidden = hide;

    this.merged = native.filter((s) => !hide.has(s));
    for (const side of ['left', 'right'] as const) if (this.syn[side].presented) this.merged.push(this.syn[side].source);

    if (added.length || removed.length) {
      const ev = new Event('inputsourceschange');
      Object.defineProperties(ev, {
        session: { value: this.session },
        added: { value: added },
        removed: { value: removed },
      });
      this.session.dispatchEvent(ev);
    }
    if (changed.left || changed.right) this.opts.onChange?.({ left: this.syn.left.presented, right: this.syn.right.presented });

    // Pinch -> select events.
    for (const side of ['left', 'right'] as const) {
      const syn = this.syn[side];
      if (syn.presented && syn.hand.pinching !== syn.pinching) this.fireSelect(syn, syn.hand.pinching, frame);
    }
  }

  private distanceToNative(frame: XRFrame, hand: CameraHand, sources: XRInputSource[]): number | null {
    let best: number | null = null;
    this.p2.set(hand.grip.elements[12], hand.grip.elements[13], hand.grip.elements[14]);
    for (const src of sources) {
      const m = this.nativeMatrix(frame, src.gripSpace ?? src.targetRaySpace);
      if (!m) continue;
      const d = this.p.setFromMatrixPosition(m).distanceTo(this.p2);
      best = best === null ? d : Math.min(best, d);
    }
    return best;
  }

  private fireSelect(syn: SynSource, down: boolean, frame: XRFrame): void {
    syn.pinching = down;
    const fire = (type: string) => {
      const ev = new Event(type);
      Object.defineProperties(ev, { frame: { value: frame }, inputSource: { value: syn.source } });
      this.session.dispatchEvent(ev);
    };
    if (down) fire('selectstart');
    else {
      fire('select');
      fire('selectend');
    }
  }

  private currentSources(): XRInputSourceArray {
    // Before the first frame (or if mode is off) just show the native list.
    if (!this.cachedFrame) return this.nativeSources();
    // Keep native additions that appeared since the last tick.
    const native = this.nativeSources();
    for (const s of native) if (!this.hidden.has(s) && !this.merged.includes(s)) this.merged.unshift(s);
    return this.merged as unknown as XRInputSourceArray;
  }

  // ---------------------------------------------------------------- poses

  /** Pose of `space` in the anchor space, or null if unknown. */
  private matrixOf(frame: XRFrame, space: XRSpace, out: Matrix4): Matrix4 | null {
    if (isSyn(space)) {
      const { hand, kind, index } = space[SYN];
      if (!hand.isTracked(performance.now(), 500)) return null;
      if (kind === 'joint') return out.fromArray(hand.joints, index * 16);
      return out.copy(kind === 'grip' ? hand.grip : hand.ray);
    }
    const m = this.nativeMatrix(frame, space);
    return m ? out.copy(m) : null;
  }

  private nativeMatrix(frame: XRFrame, space: XRSpace): Matrix4 | null {
    this.beginFrame(frame);
    if (this.frameCache.has(space)) return this.frameCache.get(space)!;
    const pose = this.anchor ? origGetPose.call(frame, space, this.anchor) : null;
    const m = pose ? new Matrix4().fromArray(pose.transform.matrix) : null;
    this.frameCache.set(space, m);
    return m;
  }

  /** Relative transform space-in-base, into `out`. */
  private relative(frame: XRFrame, space: XRSpace, base: XRSpace, out: Matrix4): Matrix4 | null {
    const a = this.matrixOf(frame, space, this.mA);
    const b = a && this.matrixOf(frame, base, this.mB);
    if (!a || !b) return null;
    return out.multiplyMatrices(this.mInv.copy(b).invert(), a);
  }

  getPose(frame: XRFrame, space: XRSpace, base: XRSpace, joint = false): XRPose | null {
    const m = this.relative(frame, space, base, this.mA);
    if (!m) return null;
    m.decompose(this.p, this.q, this.s);
    const transform = new XRRigidTransform(
      { x: this.p.x, y: this.p.y, z: this.p.z, w: 1 },
      { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w },
    );
    const pose: Record<string, unknown> = { transform, emulatedPosition: false };
    if (joint) pose.radius = isSyn(space) ? JOINT_RADII[space[SYN].index] : 0.01;
    return pose as unknown as XRPose;
  }

  fillPoses(frame: XRFrame, spaces: XRSpace[], base: XRSpace, out: Float32Array): boolean {
    const b = this.matrixOf(frame, base, this.mB);
    if (!b) return false;
    this.mInv.copy(b).invert();
    for (let i = 0; i < spaces.length; i++) {
      const a = this.matrixOf(frame, spaces[i], this.mA);
      if (!a) return false;
      this.mA.premultiply(this.mInv).toArray(out, i * 16);
    }
    return true;
  }

  // ---------------------------------------------------------------- objects

  private makeSource(side: Side, hand: CameraHand): SynSource {
    const g = globalThis as unknown as Record<string, { prototype: object } | undefined>;
    const space = (kind: SpaceKind, index: number, proto?: object) => {
      const o = Object.create(proto ?? g.XRSpace?.prototype ?? Object.prototype) as SynSpace;
      Object.defineProperty(o, SYN, { value: { hand, kind, index } });
      return o;
    };
    // A real Map has everything XRHand has (get, size, keys, values, entries, forEach, iterator).
    const xrHand = new Map<XRHandJoint, XRJointSpace>();
    XR_JOINTS.forEach((name, i) => {
      const j = space('joint', i, g.XRJointSpace?.prototype);
      Object.defineProperty(j, 'jointName', { value: name, enumerable: true });
      xrHand.set(name, j as unknown as XRJointSpace);
    });
    const source = Object.create(g.XRInputSource?.prototype ?? Object.prototype) as XRInputSource;
    const props: Record<string, unknown> = {
      handedness: side,
      targetRayMode: 'tracked-pointer',
      targetRaySpace: space('ray', -1),
      gripSpace: space('grip', -1),
      hand: xrHand,
      gamepad: undefined,
      profiles: ['generic-hand-select', 'generic-hand'],
      skipRendering: false,
      cameraHand: true,
    };
    for (const [k, value] of Object.entries(props)) Object.defineProperty(source, k, { value, enumerable: true });
    return { side, source, hand, presented: false, pinching: false, overriding: false };
  }
}
