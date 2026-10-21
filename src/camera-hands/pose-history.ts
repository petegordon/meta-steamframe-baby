import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';

/**
 * Recent head poses, so a camera frame captured ~50 ms ago is placed with
 * the head pose *from that moment*. Without this, the hands would swing
 * along with every head turn.
 */
export class PoseHistory {
  private times = new Float64Array(180);
  private pos: Vector3[] = Array.from({ length: 180 }, () => new Vector3());
  private rot: Quaternion[] = Array.from({ length: 180 }, () => new Quaternion());
  private head = 0;
  private size = 0;
  private s = new Vector3();

  clear(): void {
    this.size = 0;
  }

  get empty(): boolean {
    return this.size === 0;
  }

  /** @param t ms (performance.now clock) */
  push(t: number, m: Matrix4): void {
    if (this.size && t <= this.times[(this.head - 1 + 180) % 180]) return;
    m.decompose(this.pos[this.head], this.rot[this.head], this.s);
    this.times[this.head] = t;
    this.head = (this.head + 1) % 180;
    this.size = Math.min(this.size + 1, 180);
  }

  /** Head pose at time t (interpolated; clamped to the oldest/newest sample). */
  sample(t: number, out: Matrix4): boolean {
    if (!this.size) return false;
    const n = this.size;
    const idx = (k: number) => (this.head - n + k + 180) % 180; // k = 0 oldest .. n-1 newest
    let lo = idx(0);
    let hi = idx(n - 1);
    if (t >= this.times[hi]) return this.emit(hi, hi, 0, out);
    if (t <= this.times[lo]) return this.emit(lo, lo, 0, out);
    for (let k = n - 1; k > 0; k--) {
      hi = idx(k);
      lo = idx(k - 1);
      if (this.times[lo] <= t) break;
    }
    const span = this.times[hi] - this.times[lo];
    return this.emit(lo, hi, span > 0 ? (t - this.times[lo]) / span : 0, out);
  }

  private tp = new Vector3();
  private tq = new Quaternion();
  private one = new Vector3(1, 1, 1);
  private emit(a: number, b: number, f: number, out: Matrix4): boolean {
    this.tp.lerpVectors(this.pos[a], this.pos[b], f);
    this.tq.slerpQuaternions(this.rot[a], this.rot[b], f);
    out.compose(this.tp, this.tq, this.one);
    return true;
  }
}
