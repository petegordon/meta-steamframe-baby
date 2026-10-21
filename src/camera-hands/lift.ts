/**
 * Lifting a 2D hand detection into camera space.
 *
 * MediaPipe gives two things per hand:
 *   - `landmarks`: where each point is in the image (normalised 0..1)
 *   - `worldLandmarks`: the hand's metric 3D shape (meters, centred on the hand)
 *
 * The shape is right but its position isn't. We find the translation T that
 * makes the shape line up with the image (a tiny linear least-squares
 * "perspective-n-point" with rotation already known):
 *
 *   u_i = (W_i.x + T.x) / (W_i.z + T.z),   v_i = (W_i.y + T.y) / (W_i.z + T.z)
 *
 * which rearranges to two linear equations per landmark in T.
 * Coordinates here use the computer-vision convention (x right, y down,
 * z forward); `toThree` flips into three.js camera space (y up, -z forward).
 */

export interface Intrinsics {
  /** Focal length in pixels. */
  fx: number;
  fy: number;
  /** Principal point in pixels. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Pinhole intrinsics from a horizontal field of view. */
export function intrinsicsFromFov(width: number, height: number, hfovDeg: number): Intrinsics {
  const fx = width / 2 / Math.tan(((hfovDeg * Math.PI) / 180) / 2);
  return { fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Solve the hand's translation. Returns null when the geometry is degenerate
 * or puts the hand behind / implausibly close to the camera.
 *
 * @param image normalised image landmarks (x, y in 0..1)
 * @param world metric hand shape (meters), same order
 * @param scale multiply the shape by this (bigger hands than MediaPipe's model -> > 1)
 */
export function solveTranslation(image: ArrayLike<Pt3>, world: ArrayLike<Pt3>, K: Intrinsics, scale = 1): Pt3 | null {
  // Normal equations A^T A t = A^T b, accumulated directly.
  let a00 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  const n = Math.min(image.length, world.length);
  if (n < 3) return null;
  for (let i = 0; i < n; i++) {
    const u = (image[i].x * K.width - K.cx) / K.fx;
    const v = (image[i].y * K.height - K.cy) / K.fy;
    const wx = world[i].x * scale;
    const wy = world[i].y * scale;
    const wz = world[i].z * scale;
    // row 1: [1, 0, -u] . t = u*wz - wx
    const r1 = u * wz - wx;
    a00 += 1;
    a02 += -u;
    a22 += u * u;
    b0 += r1;
    b2 += -u * r1;
    // row 2: [0, 1, -v] . t = v*wz - wy
    const r2 = v * wz - wy;
    a11 += 1;
    a12 += -v;
    a22 += v * v;
    b1 += r2;
    b2 += -v * r2;
  }
  const t = solve3([a00, 0, a02, 0, a11, a12, a02, a12, a22], [b0, b1, b2]);
  if (!t) return null;
  const [tx, ty, tz] = t;
  if (tz < 0.05 || tz > 3) return null;
  return { x: tx, y: ty, z: tz };
}

/** Solve M x = b for a row-major 3x3 M (Cramer's rule). */
export function solve3(m: readonly number[], b: readonly number[]): [number, number, number] | null {
  const det3 = (a: readonly number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const col = (c: number) => m.map((v, i) => (i % 3 === c ? b[Math.floor(i / 3)] : v));
  const x: [number, number, number] = [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Full lift: 21 landmarks -> 21 xyz triplets in three.js camera space
 * (x right, y up, camera looks down -z). Returns false if it can't be solved.
 */
export function liftToCamera(image: ArrayLike<Pt3>, world: ArrayLike<Pt3>, K: Intrinsics, scale: number, out: Float32Array): boolean {
  const t = solveTranslation(image, world, K, scale);
  if (!t) return false;
  const n = Math.min(world.length, out.length / 3);
  for (let i = 0; i < n; i++) {
    const x = world[i].x * scale + t.x;
    const y = world[i].y * scale + t.y;
    const z = world[i].z * scale + t.z;
    out[i * 3] = x;
    out[i * 3 + 1] = -y;
    out[i * 3 + 2] = -z;
  }
  return true;
}
