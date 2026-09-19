export type RoomSize = 3 | 4.5;
export interface Settings { size: RoomSize; clothes: number; door: number; fan: boolean; fanSpeed: number; fanYaw: number; fanTilt: number }
export const DEFAULT_SETTINGS: Settings = { size: 3, clothes: 5, door: 50, fan: true, fanSpeed: 1.8, fanYaw: -10, fanTilt: 20 };
export const HEIGHT = 2.25;
export const DEPTH = 2.7;
export const CELL = 0.1125;
export const DOOR_CENTER = 0.2;
export const DOOR_WIDTH = 0.9;
export const roomWidth = (size: RoomSize) => size === 3 ? 1.8 : 2.7;
export interface ExhaustOpening { xMin: number; xMax: number; zMin: number; zMax: number; y: number }
/** One shared, grid-aligned 3 x 3 opening for the solver and the visible grille. */
export function exhaustOpening(size: RoomSize): ExhaustOpening {
  const originX = -roomWidth(size) / 2 - 4 * CELL, originZ = -DEPTH / 2 - CELL;
  const i = Math.floor((roomWidth(size) / 2 - 0.4 - originX) / CELL);
  const k = Math.floor((-0.88 - originZ) / CELL);
  return { xMin: originX + (i - 1) * CELL, xMax: originX + (i + 2) * CELL,
    zMin: originZ + (k - 1) * CELL, zMax: originZ + (k + 2) * CELL, y: HEIGHT };
}
export function inExhaustOpening(opening: ExhaustOpening, x: number, z: number) {
  return x >= opening.xMin && x < opening.xMax && z >= opening.zMin && z < opening.zMax;
}
export function clothingPositions(settings: Settings): number[] {
  const width = roomWidth(settings.size);
  return Array.from({ length: settings.clothes }, (_, i) =>
    settings.clothes === 1 ? 0 : -width / 2 + 0.22 + i * (width - 0.44) / (settings.clothes - 1));
}
export interface FlowField {
  nx: number; ny: number; nz: number; h: number;
  origin: [number, number, number];
  velocity: Float32Array; fluid: Uint8Array; vorticity: Float32Array; time: number; computationMs?: number;
  /** Positive-face MAC velocities, kept separate from cell-centred metrics. */
  faceVelocity: [Float32Array, Float32Array, Float32Array];
  /** Cells bordering the prescribed upward outlet faces; no volume sink. */
  exhaustCells: number[];
  exhaustOpening: ExhaustOpening | null;
  diagnostics: { doorNetInflow: number; boundaryNetInflow: number; exhaustOutflow: number; maxDivergence: number; maxSpeed: number; kineticEnergy: number };
  metrics: { meanSpeed: number; clothingSpeed: number; airChanges: number; exhaust: number; stagnant: number; residual: number; iterations: number; meanVorticity: number };
}

export function isFluid(field: FlowField, x: number, y: number, z: number): boolean {
  if (isExhaust(field, x, y, z)) return true; // Include the open boundary itself.
  const i = Math.floor((x - field.origin[0]) / field.h), j = Math.floor(y / field.h), k = Math.floor((z - field.origin[2]) / field.h);
  return i >= 0 && i < field.nx && j >= 0 && j < field.ny && k >= 0 && k < field.nz && !!field.fluid[i + field.nx * (j + field.ny * k)];
}

/** Visit every voxel crossed by a segment, including a short corner crossing. */
export function isFluidSegment(field: FlowField, a: readonly number[], b: readonly number[]): boolean {
  if (!isFluid(field, a[0], a[1], a[2]) || !isFluid(field, b[0], b[1], b[2])) return false;
  const start = [(a[0] - field.origin[0]) / field.h, a[1] / field.h, (a[2] - field.origin[2]) / field.h];
  const end = [(b[0] - field.origin[0]) / field.h, b[1] / field.h, (b[2] - field.origin[2]) / field.h];
  // The open face belongs to the domain closure, not a voxel above the room.
  // Keep DDA endpoints infinitesimally inside it to avoid round-off crossing
  // into row ny at t = 1 (or starting in that row for a reverse trace).
  if (isExhaust(field, ...a as [number, number, number])) start[1] = field.ny - 1e-9;
  if (isExhaust(field, ...b as [number, number, number])) end[1] = field.ny - 1e-9;
  const delta = end.map((v, axis) => v - start[axis]);
  const cell = start.map(Math.floor), step = delta.map(Math.sign);
  const next = delta.map((d, axis) => d ? (cell[axis] + (d > 0 ? 1 : 0) - start[axis]) / d : Infinity);
  const limit = 3 + Math.ceil(Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]));
  for (let n = 0; n < limit; n++) {
    const t = Math.min(...next);
    if (t >= 1) return true;
    for (let axis = 0; axis < 3; axis++) if (next[axis] <= t + 1e-12) {
      cell[axis] += step[axis]; next[axis] += 1 / Math.abs(delta[axis]);
    }
    const [i, j, k] = cell;
    if (i < 0 || i >= field.nx || j < 0 || j >= field.ny || k < 0 || k >= field.nz || !field.fluid[i + field.nx * (j + field.ny * k)]) return false;
  }
  return false;
}

/** Reconstruct each component on its own MAC faces. Cell-centred averaging
 * would introduce a nonzero normal velocity at an otherwise impermeable wall. */
export function sampleVelocity(field: FlowField, x: number, y: number, z: number, out: number[]): number[] {
  const fx = (x - field.origin[0]) / field.h - 0.5, fy = y / field.h - 0.5, fz = (z - field.origin[2]) / field.h - 0.5;
  out[0] = out[1] = out[2] = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gx = fx - (axis === 0 ? 0.5 : 0), gy = fy - (axis === 1 ? 0.5 : 0), gz = fz - (axis === 2 ? 0.5 : 0);
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz), tx = gx - ix, ty = gy - iy, tz = gz - iz;
    for (let c = 0; c < 2; c++) for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
      const i = ix + a, j = iy + b, k = iz + c;
      if (i < 0 || i >= field.nx || j < 0 || j >= field.ny || k < 0 || k >= field.nz) continue;
      const weight = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz);
      out[axis] += field.faceVelocity[axis][i + field.nx * (j + field.ny * k)] * weight;
    }
  }
  const opening = field.exhaustOpening;
  if (opening && y >= opening.y - field.h && y <= opening.y) {
    // Interpolate up to the actual face boundary value, without smearing its
    // nonzero normal velocity sideways onto the closed part of the ceiling.
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    let below = 0;
    for (let c = 0; c < 2; c++) for (let a = 0; a < 2; a++) {
      const i = ix + a, k = iz + c;
      if (i >= 0 && i < field.nx && k >= 0 && k < field.nz) below += (a ? tx : 1 - tx) * (c ? tz : 1 - tz)
        * field.faceVelocity[1][i + field.nx * (field.ny - 2 + field.ny * k)];
    }
    const i = Math.floor(fx + 0.5), k = Math.floor(fz + 0.5);
    const atOpening = inExhaustOpening(opening, x, z);
    const normal = atOpening ? field.faceVelocity[1][i + field.nx * (field.ny - 1 + field.ny * k)] : 0;
    const t = (y - opening.y + field.h) / field.h;
    out[1] = (1 - t) * below + t * normal;
  }
  return out;
}

export function isExhaust(field: FlowField, x: number, y: number, z: number): boolean {
  return !!field.exhaustOpening && Math.abs(y - field.exhaustOpening.y) < 1e-9
    && inExhaustOpening(field.exhaustOpening, x, z);
}

/** Clip a departing path to the aperture, checking the path below the ceiling
 * so a long step cannot escape through a wall and then hit the outlet. */
export function exhaustIntersection(field: FlowField, a: readonly number[], b: readonly number[]): [number, number, number] | null {
  const opening = field.exhaustOpening;
  if (!opening || a[1] >= opening.y || b[1] < opening.y || b[1] <= a[1]) return null;
  const t = (opening.y - a[1]) / (b[1] - a[1]);
  const x = a[0] + t * (b[0] - a[0]), z = a[2] + t * (b[2] - a[2]);
  if (!inExhaustOpening(opening, x, z)
    || !isFluidSegment(field, a, [x, opening.y - 1e-8, z])) return null;
  return [x, opening.y, z];
}

export function fanDirection(settings: Settings): [number, number, number] {
  const yaw = settings.fanYaw * Math.PI / 180, tilt = settings.fanTilt * Math.PI / 180;
  return [Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)];
}
export function sameGeometry(a: Settings, b: Settings) {
  return a.size === b.size && a.clothes === b.clothes && a.door === b.door;
}
export function sampleVorticity(field: FlowField, x: number, y: number, z: number): number {
  const i = Math.floor((x - field.origin[0]) / field.h), j = Math.floor(y / field.h), k = Math.floor((z - field.origin[2]) / field.h);
  return i >= 0 && i < field.nx && j >= 0 && j < field.ny && k >= 0 && k < field.nz ? field.vorticity[i + field.nx * (j + field.ny * k)] : 0;
}
