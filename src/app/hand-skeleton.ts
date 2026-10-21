import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { JOINT_COUNT } from '../camera-hands/joints.js';

/** Parent of each of the 25 WebXR joints (for drawing bones). */
const PARENT = [-1, 0, 1, 2, 3, 0, 5, 6, 7, 8, 0, 10, 11, 12, 13, 0, 15, 16, 17, 18, 0, 20, 21, 22, 23];
const COLORS = { left: new Color(0x55c8ff), right: new Color(0xffa64d) };

/**
 * A simple joints-and-bones hand, so you can see exactly what the tracker
 * produces (IWSDK draws its own skinned hand on top in XR).
 */
export class HandSkeleton {
  readonly root = new Group();
  private spheres: InstancedMesh;
  private lines: LineSegments;
  private linePos: Float32Array;
  private m = new Matrix4();
  private v = new Vector3();

  constructor(readonly side: 'left' | 'right') {
    this.root.name = `HandSkeleton-${side}`;
    const mat = new MeshStandardMaterial({ color: COLORS[side], roughness: 0.4, emissive: COLORS[side], emissiveIntensity: 0.25 });
    this.spheres = new InstancedMesh(new SphereGeometry(1, 10, 8), mat, JOINT_COUNT);
    this.spheres.frustumCulled = false;
    this.linePos = new Float32Array(JOINT_COUNT * 2 * 3);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.linePos, 3));
    this.lines = new LineSegments(geo, new LineBasicMaterial({ color: COLORS[side] }));
    this.lines.frustumCulled = false;
    this.root.add(this.spheres, this.lines);
    this.root.visible = false;
  }

  /**
   * @param matrices 25 column-major joint matrices
   * @param radii optional per-joint radius
   * @param toWorld optional transform applied to every joint
   */
  set(matrices: ArrayLike<number>, radii?: ArrayLike<number>, toWorld?: Matrix4): void {
    for (let j = 0; j < JOINT_COUNT; j++) {
      this.m.fromArray(matrices as number[], j * 16);
      if (toWorld) this.m.premultiply(toWorld);
      const r = (radii?.[j] ?? 0.008) * 0.6;
      this.v.setFromMatrixPosition(this.m);
      this.m.makeScale(r, r, r).setPosition(this.v);
      this.spheres.setMatrixAt(j, this.m);
      const p = PARENT[j];
      const o = j * 6;
      this.linePos[o] = this.v.x;
      this.linePos[o + 1] = this.v.y;
      this.linePos[o + 2] = this.v.z;
      if (p < 0) {
        this.linePos[o + 3] = this.v.x;
        this.linePos[o + 4] = this.v.y;
        this.linePos[o + 5] = this.v.z;
      } else {
        // Parent position was already written at slot p*6.
        this.linePos[o + 3] = this.linePos[p * 6];
        this.linePos[o + 4] = this.linePos[p * 6 + 1];
        this.linePos[o + 5] = this.linePos[p * 6 + 2];
      }
    }
    this.spheres.instanceMatrix.needsUpdate = true;
    (this.lines.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
  }
}
