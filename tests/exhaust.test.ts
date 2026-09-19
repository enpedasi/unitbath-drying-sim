import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, HEIGHT, exhaustIntersection, inExhaustOpening, isExhaust, isFluid, sampleVelocity } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';
import { advanceParticle } from '../src/scene/particles.ts';
import { traceStreamline } from '../src/scene/streamlines.ts';

test('両サイズ・各開度で天井の開口通過流量が給気量と一致し、開口直下でも体積を除去しない', () => {
  for (const size of [3, 4.5] as const) for (const door of [0, 10, 15, 100]) {
    const sim = new TransientFlow({ ...DEFAULT_SETTINGS, size, door, clothes: 0, fan: false });
    for (const duration of [0, 0.24]) {
      sim.advance(duration);
      const f = sim.snapshot(), expected = f.metrics.exhaust / 3600, opening = f.exhaustOpening!;
      let outflow = 0;
      for (let k = 0; k < f.nz; k++) for (let i = 0; i < f.nx; i++) {
        const q = i + f.nx * (f.ny - 1 + f.ny * k);
        const open = inExhaustOpening(opening, f.origin[0] + (i + 0.5) * f.h, f.origin[2] + (k + 0.5) * f.h);
        assert.equal(sim.area[1][q], open ? 1 : 0);
        if (open) assert.ok(sim.velocity[1][q] > 0); else assert.equal(sim.velocity[1][q], 0);
        outflow += sim.area[1][q] * sim.velocity[1][q] * f.h ** 2;
      }
      assert.ok(Math.abs(outflow - expected) < 1e-12);
      assert.equal(f.diagnostics.exhaustOutflow, outflow);
      assert.ok(Math.abs(outflow - f.diagnostics.doorNetInflow) < 1e-6);
      assert.ok(Math.abs(outflow - f.diagnostics.boundaryNetInflow) < 1e-6);
      // Independently sum all six faces of every interior fluid cell. In the
      // old sink implementation the outlet cells had nonzero divergence.
      for (let k = 1; k < f.nz - 1; k++) for (let j = 0; j < f.ny; j++) for (let i = 1; i < f.nx - 1; i++) {
        const q = i + f.nx * (j + f.ny * k);
        if (!f.fluid[q]) continue;
        let flux = 0;
        for (let axis = 0; axis < 3; axis++) {
          const step = [1, f.nx, f.nx * f.ny][axis];
          flux += sim.area[axis][q] * sim.velocity[axis][q];
          if (axis !== 1 || j > 0) flux -= sim.area[axis][q - step] * sim.velocity[axis][q - step];
        }
        assert.ok(Math.abs(flux / f.h) < 1e-4, `divergence at ${i},${j},${k}`);
      }
    }
  }
});

test('表示用速度も開口を通過し、閉じた天井へ吸い込みを広げない', () => {
  const f = new TransientFlow({ ...DEFAULT_SETTINGS, clothes: 0, door: 10, fan: false }).snapshot();
  const opening = f.exhaustOpening!, v = [0, 0, 0];
  let renderedOutflow = 0;
  for (let k = 0; k < f.nz; k++) for (let i = 0; i < f.nx; i++) for (const dx of [0.1, 0.5, 0.9]) for (const dz of [0.1, 0.5, 0.9]) {
    const x = f.origin[0] + (i + dx) * f.h, z = f.origin[2] + (k + dz) * f.h;
    const vy = sampleVelocity(f, x, HEIGHT, z, v)[1];
    if (inExhaustOpening(opening, x, z)) assert.ok(vy > 0); else assert.ok(Math.abs(vy) < 1e-12);
    renderedOutflow += vy * f.h ** 2 / 9;
  }
  assert.ok(Math.abs(renderedOutflow - f.diagnostics.exhaustOutflow) < 1e-8);
  const x = (opening.xMin + opening.xMax) / 2, z = (opening.zMin + opening.zMax) / 2;
  const speeds = [HEIGHT - 0.3, HEIGHT - 0.1, HEIGHT].map(y => sampleVelocity(f, x, y, z, [0, 0, 0])[1]);
  assert.ok(speeds[0] < speeds[1] && speeds[1] < speeds[2], `initial approach ${speeds}`);
  assert.equal(isExhaust(f, x, HEIGHT - 0.02, z), false);
  assert.equal(isExhaust(f, x, HEIGHT, z), true);
  assert.equal(isFluid(f, x, HEIGHT + 0.001, z), false);
});

test('粒子と流線が換気口の手前で消えず、実際の開口面に到達する', () => {
  const f = new TransientFlow({ ...DEFAULT_SETTINGS, clothes: 0, door: 10, fan: false }).snapshot();
  const o = f.exhaustOpening!, x = (o.xMin + o.xMax) / 2, z = (o.zMin + o.zMax) / 2;
  let p: [number, number, number] = [x, HEIGHT - 0.2, z], exited = false;
  for (let i = 0; i < 400 && !exited; i++) {
    const moved = advanceParticle(f, p, 0.04);
    assert.equal(moved.blocked, false);
    assert.ok(moved.position[1] >= p[1]);
    p = moved.position; exited = moved.exited;
  }
  assert.equal(exited, true);
  assert.equal(p[1], HEIGHT);
  const line = traceStreamline(f, [x, HEIGHT - 0.2, z]);
  assert.ok(line.length > 5);
  assert.equal(line.at(-1)!.position[1], HEIGHT);
  assert.ok(isExhaust(f, ...line.at(-1)!.position));
  assert.equal(exhaustIntersection(f, [o.xMin - 0.01, HEIGHT - 0.02, z], [o.xMin - 0.01, HEIGHT + 0.02, z]), null);
  const crossing = exhaustIntersection(f, [x, HEIGHT - 0.05, z], [x, HEIGHT + 0.05, z]);
  assert.deepEqual(crossing, [x, HEIGHT, z]);
});
