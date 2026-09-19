import { CELL, DEPTH, HEIGHT, exhaustIntersection, isFluid, isFluidSegment, roomWidth, sampleVelocity, sampleVorticity } from '../simulation/model';
import type { FlowField, Settings } from '../simulation/model';

export type Position = [number, number, number];
export const VECTOR_SPACING = CELL * 3;
export const STREAMLINE_SPACING = CELL * 5;
const FRONT = 3.15;

/** Equal physical spacing throughout the UB and the space in front of its door.
 * Positions never depend on speed, fan state, or distance from an opening. */
export function uniformFlowSeeds(settings: Settings, spacing: number): Position[] {
  const width = roomWidth(settings.size), positions: Position[] = [];
  for (let y = spacing / 2; y < HEIGHT; y += spacing) {
    for (let z = -DEPTH / 2 + spacing / 2; z < FRONT; z += spacing) {
      for (let x = -width / 2 + spacing / 2; x < width / 2; x += spacing) positions.push([x, y, z]);
    }
  }
  return positions;
}

export interface FlowVector {
  position: Position;
  end: Position;
  speed: number;
  vorticity: number;
}

/** Fixed observation points, including zero-speed points. Glyph length is a
 * bounded visual scale, not particle displacement or a modification of u. */
export function flowVectors(field: FlowField, seeds: readonly Position[]): FlowVector[] {
  const samples: FlowVector[] = [], v = [0, 0, 0];
  for (const position of seeds) {
    if (!isFluid(field, ...position)) continue;
    const speed = Math.hypot(...sampleVelocity(field, ...position, v));
    let end: Position = [...position];
    if (Number.isFinite(speed) && speed > 1e-8) {
      let length = 0.11 + 0.15 * Math.sqrt(Math.min(speed / 0.8, 1));
      for (let attempt = 0; attempt < 8; attempt++, length *= 0.5) {
        const target = position.map((value, axis) => value + v[axis] / speed * length) as Position;
        const exit = exhaustIntersection(field, position, target);
        if (exit) { end = exit; break; }
        if (isFluidSegment(field, position, target)) { end = target; break; }
      }
    }
    samples.push({ position, end, speed, vorticity: sampleVorticity(field, ...position) });
  }
  return samples;
}

/** All equal-volume fluid cells in the displayed space. Solid cells and the
 * layer below the visible floor are excluded; no region receives extra weight. */
export function particleSeedCells(field: FlowField, settings: Settings): number[] {
  const width = roomWidth(settings.size), cells: number[] = [];
  for (let q = 0; q < field.fluid.length; q++) {
    if (!field.fluid[q]) continue;
    const i = q % field.nx, j = Math.floor(q / field.nx) % field.ny, k = Math.floor(q / (field.nx * field.ny));
    const x = field.origin[0] + (i + 0.5) * field.h, z = field.origin[2] + (k + 0.5) * field.h;
    if (x > -width / 2 && x < width / 2 && j > 0 && z > -DEPTH / 2 && z < FRONT) cells.push(q);
  }
  return cells;
}

export function particleSeed(field: FlowField, cells: readonly number[], fraction: number, random = Math.random): Position {
  const q = cells[Math.min(cells.length - 1, Math.floor(fraction * cells.length))];
  const i = q % field.nx, j = Math.floor(q / field.nx) % field.ny, k = Math.floor(q / (field.nx * field.ny));
  return [field.origin[0] + (i + random()) * field.h, (j + random()) * field.h,
    field.origin[2] + (k + random()) * field.h];
}
