/**
 * One Euro filter (Casiez et al. 2012): smooths jitter when the hand is still,
 * stays responsive when it moves fast. Runs over a whole Float32Array at once.
 */
export class OneEuroArray {
  private x: Float32Array;
  private dx: Float32Array;
  private lastT = -1;

  constructor(
    size: number,
    public minCutoff = 1.2,
    public beta = 25,
    public dCutoff = 1.0,
  ) {
    this.x = new Float32Array(size);
    this.dx = new Float32Array(size);
  }

  reset(): void {
    this.lastT = -1;
  }

  /** Filter `v` in place. `t` in seconds. */
  filter(v: Float32Array, t: number): Float32Array {
    if (this.lastT < 0 || t <= this.lastT || t - this.lastT > 0.5) {
      this.x.set(v);
      this.dx.fill(0);
      this.lastT = t;
      return v;
    }
    const dt = t - this.lastT;
    this.lastT = t;
    const aD = alpha(dt, this.dCutoff);
    for (let i = 0; i < v.length; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] += aD * (d - this.dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx[i]);
      const a = alpha(dt, cutoff);
      this.x[i] += a * (v[i] - this.x[i]);
      v[i] = this.x[i];
    }
    return v;
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
