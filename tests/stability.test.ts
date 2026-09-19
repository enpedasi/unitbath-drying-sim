import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransientFlow } from '../src/simulation/transient.ts';
import { DEFAULT_SETTINGS } from '../src/simulation/model.ts';
import type { Settings } from '../src/simulation/model.ts';

const cases: { name: string; settings: Partial<Settings>; changeFan?: boolean }[] = [
  { name: '初期設定（旧実装は約24.8秒で発散）', settings: {} },
  { name: '戸5%・強風（旧実装は約10.5秒で発散）', settings: { door: 5, fanSpeed: 3 } },
  { name: '4.5畳・衣類12枚・全開・途中で送風停止と方向変更', settings: { size: 4.5, clothes: 12, door: 100, fanSpeed: 3, fanYaw: 40, fanTilt: 45 }, changeFan: true },
  { name: '4.5畳・衣類なし・全閉・正面から強風', settings: { size: 4.5, clothes: 0, door: 0, fanSpeed: 3, fanYaw: 0, fanTilt: 0 } },
];

for (const scenario of cases) test(`60秒の連続計算: ${scenario.name}`, t => {
  const sim = new TransientFlow({ ...DEFAULT_SETTINGS, ...scenario.settings });
  const changes = scenario.changeFan ? [
    { at: 20, settings: { fan: false } },
    { at: 30, settings: { fan: true, fanYaw: -40, fanTilt: 0 } },
    { at: 45, settings: { fanYaw: 0, fanTilt: 45 } },
  ] : [];
  let change = 0, step = 0, maxSpeed = 0, maxDivergence = 0, maxEnergy = 0;
  while (sim.time < 60 - 1e-9) {
    if (change < changes.length && sim.time >= changes[change].at - 1e-9) {
      sim.setFan({ ...sim.settings, ...changes[change].settings }); change++;
    }
    // Match Worker-sized batches; also exercise the variable durations produced
    // by fast/slow animation frames when settings are changed while playing.
    const batch = scenario.changeFan ? [0.12, 0.049, 0.083, 0.067][step++ % 4] : 0.12;
    sim.advance(Math.min(batch, 60 - sim.time, change < changes.length ? changes[change].at - sim.time : Infinity));
    const f = sim.snapshot(), expectedFlow = f.metrics.exhaust / 3600;
    assert.ok(f.velocity.every(Number.isFinite), `non-finite velocity at ${f.time}s`);
    assert.ok(f.diagnostics.maxSpeed < 8, `unbounded speed ${f.diagnostics.maxSpeed} at ${f.time}s`);
    assert.ok(f.diagnostics.maxDivergence < 1e-4, `divergence at ${f.time}s`);
    assert.ok(Math.abs(f.diagnostics.doorNetInflow - expectedFlow) < 1e-6, `door balance at ${f.time}s`);
    assert.ok(Math.abs(f.diagnostics.boundaryNetInflow - expectedFlow) < 1e-6, `exterior balance at ${f.time}s`);
    assert.ok(Math.abs(f.diagnostics.exhaustOutflow - expectedFlow) < 1e-10, `outlet balance at ${f.time}s`);
    assert.ok(Number.isFinite(f.diagnostics.kineticEnergy));
    maxSpeed = Math.max(maxSpeed, f.diagnostics.maxSpeed);
    maxDivergence = Math.max(maxDivergence, f.diagnostics.maxDivergence);
    maxEnergy = Math.max(maxEnergy, f.diagnostics.kineticEnergy);
  }
  assert.ok(Math.abs(sim.time - 60) < 1e-9);
  assert.equal(change, changes.length);
  t.diagnostic(JSON.stringify({ settings: scenario.settings, maxSpeed, maxDivergence, maxEnergy }));
});
