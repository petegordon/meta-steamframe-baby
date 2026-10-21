import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { JOINT_COUNT, LANDMARK_COUNT, J, buildJointMatrices, landmarksToJointPositions, pinchRatio } from './joints.js';
import { intrinsicsFromFov, liftToCamera } from './lift.js';
import { OneEuroArray } from './one-euro.js';
import type { PoseHistory } from './pose-history.js';
import type { CameraHandSettings } from './settings.js';
import type { Observation, RawHand } from './tracker-protocol.js';

export type Side = 'left' | 'right';

/** One tracked hand, in whatever space the head poses were given in (the "anchor" space). */
export class CameraHand {
  readonly handedness: Side;
  /** 25 column-major joint matrices (WebXR joint order). */
  readonly joints = new Float32Array(JOINT_COUNT * 16);
  /** 25 joint positions. */
  readonly positions = new Float32Array(JOINT_COUNT * 3);
  /** Grip (palm) and target-ray poses, like a Quest hand input source. */
  readonly grip = new Matrix4();
  readonly ray = new Matrix4();
  /** Raw 21 landmarks in the image (for the preview overlay). */
  readonly image = new Float32Array(LANDMARK_COUNT * 2);
  /** performance.now() of the camera frame these came from; 0 = never. */
  seenAt = 0;
  score = 0;
  pinching = false;
  pinch = 1;
  readonly filter: OneEuroArray;

  constructor(handedness: Side, s: CameraHandSettings) {
    this.handedness = handedness;
    this.filter = new OneEuroArray(LANDMARK_COUNT * 3, s.minCutoff, s.beta);
  }

  /** Tracked recently enough to show. */
  isTracked(now: number, timeoutMs = 300): boolean {
    return this.seenAt > 0 && now - this.seenAt < timeoutMs;
  }
}

/**
 * Turns MediaPipe observations into world-anchored 3D hands.
 *
 *   camera-space (lift) -> head-space (camera extrinsics) -> anchor space
 *   (head pose at capture time) -> smoothed -> 25 WebXR joints.
 */
export class HandSolver {
  readonly hands: Record<Side, CameraHand>;
  private extrinsics = new Matrix4();
  private headAt = new Matrix4();
  private camToAnchor = new Matrix4();
  private lm = new Float32Array(LANDMARK_COUNT * 3);
  private v = new Vector3();
  private v2 = new Vector3();
  private q = new Quaternion();
  private e = new Euler();
  private one = new Vector3(1, 1, 1);

  constructor(private settings: CameraHandSettings) {
    this.hands = { left: new CameraHand('left', settings), right: new CameraHand('right', settings) };
    this.applySettings(settings);
  }

  applySettings(s: CameraHandSettings): void {
    this.settings = s;
    const [p, y, r] = s.camRotDeg;
    this.e.set(MathUtils.degToRad(p), MathUtils.degToRad(y), MathUtils.degToRad(r), 'YXZ');
    this.q.setFromEuler(this.e);
    this.extrinsics.compose(this.v.fromArray(s.camPos), this.q, this.one);
    for (const h of Object.values(this.hands)) {
      h.filter.minCutoff = s.minCutoff;
      h.filter.beta = s.beta;
    }
  }

  reset(): void {
    for (const h of Object.values(this.hands)) {
      h.seenAt = 0;
      h.filter.reset();
      h.pinching = false;
    }
  }

  /** Which physical hand MediaPipe's label refers to. */
  sideOf(raw: RawHand): Side {
    const right = raw.label === 'Right';
    return right !== this.settings.swapHandedness ? 'right' : 'left';
  }

  /** @returns true if any hand was updated */
  solve(obs: Observation, history: PoseHistory): boolean {
    const s = this.settings;
    if (!obs.width || !history.sample(obs.t - s.latencyMs, this.headAt)) return false;
    this.camToAnchor.multiplyMatrices(this.headAt, this.extrinsics);
    const K = intrinsicsFromFov(obs.width, obs.height, s.hfovDeg);

    // Best detection per side (MediaPipe sometimes labels both hands the same).
    const best: Partial<Record<Side, RawHand>> = {};
    for (const raw of obs.hands) {
      if (raw.score < s.minScore || raw.world.length < LANDMARK_COUNT) continue;
      const side = this.sideOf(raw);
      if (!best[side] || best[side]!.score < raw.score) best[side] = raw;
    }

    let any = false;
    for (const side of ['left', 'right'] as const) {
      const raw = best[side];
      if (!raw) continue;
      const hand = this.hands[side];
      if (!liftToCamera(raw.image, raw.world, K, s.handScale, this.lm)) continue;
      for (let i = 0; i < LANDMARK_COUNT; i++) {
        this.v.fromArray(this.lm, i * 3).applyMatrix4(this.camToAnchor).toArray(this.lm, i * 3);
        hand.image[i * 2] = raw.image[i].x;
        hand.image[i * 2 + 1] = raw.image[i].y;
      }
      hand.filter.filter(this.lm, obs.t / 1000);
      landmarksToJointPositions(this.lm, hand.positions);
      buildJointMatrices(hand.positions, side, hand.joints);
      this.updateGripAndRay(hand);
      hand.pinch = pinchRatio(hand.positions);
      hand.pinching = hand.pinching ? hand.pinch < s.pinchEnd : hand.pinch < s.pinchStart;
      hand.score = raw.score;
      hand.seenAt = obs.t;
      any = true;
    }
    return any;
  }

  /**
   * Grip: palm centre, oriented like the wrist joint.
   * Target ray: from between the thumb and index knuckles, pointing away
   * from an estimated shoulder (roughly what Quest does for hands).
   */
  private updateGripAndRay(hand: CameraHand): void {
    const p = hand.positions;
    const m = hand.joints;
    // Grip = wrist rotation, positioned between the wrist and middle knuckle.
    hand.grip.fromArray(m, J.wrist * 16);
    this.v.fromArray(p, J.wrist * 3).lerp(this.v2.fromArray(p, J['middle-finger-phalanx-proximal'] * 3), 0.5);
    hand.grip.setPosition(this.v);

    // Ray origin.
    const origin = this.v.fromArray(p, J['index-finger-phalanx-proximal'] * 3).lerp(this.v2.fromArray(p, J['thumb-phalanx-proximal'] * 3), 0.5);
    // Shoulder: below and to the side of the head (head pose from capture time).
    const shoulder = this.v2.set(hand.handedness === 'right' ? 0.18 : -0.18, -0.32, 0.05).applyMatrix4(this.headAt);
    const dir = shoulder.subVectors(origin, shoulder).normalize(); // reuses v2
    const up = this.headUp.set(0, 1, 0);
    // Matrix4.lookAt sets +Z = eye - target, so eye=0, target=dir gives -Z along dir.
    this.rayBasis.lookAt(this.zero, dir, up);
    hand.ray.copy(this.rayBasis).setPosition(origin);
  }
  private headUp = new Vector3();
  private zero = new Vector3();
  private rayBasis = new Matrix4();
}
