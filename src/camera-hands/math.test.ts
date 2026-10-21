import { describe, expect, it } from 'vitest';
import { J, JOINT_COUNT, buildJointMatrices, landmarksToJointPositions, pinchRatio } from './joints.js';
import { intrinsicsFromFov, liftToCamera, solve3, solveTranslation, type Pt3 } from './lift.js';
import { OneEuroArray } from './one-euro.js';

/** A rough right hand (meters), palm facing the camera-ish, CV axes (x right, y down, z away). */
function sampleWorld(): Pt3[] {
  const pts: Pt3[] = [];
  const wrist = { x: 0, y: 0.06, z: 0 };
  pts.push(wrist);
  // thumb
  for (let i = 1; i <= 4; i++) pts.push({ x: -0.02 - i * 0.015, y: 0.05 - i * 0.015, z: -0.005 * i });
  // fingers
  const xs = [-0.025, -0.005, 0.015, 0.033];
  for (const x of xs) for (let k = 0; k < 4; k++) pts.push({ x, y: -0.0 - k * 0.025, z: 0.002 * k });
  return pts;
}

function project(world: Pt3[], t: Pt3, K: ReturnType<typeof intrinsicsFromFov>): Pt3[] {
  return world.map((p) => {
    const X = p.x + t.x;
    const Y = p.y + t.y;
    const Z = p.z + t.z;
    return { x: (K.fx * (X / Z) + K.cx) / K.width, y: (K.fy * (Y / Z) + K.cy) / K.height, z: 0 };
  });
}

describe('lift', () => {
  it('solve3 solves a linear system', () => {
    const x = solve3([2, 1, 0, 1, 3, 1, 0, 1, 4], [3, 5, 5]);
    expect(x).not.toBeNull();
    const [a, b, c] = x!;
    expect(2 * a + b).toBeCloseTo(3);
    expect(a + 3 * b + c).toBeCloseTo(5);
    expect(b + 4 * c).toBeCloseTo(5);
  });

  it('recovers the hand translation from its projection', () => {
    const K = intrinsicsFromFov(640, 480, 90);
    const world = sampleWorld();
    const T = { x: 0.08, y: 0.12, z: 0.42 };
    const image = project(world, T, K);
    const t = solveTranslation(image, world, K)!;
    expect(t.x).toBeCloseTo(T.x, 4);
    expect(t.y).toBeCloseTo(T.y, 4);
    expect(t.z).toBeCloseTo(T.z, 4);
  });

  it('a bigger hand scale puts the hand proportionally further away', () => {
    const K = intrinsicsFromFov(640, 480, 90);
    const world = sampleWorld();
    const image = project(world, { x: 0, y: 0, z: 0.4 }, K);
    expect(solveTranslation(image, world, K, 1.2)!.z).toBeCloseTo(0.48, 3);
  });

  it('liftToCamera converts to three.js axes (y up, -z forward)', () => {
    const K = intrinsicsFromFov(640, 480, 90);
    const world = sampleWorld();
    const image = project(world, { x: 0, y: 0, z: 0.5 }, K);
    const out = new Float32Array(63);
    expect(liftToCamera(image, world, K, 1, out)).toBe(true);
    // wrist is at CV y=+0.06 (below centre) -> three y = -0.06; in front -> negative z.
    expect(out[1]).toBeCloseTo(-0.06, 3);
    expect(out[2]).toBeCloseTo(-0.5, 3);
  });

  it('rejects a solution behind the camera', () => {
    const K = intrinsicsFromFov(640, 480, 90);
    const world = sampleWorld();
    const image = project(world, { x: 0, y: 0, z: -0.5 }, K);
    expect(solveTranslation(image, world, K)).toBeNull();
  });
});

/** Right hand, palm down, fingers pointing -z (forward), three.js axes. */
function palmDownRight(): Float32Array {
  const lm = new Float32Array(63);
  const set = (i: number, x: number, y: number, z: number) => lm.set([x, y, z], i * 3);
  set(0, 0, 0, 0);
  for (let k = 1; k <= 4; k++) set(k, -0.03 - k * 0.012, 0, -0.02 - k * 0.015); // thumb on the left for a right hand
  const xs = [-0.025, 0, 0.022, 0.04];
  xs.forEach((x, f) => {
    for (let k = 0; k < 4; k++) set(5 + f * 4 + k, x, 0, -0.09 - k * 0.025);
  });
  return lm;
}

describe('joints', () => {
  it('maps 21 landmarks to 25 joints', () => {
    const pos = landmarksToJointPositions(palmDownRight());
    expect(pos.length).toBe(JOINT_COUNT * 3);
    // index proximal = MediaPipe INDEX_MCP
    expect(pos[J['index-finger-phalanx-proximal'] * 3 + 2]).toBeCloseTo(-0.09);
    // metacarpal sits between wrist and knuckle
    const mz = pos[J['index-finger-metacarpal'] * 3 + 2];
    expect(mz).toBeLessThan(0);
    expect(mz).toBeGreaterThan(-0.09);
  });

  it('builds WebXR joint frames: -Z along the bone, +Y out of the back of the hand', () => {
    const pos = landmarksToJointPositions(palmDownRight());
    const m = buildJointMatrices(pos, 'right');
    for (const j of [J.wrist, J['index-finger-phalanx-proximal'], J['middle-finger-tip']]) {
      const o = j * 16;
      const y = [m[o + 4], m[o + 5], m[o + 6]];
      const z = [m[o + 8], m[o + 9], m[o + 10]];
      expect(y[1]).toBeGreaterThan(0.95); // back of a palm-down hand faces up
      expect(z[2]).toBeGreaterThan(0.95); // +Z points back towards the wrist
    }
    // Orthonormal
    const o = J['ring-finger-phalanx-intermediate'] * 16;
    const x = [m[o], m[o + 1], m[o + 2]];
    const y = [m[o + 4], m[o + 5], m[o + 6]];
    expect(Math.hypot(...x)).toBeCloseTo(1, 5);
    expect(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]).toBeCloseTo(0, 5);
  });

  it('measures pinch relative to palm size', () => {
    const lm = palmDownRight();
    const open = pinchRatio(landmarksToJointPositions(lm));
    // Touch the thumb tip to the index tip.
    lm.set(lm.subarray(8 * 3, 8 * 3 + 3), 4 * 3);
    const closed = pinchRatio(landmarksToJointPositions(lm));
    expect(open).toBeGreaterThan(0.4);
    expect(closed).toBeLessThan(0.01);
  });
});

describe('OneEuroArray', () => {
  it('passes a constant through and smooths a jump', () => {
    const f = new OneEuroArray(1, 1, 0);
    const v = new Float32Array([1]);
    f.filter(v, 0);
    expect(v[0]).toBe(1);
    v[0] = 2;
    f.filter(v, 1 / 30);
    expect(v[0]).toBeGreaterThan(1);
    expect(v[0]).toBeLessThan(2);
  });
});
