/**
 * MediaPipe's 21 hand landmarks -> the 25 WebXR hand joints (with orientations).
 *
 * Everything here is pure math on Float32Arrays so it can be unit tested and
 * reused for any 3D space (camera, viewer or reference space).
 *
 * WebXR joint frame convention (https://www.w3.org/TR/webxr-hand-input-1/):
 *   -Z points along the bone, away from the wrist (towards the fingertip)
 *   +Y points out of the back of the hand (away from the palm)
 */

export const XR_JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const satisfies readonly XRHandJoint[];

export type XRJointName = (typeof XR_JOINTS)[number];
export const JOINT_COUNT = XR_JOINTS.length; // 25
export const LANDMARK_COUNT = 21;

/** MediaPipe landmark indices. */
export const MP = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/**
 * Where each XR joint comes from: a landmark index, or a blend
 * [a, b, t] = lerp(landmark a, landmark b, t). Finger metacarpal joints sit at
 * the base of the palm, which MediaPipe doesn't track, so they are placed a
 * little way up from the wrist towards each knuckle.
 */
type Source = number | [number, number, number];
const META = 0.22;
export const JOINT_SOURCES: readonly Source[] = [
  MP.WRIST,
  MP.THUMB_CMC,
  MP.THUMB_MCP,
  MP.THUMB_IP,
  MP.THUMB_TIP,
  [MP.WRIST, MP.INDEX_MCP, META],
  MP.INDEX_MCP,
  MP.INDEX_PIP,
  MP.INDEX_DIP,
  MP.INDEX_TIP,
  [MP.WRIST, MP.MIDDLE_MCP, META],
  MP.MIDDLE_MCP,
  MP.MIDDLE_PIP,
  MP.MIDDLE_DIP,
  MP.MIDDLE_TIP,
  [MP.WRIST, MP.RING_MCP, META],
  MP.RING_MCP,
  MP.RING_PIP,
  MP.RING_DIP,
  MP.RING_TIP,
  [MP.WRIST, MP.PINKY_MCP, META],
  MP.PINKY_MCP,
  MP.PINKY_PIP,
  MP.PINKY_DIP,
  MP.PINKY_TIP,
];

/** Joint the bone points towards (-Z). -1 = tip: reuse the parent bone. */
const CHILD: readonly number[] = [
  -2, // wrist: special (towards middle knuckle)
  2, 3, 4, -1,
  6, 7, 8, 9, -1,
  11, 12, 13, 14, -1,
  16, 17, 18, 19, -1,
  21, 22, 23, 24, -1,
];

/** Typical joint radii (m), close to what Quest reports. */
export const JOINT_RADII = new Float32Array([
  0.021, // wrist
  0.019, 0.015, 0.013, 0.011, // thumb
  0.021, 0.011, 0.009, 0.008, 0.007, // index
  0.021, 0.011, 0.009, 0.008, 0.007, // middle
  0.019, 0.010, 0.008, 0.007, 0.006, // ring
  0.018, 0.009, 0.007, 0.006, 0.005, // pinky
]);

/** Expand 21 landmarks (xyz triplets) into 25 joint positions (xyz triplets). */
export function landmarksToJointPositions(lm: ArrayLike<number>, out: Float32Array = new Float32Array(JOINT_COUNT * 3)): Float32Array {
  for (let j = 0; j < JOINT_COUNT; j++) {
    const s = JOINT_SOURCES[j];
    if (typeof s === 'number') {
      out[j * 3] = lm[s * 3];
      out[j * 3 + 1] = lm[s * 3 + 1];
      out[j * 3 + 2] = lm[s * 3 + 2];
    } else {
      const [a, b, t] = s;
      for (let k = 0; k < 3; k++) out[j * 3 + k] = lm[a * 3 + k] + (lm[b * 3 + k] - lm[a * 3 + k]) * t;
    }
  }
  return out;
}

// --- small vector helpers on plain tuples (no allocation in the hot loop) ---
type V = [number, number, number];
const sub = (o: V, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): V => {
  o[0] = a[ai] - b[bi];
  o[1] = a[ai + 1] - b[bi + 1];
  o[2] = a[ai + 2] - b[bi + 2];
  return o;
};
const cross = (o: V, a: V, b: V): V => {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
const norm = (o: V, fallback?: V): V => {
  const l = Math.hypot(o[0], o[1], o[2]);
  if (l < 1e-9) {
    if (fallback) {
      o[0] = fallback[0];
      o[1] = fallback[1];
      o[2] = fallback[2];
    }
    return o;
  }
  o[0] /= l;
  o[1] /= l;
  o[2] /= l;
  return o;
};

const tA: V = [0, 0, 0];
const tB: V = [0, 0, 0];
const dorsal: V = [0, 0, 0];
const radial: V = [0, 0, 0];
const thumbUp: V = [0, 0, 0];
const zAx: V = [0, 0, 0];
const xAx: V = [0, 0, 0];
const yAx: V = [0, 0, 0];

/**
 * Unit vector out of the back of the hand, from wrist + index and pinky knuckles
 * (positions as 25-joint xyz triplets, right-handed space).
 */
export function backOfHand(p: ArrayLike<number>, handedness: 'left' | 'right', out: V = [0, 0, 0]): V {
  const W = 0;
  const I = 6 * 3; // index proximal (knuckle)
  const P = 21 * 3; // pinky proximal
  sub(tA, p, I, p, W);
  sub(tB, p, P, p, W);
  // (index - wrist) x (pinky - wrist) points into the palm for a right hand.
  cross(out, tA, tB);
  if (handedness === 'right') {
    out[0] = -out[0];
    out[1] = -out[1];
    out[2] = -out[2];
  }
  return norm(out, [0, 1, 0]);
}

/**
 * Build 25 column-major 4x4 joint matrices from 25 joint positions.
 * @param pos 25 xyz triplets
 * @param out 25 * 16 floats
 */
export function buildJointMatrices(pos: ArrayLike<number>, handedness: 'left' | 'right', out: Float32Array = new Float32Array(JOINT_COUNT * 16)): Float32Array {
  backOfHand(pos, handedness, dorsal);
  // Towards the thumb side: index knuckle - pinky knuckle.
  sub(radial, pos, 6 * 3, pos, 21 * 3);
  norm(radial, [1, 0, 0]);
  // The thumbnail faces roughly half way between the back of the hand and the thumb side.
  thumbUp[0] = dorsal[0] + radial[0];
  thumbUp[1] = dorsal[1] + radial[1];
  thumbUp[2] = dorsal[2] + radial[2];
  norm(thumbUp, dorsal);

  for (let j = 0; j < JOINT_COUNT; j++) {
    const c = CHILD[j];
    if (c === -2) {
      // Wrist: -Z towards the middle knuckle.
      sub(zAx, pos, 0, pos, 11 * 3);
    } else if (c === -1) {
      // Tip: continue the last bone.
      sub(zAx, pos, (j - 1) * 3, pos, j * 3);
    } else {
      sub(zAx, pos, j * 3, pos, c * 3);
    }
    norm(zAx, [0, 0, 1]);
    const up = j >= 1 && j <= 4 ? thumbUp : dorsal;
    // x = up x z, then re-orthogonalise y = z x x.
    cross(xAx, up, zAx);
    if (Math.hypot(xAx[0], xAx[1], xAx[2]) < 1e-6) {
      // Bone parallel to "up" (very curled finger): pick any perpendicular.
      cross(xAx, radial, zAx);
    }
    norm(xAx, [1, 0, 0]);
    cross(yAx, zAx, xAx);
    const o = j * 16;
    out[o] = xAx[0];
    out[o + 1] = xAx[1];
    out[o + 2] = xAx[2];
    out[o + 3] = 0;
    out[o + 4] = yAx[0];
    out[o + 5] = yAx[1];
    out[o + 6] = yAx[2];
    out[o + 7] = 0;
    out[o + 8] = zAx[0];
    out[o + 9] = zAx[1];
    out[o + 10] = zAx[2];
    out[o + 11] = 0;
    out[o + 12] = pos[j * 3];
    out[o + 13] = pos[j * 3 + 1];
    out[o + 14] = pos[j * 3 + 2];
    out[o + 15] = 1;
  }
  return out;
}

/** Distance between two of the 25 joints. */
export function jointDistance(pos: ArrayLike<number>, a: number, b: number): number {
  return Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
}

export const J = Object.fromEntries(XR_JOINTS.map((n, i) => [n, i])) as Record<XRJointName, number>;

/** Thumb-index pinch, normalised by palm length so it works at any hand size or depth error. */
export function pinchRatio(pos: ArrayLike<number>): number {
  const palm = jointDistance(pos, J.wrist, J['middle-finger-phalanx-proximal']);
  return jointDistance(pos, J['thumb-tip'], J['index-finger-tip']) / Math.max(palm, 1e-4);
}
