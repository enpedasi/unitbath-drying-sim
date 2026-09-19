import { exhaustIntersection, isExhaust, isFluid, isFluidSegment, sampleVelocity, sampleVorticity } from '../simulation/model';
import type { FlowField, Settings } from '../simulation/model';
import { STREAMLINE_SPACING, uniformFlowSeeds } from './sampling';

export type Position = [number, number, number];
export interface StreamPoint { position: Position; speed: number; vorticity: number }

/** Instantaneous streamline: integrate direction by arc length, not physical
 * time. This reveals slow flow without changing the solver or particle speed. */
export function traceStreamline(field: FlowField, seed: Position, maxLength = 10): StreamPoint[] {
  if (!isFluid(field, ...seed)) return [];
  const v = [0, 0, 0], m = [0, 0, 0], spacing = field.h * 0.35;
  const point = (position: Position): StreamPoint => ({ position,
    speed: Math.hypot(...sampleVelocity(field, ...position, v)), vorticity: sampleVorticity(field, ...position) });
  const trace = (direction: number) => {
    const result: StreamPoint[] = [];
    let p = seed, length = 0;
    for (let step = 0; step < 320 && length < maxLength / 2; step++) {
      const speed = Math.hypot(...sampleVelocity(field, ...p, v));
      if (!Number.isFinite(speed) || speed < 1e-6 || isExhaust(field, ...p)) break;
      let distance = Math.min(spacing, maxLength / 2 - length), next: Position | undefined;
      // Reduce the step near geometry; never connect through a solid cell.
      for (let attempt = 0; attempt < 7; attempt++, distance *= 0.5) {
        const mid: Position = [p[0] + direction * v[0] / speed * distance / 2,
          p[1] + direction * v[1] / speed * distance / 2, p[2] + direction * v[2] / speed * distance / 2];
        const midExit = exhaustIntersection(field, p, mid);
        if (midExit) { next = midExit; break; }
        if (!isFluid(field, ...mid)) continue;
        const midSpeed = Math.hypot(...sampleVelocity(field, ...mid, m));
        if (!Number.isFinite(midSpeed) || midSpeed < 1e-6) break;
        const end: Position = [p[0] + direction * m[0] / midSpeed * distance,
          p[1] + direction * m[1] / midSpeed * distance, p[2] + direction * m[2] / midSpeed * distance];
        const exit = exhaustIntersection(field, p, end);
        if (exit) { next = exit; break; }
        if (isFluidSegment(field, p, end)) { next = end; break; }
      }
      if (!next) break;
      result.push(point(next)); length += distance; p = next;
      if (isExhaust(field, ...p)) break;
      if (length > field.h * 8 && Math.hypot(p[0] - seed[0], p[1] - seed[1], p[2] - seed[2]) < spacing * 0.75) break;
    }
    return result;
  };
  // Vertex order always follows the actual flow, including the upstream half.
  return [...trace(-1).reverse(), point(seed), ...trace(1)];
}

export function streamlineSeeds(settings: Settings): Position[] {
  return uniformFlowSeeds(settings, STREAMLINE_SPACING);
}
