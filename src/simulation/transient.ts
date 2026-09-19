import { CELL, DEPTH, DOOR_CENTER, DOOR_WIDTH, HEIGHT, clothingPositions, exhaustOpening, inExhaustOpening, fanDirection, roomWidth, sameGeometry } from './model';
import type { FlowField, Settings } from './model';
import { createFlowFailure, FlowSolverError } from './errors';

type Triple = [Float64Array, Float64Array, Float64Array];
const triple = (n: number): Triple => [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
export const AIR_VISCOSITY = 1.5e-5; // m²/s, approximate air kinematic viscosity
const MAX_DT = 0.04;

/** Trilinear interpolation on a regular scalar grid, with constant exterior
 * extrapolation. Used for each staggered velocity component, not a made-up jet. */
export function interpolate(a: Float64Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  x = Math.max(0, Math.min(nx - 1.001, x)); y = Math.max(0, Math.min(ny - 1.001, y)); z = Math.max(0, Math.min(nz - 1.001, z));
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), q = i + nx * (j + ny * k), xy = nx * ny;
  const tx = x - i, ty = y - j, tz = z - k;
  return (1 - tz) * ((1 - ty) * (a[q] * (1 - tx) + a[q + 1] * tx) + ty * (a[q + nx] * (1 - tx) + a[q + nx + 1] * tx))
    + tz * ((1 - ty) * (a[q + xy] * (1 - tx) + a[q + xy + 1] * tx) + ty * (a[q + xy + nx] * (1 - tx) + a[q + xy + nx + 1] * tx));
}

/** Momentum entering from beyond an open boundary comes from still ambient
 * air. Blend with zero-valued exterior samples instead of recycling the edge
 * velocity back into its own inflow; pressure supplies the make-up flux. */
export function interpolateFromAmbient(a: Float64Array, nx: number, ny: number, nz: number, x: number, y: number, z: number): number {
  const ambientWeight = Math.max(0, Math.min(1, x + 1, nx - x)) * Math.max(0, Math.min(1, z + 1, nz - z));
  return ambientWeight * interpolate(a, nx, ny, nz, x, y, z);
}

/** Magnitude of curl(u), in s⁻¹. It measures local rotation/shear, not whether
 * an entire room is a coherent vortex. No vorticity-confinement force is used. */
export function curlMagnitude(velocity: Float32Array, fluid: Uint8Array, nx: number, ny: number, nz: number, h: number): Float32Array {
  const result = new Float32Array(fluid.length), xy = nx * ny;
  const derivative = (q: number, offset: number, component: number) => (velocity[(q + offset) * 3 + component] - velocity[(q - offset) * 3 + component]) / (2 * h);
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const q = i + nx * (j + ny * k);
    if (fluid[q]) result[q] = Math.hypot(derivative(q, nx, 2) - derivative(q, xy, 1), derivative(q, xy, 0) - derivative(q, 1, 2), derivative(q, 1, 1) - derivative(q, nx, 0));
  }
  return result;
}

/** Unsteady incompressible MAC-grid solver:
 * monotone semi-Lagrangian momentum advection -> viscosity/porous drag/local fan
 * force -> finite-volume pressure projection. Normal solid flux is exactly 0.
 * This coarse, isothermal model resolves large circulation, not full turbulence. */
export class TransientFlow {
  readonly nx: number; readonly ny = 20; readonly nz = 44; readonly h = CELL;
  readonly origin: [number, number, number];
  readonly fluid: Uint8Array;
  readonly area: Triple;
  readonly velocity: Triple;
  time = 0;
  settings: Settings;
  private readonly n: number; private readonly xy: number;
  private readonly fixed: Uint8Array;
  private readonly drag: Float64Array;
  private readonly diagonal: Float64Array;
  private readonly pressure: Float64Array;
  private readonly rhs: Float64Array;
  private readonly r: Float64Array;
  private readonly direction: Float64Array;
  private readonly product: Float64Array;
  private readonly preconditioner: Float64Array;
  private readonly preconditioned: Float64Array;
  private readonly forward: Float64Array;
  private readonly advected: Triple;
  private readonly force: Triple;
  private readonly active: number[] = [];
  private readonly inside: number[] = [];
  private readonly laundry: number[] = [];
  private readonly vents: number[] = [];
  private readonly faces: number[][] = [[], [], []];
  private readonly neighbor: Int32Array[];
  private readonly weights: Float64Array[];
  private readonly roomCells: number;
  private readonly exhaust: number;
  private maxSpeed = 0;
  private residual = 0;
  private iterations = 0;

  constructor(settings: Settings) {
    this.settings = { ...settings };
    const width = roomWidth(settings.size), h = this.h;
    this.roomCells = Math.round(width / h); this.nx = this.roomCells + 12;
    const nx = this.nx, ny = this.ny, nz = this.nz, n = nx * ny * nz; this.n = n; this.xy = nx * ny;
    this.origin = [-width / 2 - 4 * h, 0, -DEPTH / 2 - h];
    this.fluid = new Uint8Array(n); this.fixed = new Uint8Array(n); this.drag = new Float64Array(n);
    this.diagonal = new Float64Array(n); this.pressure = new Float64Array(n); this.rhs = new Float64Array(n);
    this.r = new Float64Array(n); this.direction = new Float64Array(n); this.product = new Float64Array(n);
    this.preconditioner = new Float64Array(n); this.preconditioned = new Float64Array(n); this.forward = new Float64Array(n);
    this.area = triple(n); this.velocity = triple(n); this.advected = triple(n);
    this.force = triple(n);
    this.neighbor = Array.from({ length: 6 }, () => new Int32Array(n));
    this.weights = Array.from({ length: 6 }, () => new Float64Array(n));
    const aperture = new Float64Array(n), positions = clothingPositions(settings), opening = exhaustOpening(settings.size);
    const openedRight = DOOR_CENTER - DOOR_WIDTH / 2 + DOOR_WIDTH * settings.door / 100;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = i + nx * (j + ny * k), x = this.origin[0] + (i + 0.5) * h, y = (j + 0.5) * h, z = this.origin[2] + (k + 0.5) * h;
      const withinX = i >= 4 && i < 4 + this.roomCells, inUB = withinX && k >= 1 && k <= 24;
      let a = 1;
      if ((i === 3 || i === 4 + this.roomCells) && k <= 25) a = 0;
      if (k === 0 && withinX) a = 0;
      if (k === 25 && withinX) {
        const fraction = (right: number) => Math.max(0, Math.min(x + h / 2, right) - Math.max(x - h / 2, DOOR_CENTER - DOOR_WIDTH / 2)) / h;
        a = y < 1.95 ? fraction(openedRight) : 0;
        if (j === 0) a = Math.max(a, fraction(DOOR_CENTER + DOOR_WIDTH / 2) * 0.015 / h);
      }
      if (inUB && x < -width / 2 + 0.77 && z < -0.06 && z > -1.24 && y < 0.55) a = 0;
      if (inUB && y > 0.82 && y < 1.72 && Math.abs(z) < 0.35) {
        this.laundry.push(q);
        if (positions.some(cx => Math.abs(x - cx) < h * 0.52)) this.drag[q] = 1;
      }
      aperture[q] = a; this.fluid[q] = a > 0 ? 1 : 0;
      this.fixed[q] = a > 0 && (i === 0 || i === nx - 1 || k === 0 || k === nz - 1) ? 1 : 0;
      if (inUB && a > 0) this.inside.push(q);
      if (inUB && j === ny - 1 && inExhaustOpening(opening, x, z)) this.vents.push(q);
    }
    const steps = [1, nx, this.xy];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = i + nx * (j + ny * k);
      for (let axis = 0; axis < 3; axis++) {
        if ([i, j, k][axis] === [nx, ny, nz][axis] - 1) continue;
        const area = Math.min(aperture[q], aperture[q + steps[axis]]);
        this.area[axis][q] = area;
        if (area > 0) this.faces[axis].push(q);
      }
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = i + nx * (j + ny * k);
      if (!this.fluid[q] || this.fixed[q]) continue;
      for (let axis = 0; axis < 3; axis++) for (let sign = 0; sign < 2; sign++) {
        const d = axis * 2 + sign, step = steps[axis], neighbor = q + (sign ? step : -step);
        const valid = sign ? [i, j, k][axis] < [nx, ny, nz][axis] - 1 : [i, j, k][axis] > 0;
        this.neighbor[d][q] = valid ? neighbor : q;
        const weight = valid ? this.area[axis][sign ? q : neighbor] : 0;
        this.weights[d][q] = weight; this.diagonal[q] += weight;
      }
      if (this.diagonal[q]) this.active.push(q);
    }
    this.exhaust = 90 * (0.22 + 0.78 * Math.sqrt(settings.door / 100));
    // Prescribed outward flux at the ceiling. These faces participate in
    // divergence, but not in the pressure matrix or internal-face updates.
    for (const q of this.vents) this.area[1][q] = 1;
    this.buildPreconditioner();
    this.setFan(settings);
    this.project(); // Initial incompressible make-up flow, before fan spin-up.
  }

  setFan(settings: Settings) {
    if (!sameGeometry(this.settings, settings)) throw new Error('Geometry changes require a fresh solver');
    this.settings = { ...settings };
    const n = fanDirection(settings), h = this.h;
    for (let axis = 0; axis < 3; axis++) {
      this.force[axis].fill(0);
      if (!settings.fan) continue;
      for (const q of this.faces[axis]) {
        const i = q % this.nx, j = Math.floor(q / this.nx) % this.ny, k = Math.floor(q / this.xy);
        const x = this.origin[0] + (i + 0.5 + (axis === 0 ? 0.5 : 0)) * h - DOOR_CENTER;
        const y = (j + 0.5 + (axis === 1 ? 0.5 : 0)) * h - 0.54;
        const z = this.origin[2] + (k + 0.5 + (axis === 2 ? 0.5 : 0)) * h - 2.52;
        const axial = x * n[0] + y * n[1] + z * n[2], radial = x * x + y * y + z * z - axial * axial;
        // Force is ONLY applied within the physical fan disk outside the UB.
        if (Math.abs(axial) < 0.18 && radial < 0.24 ** 2) this.force[axis][q] = 18 * (1 - radial / 0.24 ** 2) ** 2 * (0.5 + 0.5 * Math.cos(Math.PI * axial / 0.18));
      }
    }
  }

  private sampleComponent(axis: number, x: number, y: number, z: number, fields = this.velocity) {
    return interpolate(fields[axis], this.nx, this.ny, this.nz, x - (axis === 0 ? 0.5 : 0), y - (axis === 1 ? 0.5 : 0), z - (axis === 2 ? 0.5 : 0));
  }

  private transport(dt: number) {
    const nx = this.nx, ny = this.ny, nz = this.nz, xy = this.xy, amount = dt / this.h;
    // Use the monotone first-order update throughout the domain. The former
    // limited MacCormack correction amplified small interior disturbances after
    // minutes even with boundary halos. This convex interpolation adds numerical
    // diffusion, but no correction energy or artificial circulating force.
    for (let axis = 0; axis < 3; axis++) {
      const out = this.advected[axis]; out.fill(0);
      for (const q of this.faces[axis]) {
        const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / xy);
        const x = i + (axis === 0 ? 0.5 : 0), y = j + (axis === 1 ? 0.5 : 0), z = k + (axis === 2 ? 0.5 : 0);
        const dx = amount * this.sampleComponent(0, x, y, z), dy = amount * this.sampleComponent(1, x, y, z), dz = amount * this.sampleComponent(2, x, y, z);
        out[q] = interpolateFromAmbient(this.velocity[axis], nx, ny, nz, i - dx, j - dy, k - dz);
      }
      if (axis === 1) for (const q of this.vents) out[q] = this.velocity[1][q];
    }
  }

  private forcesAndViscosity(dt: number) {
    const n = fanDirection(this.settings), h = this.h, nx = this.nx, xy = this.xy, steps = [1, nx, xy];
    const diffusion = AIR_VISCOSITY * dt / (h * h);
    for (let axis = 0; axis < 3; axis++) {
      const a = this.advected[axis], out = this.velocity[axis];
      for (const q of this.faces[axis]) {
        const i = q % nx, j = Math.floor(q / nx) % this.ny, k = Math.floor(q / xy);
        let laplace = 0;
        for (let d = 0; d < 3; d++) {
          const position = [i, j, k][d], size = [nx, this.ny, this.nz][d], step = steps[d];
          // Zero velocity in solids gives a grid-scale no-slip viscous boundary;
          // pressure enforces zero normal flux independently and exactly.
          laplace += (position > 0 ? a[q - step] : a[q]) + (position < size - 1 ? a[q + step] : a[q]) - 2 * a[q];
        }
        let value = a[q] + diffusion * laplace;
        const resistance = (this.drag[q] + this.drag[q + steps[axis]]) * 0.5;
        value /= 1 + dt * resistance * (8 + 10 * Math.abs(value));
        if (this.force[axis][q]) {
          const x = i + (axis === 0 ? 0.5 : 0), y = j + (axis === 1 ? 0.5 : 0), z = k + (axis === 2 ? 0.5 : 0);
          let axial = 0;
          for (let d = 0; d < 3; d++) axial += n[d] * this.sampleComponent(d, x, y, z, this.advected);
          const gain = 1 - Math.exp(-dt * this.force[axis][q]);
          value += gain * (this.settings.fanSpeed - axial) * n[axis];
        }
        out[q] = value;
      }
    }
  }

  private applyMatrix(input: Float64Array, out: Float64Array) {
    const [n0, n1, n2, n3, n4, n5] = this.neighbor, [w0, w1, w2, w3, w4, w5] = this.weights;
    for (const q of this.active) out[q] = this.diagonal[q] * input[q] - w0[q] * input[n0[q]] - w1[q] * input[n1[q]] - w2[q] * input[n2[q]] - w3[q] * input[n3[q]] - w4[q] * input[n4[q]] - w5[q] * input[n5[q]];
  }

  // Modified incomplete Cholesky (Bridson, fluid simulation course notes).
  // Preserves the smooth pressure modes that diagonal PCG converges on slowly.
  private buildPreconditioner() {
    const p = this.preconditioner, n = this.neighbor, w = this.weights;
    for (const q of this.active) {
      let e = this.diagonal[q];
      for (let axis = 0; axis < 3; axis++) {
        const d = axis * 2, prev = n[d][q], a = w[d][q], pp = p[prev] ** 2;
        e -= a * a * pp;
        let other = 0;
        for (let nextAxis = 0; nextAxis < 3; nextAxis++) if (nextAxis !== axis) other += w[nextAxis * 2 + 1][prev];
        e -= 0.97 * a * other * pp;
      }
      if (e < 0.25 * this.diagonal[q]) e = this.diagonal[q];
      p[q] = 1 / Math.sqrt(e);
    }
  }

  private precondition() {
    const [n0, n1, n2, n3, n4, n5] = this.neighbor, [w0, w1, w2, w3, w4, w5] = this.weights;
    const p = this.preconditioner, y = this.forward, z = this.preconditioned;
    for (const q of this.active) y[q] = (this.r[q] + w0[q] * p[n0[q]] * y[n0[q]] + w2[q] * p[n2[q]] * y[n2[q]] + w4[q] * p[n4[q]] * y[n4[q]]) * p[q];
    for (let i = this.active.length - 1; i >= 0; i--) {
      const q = this.active[i]; z[q] = (y[q] + p[q] * (w1[q] * z[n1[q]] + w3[q] * z[n3[q]] + w5[q] * z[n5[q]])) * p[q];
    }
  }

  private fluxDivergence(q: number) {
    const [u, v, w] = this.velocity, [ax, ay, az] = this.area, nx = this.nx, xy = this.xy;
    const i = q % nx, j = Math.floor(q / nx) % this.ny, k = Math.floor(q / xy);
    return (ax[q] * u[q] - (i > 0 ? ax[q - 1] * u[q - 1] : 0) + ay[q] * v[q] - (j > 0 ? ay[q - nx] * v[q - nx] : 0) + az[q] * w[q] - (k > 0 ? az[q - xy] * w[q - xy] : 0)) / this.h;
  }

  /** Pressure correction is in velocity-potential units (dt*p/rho), avoiding
   * time-step-dependent conditioning. The outlet is a prescribed normal flux,
   * so every interior cell (including those below the vent) has zero divergence. */
  project() {
    const h = this.h, outletSpeed = (this.exhaust / 3600) / (h * h * this.vents.length);
    for (const q of this.vents) this.velocity[1][q] = outletSpeed;
    for (const q of this.active) this.rhs[q] = -this.fluxDivergence(q) * h * h;
    this.applyMatrix(this.pressure, this.product);
    let rz = 0, normB = 0;
    this.direction.fill(0);
    for (const q of this.active) {
      this.r[q] = this.rhs[q] - this.product[q]; normB += this.rhs[q] ** 2;
    }
    this.precondition();
    for (const q of this.active) { this.direction[q] = this.preconditioned[q]; rz += this.r[q] * this.direction[q]; }
    let iteration = 0;
    for (; iteration < 450 && rz > 1e-26; iteration++) {
      this.applyMatrix(this.direction, this.product);
      let denom = 0;
      for (const q of this.active) denom += this.direction[q] * this.product[q];
      if (denom <= 0) break;
      const alpha = rz / denom;
      let next = 0, norm = 0;
      for (const q of this.active) {
        this.pressure[q] += alpha * this.direction[q]; this.r[q] -= alpha * this.product[q];
        norm += this.r[q] ** 2;
      }
      if (norm < Math.max(1e-22, normB * 1e-12)) break;
      this.precondition();
      for (const q of this.active) next += this.r[q] * this.preconditioned[q];
      const beta = next / rz;
      for (const q of this.active) this.direction[q] = this.preconditioned[q] + beta * this.direction[q];
      rz = next;
    }
    this.iterations = iteration;
    const steps = [1, this.nx, this.xy];
    this.maxSpeed = outletSpeed;
    for (let axis = 0; axis < 3; axis++) for (const q of this.faces[axis]) {
      this.velocity[axis][q] += (this.pressure[q] - this.pressure[q + steps[axis]]) / h;
      this.maxSpeed = Math.max(this.maxSpeed, Math.abs(this.velocity[axis][q]));
    }
    this.residual = 0;
    for (const q of this.active) this.residual = Math.max(this.residual, Math.abs(this.fluxDivergence(q)));
    const code = !Number.isFinite(this.maxSpeed) || !Number.isFinite(this.residual) ? 'non-finite'
      : this.maxSpeed > 50 ? 'speed-limit' : this.residual > 0.01 ? 'pressure-residual' : null;
    if (code) throw new FlowSolverError(createFlowFailure(code,
      `Flow stopped: ${code} (speed=${this.maxSpeed}, divergence=${this.residual})`, this.settings, this.time,
      { maxSpeed: this.maxSpeed, maxDivergence: this.residual, iterations: this.iterations }));
  }

  advance(duration: number) {
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    const end = this.time + duration;
    while (end - this.time > 1e-9) {
      const dt = Math.min(MAX_DT, end - this.time, 0.75 * this.h / Math.max(this.maxSpeed, 0.1));
      this.transport(dt); this.forcesAndViscosity(dt); this.project(); this.time += dt;
    }
  }

  snapshot(): FlowField {
    const nx = this.nx, ny = this.ny, nz = this.nz, xy = this.xy, h = this.h;
    const velocity = new Float32Array(this.n * 3), [u, v, w] = this.velocity;
    let doorNetInflow = 0, boundaryNetInflow = 0, kineticEnergy = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const q = i + nx * (j + ny * k);
      if (!this.fluid[q]) continue;
      velocity[q * 3] = (u[q] + (i > 0 ? u[q - 1] : 0)) / 2;
      velocity[q * 3 + 1] = (v[q] + (j > 0 ? v[q - nx] : 0)) / 2;
      velocity[q * 3 + 2] = (w[q] + (k > 0 ? w[q - xy] : 0)) / 2;
      if (k === 24 && i >= 4 && i < 4 + this.roomCells) doorNetInflow -= this.area[2][q] * w[q] * h * h;
      if (this.fixed[q]) {
        if (i < nx - 1 && !this.fixed[q + 1]) boundaryNetInflow += this.area[0][q] * u[q] * h * h;
        if (i > 0 && !this.fixed[q - 1]) boundaryNetInflow -= this.area[0][q - 1] * u[q - 1] * h * h;
        if (k < nz - 1 && !this.fixed[q + xy]) boundaryNetInflow += this.area[2][q] * w[q] * h * h;
        if (k > 0 && !this.fixed[q - xy]) boundaryNetInflow -= this.area[2][q - xy] * w[q - xy] * h * h;
      }
      kineticEnergy += 0.5 * (velocity[q * 3] ** 2 + velocity[q * 3 + 1] ** 2 + velocity[q * 3 + 2] ** 2) * h ** 3;
    }
    const speed = (q: number) => Math.hypot(velocity[q * 3], velocity[q * 3 + 1], velocity[q * 3 + 2]);
    const vorticity = curlMagnitude(velocity, this.fluid, nx, ny, nz, h);
    const exhaustOutflow = this.vents.reduce((sum, q) => sum + this.area[1][q] * v[q] * h * h, 0);
    return { nx, ny, nz, h, origin: [...this.origin], fluid: this.fluid.slice(), velocity, vorticity, time: this.time,
      faceVelocity: [Float32Array.from(u), Float32Array.from(v), Float32Array.from(w)], exhaustCells: [...this.vents],
      exhaustOpening: exhaustOpening(this.settings.size),
      diagnostics: { doorNetInflow, boundaryNetInflow, exhaustOutflow, maxDivergence: this.residual, maxSpeed: this.maxSpeed, kineticEnergy },
      metrics: { meanSpeed: this.inside.reduce((sum, q) => sum + speed(q), 0) / this.inside.length,
        clothingSpeed: this.settings.clothes ? this.laundry.reduce((sum, q) => sum + speed(q), 0) / this.laundry.length : 0,
        exhaust: this.exhaust, airChanges: this.exhaust / (roomWidth(this.settings.size) * DEPTH * HEIGHT),
        stagnant: this.inside.filter(q => speed(q) < 0.005).length / this.inside.length * 100,
        meanVorticity: this.inside.reduce((sum, q) => sum + vorticity[q], 0) / this.inside.length,
        residual: this.residual * h ** 3, iterations: this.iterations } };
  }
}
