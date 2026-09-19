import { exhaustIntersection, isFluidSegment, sampleVelocity } from '../simulation/model';
import type { FlowField } from '../simulation/model';

/** Move a marker in physical seconds and retain its exact outlet endpoint. */
export function advanceParticle(field: FlowField, start: readonly number[], dt: number) {
  let position: [number, number, number] = [start[0], start[1], start[2]];
  const v = [0, 0, 0];
  const speed = Math.hypot(...sampleVelocity(field, ...position, v));
  const steps = Math.max(1, Math.ceil(speed * dt / (field.h * 0.38)));
  for (let sub = 0; sub < steps; sub++) {
    sampleVelocity(field, ...position, v);
    const next: [number, number, number] = position.map((x, axis) => x + v[axis] * dt / steps) as [number, number, number];
    const exit = exhaustIntersection(field, position, next);
    if (exit) return { position: exit, exited: true, blocked: false };
    if (!isFluidSegment(field, position, next)) return { position, exited: false, blocked: true };
    position = next;
  }
  return { position, exited: false, blocked: false };
}
