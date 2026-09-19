import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';

test('衣類0枚・戸15%・送風OFFで6分24秒まで数値的な乱れが増幅しない', t => {
  const settings = { ...DEFAULT_SETTINGS, clothes: 0, door: 15, fan: false };
  const sim = new TransientFlow(settings);
  for (const target of [0, 60, 120, 180, 240, 300, 384]) {
    while (sim.time < target - 1e-9) sim.advance(Math.min(0.12, target - sim.time));
    const f = sim.snapshot(), expectedFlow = f.metrics.exhaust / 3600;
    assert.ok(f.velocity.every(Number.isFinite));
    assert.ok(f.diagnostics.maxDivergence < 1e-4);
    assert.ok(Math.abs(f.diagnostics.doorNetInflow - expectedFlow) < 1e-6);
    assert.ok(Math.abs(f.diagnostics.boundaryNetInflow - expectedFlow) < 1e-6);
    assert.ok(Math.abs(f.diagnostics.exhaustOutflow - expectedFlow) < 1e-10);
    let exteriorSpeed = 0, count = 0;
    for (let q = f.nx * f.ny * 26; q < f.fluid.length; q++) if (f.fluid[q]) {
      exteriorSpeed += Math.hypot(f.velocity[q * 3], f.velocity[q * 3 + 1], f.velocity[q * 3 + 2]); count++;
    }
    exteriorSpeed /= count;
    // Loose regression bounds for this fixed, exhaust-only scenario. These
    // detect the reported ~0.4 m/s room-wide numerical agitation; they are
    // not calibrated predictions or a velocity clamp in the solver.
    assert.ok(f.metrics.meanSpeed < 0.05, `room mean ${f.metrics.meanSpeed} at ${target}s`);
    assert.ok(exteriorSpeed < 0.01, `exterior mean ${exteriorSpeed} at ${target}s`);
    assert.ok(f.diagnostics.maxSpeed < 1, `peak ${f.diagnostics.maxSpeed} at ${target}s`);
    const record = { time: f.time, meanSpeed: f.metrics.meanSpeed, exteriorSpeed, diagnostics: f.diagnostics };
    t.diagnostic(JSON.stringify(record));
    // Optional artifacts for inspecting the same tested field in the browser.
    const capture = process.env.UBSIMU_CAPTURE_DIR;
    if (capture) {
      mkdirSync(capture, { recursive: true });
      writeFileSync(join(capture, `fixed-${target}s-metrics.json`), JSON.stringify(record, null, 2));
      if (target === 384) writeFileSync(join(capture, 'fixed-field.json'), JSON.stringify({ settings, field: { ...f,
        velocity: Array.from(f.velocity), fluid: Array.from(f.fluid), vorticity: Array.from(f.vorticity),
        faceVelocity: f.faceVelocity.map(a => Array.from(a)) } }));
    }
  }
});
