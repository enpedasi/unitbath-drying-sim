import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, HEIGHT, sampleVelocity } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';
import { advanceParticle } from '../src/scene/particles.ts';

test('衣類0枚・戸10%・送風OFFで12分まで開口排気と安定性を保つ', t => {
  const settings = { ...DEFAULT_SETTINGS, size: 3 as const, clothes: 0, door: 10, fan: false };
  const sim = new TransientFlow(settings);
  for (const target of [0, 60, 120, 180, 240, 300, 360, 384, 420, 480, 540, 600, 660, 686.2, 720]) {
    while (sim.time < target - 1e-9) sim.advance(Math.min(0.12, target - sim.time));
    const f = sim.snapshot(), expected = f.metrics.exhaust / 3600;
    let exteriorSpeed = 0, count = 0;
    for (let q = f.nx * f.ny * 26; q < f.fluid.length; q++) if (f.fluid[q]) {
      exteriorSpeed += Math.hypot(f.velocity[q * 3], f.velocity[q * 3 + 1], f.velocity[q * 3 + 2]); count++;
    }
    exteriorSpeed /= count;
    const record = { time: f.time, meanSpeed: f.metrics.meanSpeed, exteriorSpeed, diagnostics: f.diagnostics };
    // Save evidence before assertions, so a late failure retains the field
    // needed to investigate it without repeating minutes of computation.
    const capture = process.env.UBSIMU_CAPTURE_DIR;
    if (capture) {
      mkdirSync(capture, { recursive: true });
      writeFileSync(join(capture, `door10-${target}s-metrics.json`), JSON.stringify(record, null, 2));
      if ([0, 384, 540, 720].includes(target)) writeFileSync(join(capture, `door10-${target}s-field.json`), JSON.stringify({ settings, field: { ...f,
        velocity: Array.from(f.velocity), fluid: Array.from(f.fluid), vorticity: Array.from(f.vorticity), faceVelocity: f.faceVelocity.map(a => Array.from(a)) } }));
    }
    assert.ok(f.velocity.every(Number.isFinite));
    assert.ok(f.diagnostics.maxDivergence < 1e-4);
    assert.ok(Math.abs(f.diagnostics.exhaustOutflow - expected) < 1e-10);
    assert.ok(Math.abs(f.diagnostics.doorNetInflow - expected) < 1e-6);
    assert.ok(Math.abs(f.diagnostics.boundaryNetInflow - expected) < 1e-6);
    // Regression bounds, not measured/calibrated room velocities.
    assert.ok(f.metrics.meanSpeed < 0.05, `room ${f.metrics.meanSpeed} at ${target}s`);
    assert.ok(exteriorSpeed < 0.01, `exterior ${exteriorSpeed} at ${target}s`);
    assert.ok(f.diagnostics.maxSpeed < 1, `peak ${f.diagnostics.maxSpeed} at ${target}s`);
    const o = f.exhaustOpening!, x = (o.xMin + o.xMax) / 2, z = (o.zMin + o.zMax) / 2;
    assert.ok(sampleVelocity(f, x, HEIGHT, z, [0, 0, 0])[1] > 0.09);
    let position: [number, number, number] = [x, HEIGHT - 0.1, z], exited = false;
    for (let step = 0; step < 200 && !exited; step++) {
      const moved = advanceParticle(f, position, 0.04);
      assert.equal(moved.blocked, false); position = moved.position; exited = moved.exited;
    }
    assert.ok(exited, `outlet trajectory at ${target}s`);
    t.diagnostic(JSON.stringify(record));
  }
});
