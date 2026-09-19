import type { FlowVector, Position } from './sampling';

// One common visual gain preserves speed ratios, including very weak flow.
// This affects local glyphs only, never the solver, clock, or tracer particles.
export const VECTOR_MOTION_SCALE = 10;

interface Track { sample: FlowVector; length: number; phase: number }
export interface MovingArrow { start: Position; end: Position; opacity: number }

/** Each observation point owns a short, repeating arrow. Integrate phase from
 * simulated dt (not wall time * the latest speed), so speed changes don't jump
 * the animation and markers cannot accumulate near inlets or outlets. */
export class VectorMotion {
  tracks: Track[] = [];

  clear() { this.tracks = []; }

  setSamples(samples: readonly FlowVector[]) {
    const phases = new Map(this.tracks.map(t => [t.sample.position.join(','), t.phase]));
    this.tracks = samples.map((sample, i) => ({
      sample,
      length: Math.hypot(...sample.end.map((x, axis) => x - sample.position[axis])),
      phase: phases.get(sample.position.join(',')) ?? (0.25 + i * 0.61803398875) % 1,
    }));
  }

  advance(simulatedDt: number) {
    if (!(simulatedDt > 0) || !Number.isFinite(simulatedDt)) return;
    for (const track of this.tracks) {
      if (track.length < 1e-5 || !(track.sample.speed > 1e-8) || !Number.isFinite(track.sample.speed)) continue;
      track.phase = (track.phase + track.sample.speed * VECTOR_MOTION_SCALE * simulatedDt / track.length) % 1;
    }
  }

  arrow(index: number): MovingArrow | null {
    const { sample, length, phase } = this.tracks[index];
    if (length < 1e-5 || !(sample.speed > 1e-8) || !Number.isFinite(sample.speed)) return null;
    const tail = Math.max(0, phase - Math.min(0.1 / length, 0.6));
    const at = (t: number) => sample.position.map((x, axis) => x + (sample.end[axis] - x) * t) as Position;
    // Fade out before wrapping. Every shaft is local to its own track, with
    // no segment joining the previous endpoint to the recycled arrow.
    return { start: at(tail), end: at(phase), opacity: Math.min(1, phase / 0.08, (1 - phase) / 0.12) };
  }
}
