import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, clothingPositions, fanDirection, isFluid, roomWidth, sampleVelocity } from '../src/simulation/model.ts';
import { TransientFlow, curlMagnitude, interpolate, interpolateFromAmbient } from '../src/simulation/transient.ts';
import { FlowSolverError } from '../src/simulation/errors.ts';
import type { Settings } from '../src/simulation/model.ts';

function create(changes: Partial<Settings> = {}) { return new TransientFlow({ ...DEFAULT_SETTINGS, ...changes }); }
let developed: TransientFlow | undefined;
function warmed() { if (!developed) { developed = create(); developed.advance(6); } return developed; }

test('両サイズ・戸の全閉/全開・送風ON/OFFで流量保存と安定性を保つ', () => {
  for (const size of [3, 4.5] as const) for (const door of [0, 100]) for (const fan of [false, true]) {
    const sim = create({ size, door, fan, fanSpeed: 3, clothes: door === 0 ? 0 : 12 }); sim.advance(0.24);
    const f = sim.snapshot(), expected = f.metrics.exhaust / 3600;
    assert.ok(f.velocity.every(Number.isFinite));
    assert.ok(f.diagnostics.maxDivergence < 1e-4, `divergence ${f.diagnostics.maxDivergence}`);
    assert.ok(Math.abs(f.diagnostics.doorNetInflow - expected) < 1e-6, 'door volume balance');
    assert.ok(Math.abs(f.diagnostics.boundaryNetInflow - expected) < 1e-6, 'exterior volume balance');
    assert.ok(f.diagnostics.maxSpeed < 8);
    assert.ok(Math.abs(f.time - 0.24) < 1e-9);
  }
});

test('固体境界の面速度と浴槽内の速度はゼロのまま', () => {
  const sim = warmed(), f = sim.snapshot();
  for (let axis = 0; axis < 3; axis++) sim.area[axis].forEach((area, q) => { if (!area) assert.equal(sim.velocity[axis][q], 0); });
  f.fluid.forEach((fluid, q) => { if (!fluid) assert.deepEqual(Array.from(f.velocity.subarray(q * 3, q * 3 + 3)), [0, 0, 0]); });
  assert.equal(isFluid(f, -0.94, 1, 0), false);
  assert.equal(isFluid(f, -0.55, 0.3, -0.7), false);
  assert.equal(isFluid(f, 0.5, 1, 0.5), true);
});

test('送風の運動量が時間をかけて室内に到達し、渦度が発達する', () => {
  const sim = create(), initial = sim.snapshot(); sim.advance(0.4); const early = sim.snapshot();
  const late = warmed().snapshot();
  const ventilation = create({ fan: false }); ventilation.advance(late.time);
  assert.ok(late.metrics.meanSpeed > early.metrics.meanSpeed * 3);
  assert.ok(late.metrics.meanVorticity > initial.metrics.meanVorticity * 5);
  // Separate fan arrival from ventilation and clothing drag. The precise
  // early/late multiplier depends on the advection method's numerical diffusion.
  assert.ok(late.metrics.clothingSpeed > early.metrics.clothingSpeed);
  assert.ok(late.metrics.clothingSpeed > ventilation.snapshot().metrics.clothingSpeed);
  assert.ok(late.metrics.stagnant < early.metrics.stagnant);
  assert.equal(late.metrics.exhaust, early.metrics.exhaust);
});

test('ファンを止めた瞬間に流れをリセットせず、慣性を保って減衰する', () => {
  const source = warmed(), sim = create();
  for (let a = 0; a < 3; a++) sim.velocity[a].set(source.velocity[a]);
  const before = sim.snapshot(); sim.setFan({ ...DEFAULT_SETTINGS, fan: false });
  assert.deepEqual(sim.snapshot().velocity, before.velocity);
  sim.advance(1.5); const after = sim.snapshot();
  assert.ok(after.diagnostics.kineticEnergy > before.diagnostics.kineticEnergy * 0.1);
  assert.ok(after.diagnostics.kineticEnergy < before.diagnostics.kineticEnergy);
  assert.ok(after.metrics.meanVorticity > 0.03);
});

test('送風方向変更は同じ初期速度場から異なる流れを作る', () => {
  const a = create(), b = create(), source = warmed();
  for (let d = 0; d < 3; d++) { a.velocity[d].set(source.velocity[d]); b.velocity[d].set(source.velocity[d]); }
  a.setFan({ ...DEFAULT_SETTINGS, fanYaw: -35, fanTilt: 40 }); b.setFan({ ...DEFAULT_SETTINGS, fanYaw: 35, fanTilt: 0 });
  a.advance(0.5); b.advance(0.5);
  const av = a.snapshot(), bv = b.snapshot();
  let difference = 0; av.velocity.forEach((v, i) => { difference += (v - bv.velocity[i]) ** 2; });
  assert.ok(difference > 1);
  assert.ok(av.diagnostics.maxDivergence < 1e-4 && bv.diagnostics.maxDivergence < 1e-4);
});

test('閉じた戸は給気隙間を残し、衣類の有無が速度場に反映される', () => {
  const closed = create({ door: 0 }), opened = create({ door: 100 }), empty = create({ clothes: 0 });
  assert.ok(closed.snapshot().metrics.exhaust > 0);
  assert.equal(isFluid(closed.snapshot(), 0.1, 1, 1.4), false);
  assert.equal(isFluid(opened.snapshot(), 0.1, 1, 1.4), true);
  assert.ok(opened.snapshot().metrics.airChanges > closed.snapshot().metrics.airChanges);
  empty.advance(3);
  const crowded = create({ clothes: 12 }); crowded.advance(3);
  assert.notDeepEqual(empty.snapshot().velocity, crowded.snapshot().velocity);
  assert.equal(empty.snapshot().metrics.clothingSpeed, 0);
});

test('時間刻みを半分にしても同じ時間の速度場が大きく変わらない', () => {
  const a = create(), b = create(); a.advance(0.4);
  for (let i = 0; i < 20; i++) b.advance(0.02);
  const av = a.snapshot(), bv = b.snapshot(); let error = 0, norm = 0;
  av.velocity.forEach((v, i) => { error += (v - bv.velocity[i]) ** 2; norm += bv.velocity[i] ** 2; });
  assert.ok(Math.sqrt(error / norm) < 0.2, `relative timestep error ${Math.sqrt(error / norm)}`);
});

test('解析解: 一様流の渦度は0、剛体回転の渦度は角速度の2倍', () => {
  const n = 7, h = 0.1, velocity = new Float32Array(n ** 3 * 3), fluid = new Uint8Array(n ** 3).fill(1);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const q = i + n * (j + n * k); velocity[q * 3] = -2 * j * h; velocity[q * 3 + 1] = 2 * i * h;
  }
  const curl = curlMagnitude(velocity, fluid, n, n, n, h);
  assert.ok(Math.abs(curl[3 + n * (3 + n * 3)] - 4) < 1e-5);
  for (let q = 0; q < n ** 3; q++) { velocity[q * 3] = 2; velocity[q * 3 + 1] = 0; }
  assert.ok(curlMagnitude(velocity, fluid, n, n, n, h).every(v => v === 0));
});

test('線形場の補間・配置の端点・送風方向の正規化', () => {
  const a = new Float64Array(5 ** 3);
  for (let k = 0; k < 5; k++) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) a[i + 5 * (j + 5 * k)] = i + 2 * j - 3 * k;
  assert.ok(Math.abs(interpolate(a, 5, 5, 5, 1.2, 2.3, 1.4) - 1.6) < 1e-9);
  assert.equal(roomWidth(3) * 2.7, 4.86);
  assert.equal(clothingPositions({ ...DEFAULT_SETTINGS, clothes: 0 }).length, 0);
  assert.deepEqual(clothingPositions({ ...DEFAULT_SETTINGS, clothes: 1 }), [0]);
  assert.equal(clothingPositions({ ...DEFAULT_SETTINGS, clothes: 12 }).length, 12);
  assert.ok(Math.abs(Math.hypot(...fanDirection(DEFAULT_SETTINGS)) - 1) < 1e-12);
  assert.deepEqual(sampleVelocity(warmed().snapshot(), 100, 100, 100, [0, 0, 0]), [0, 0, 0]);
});

test('外部から入る運動量は静止空気と補間し、境界の速度を再流入させない', () => {
  const uniform = new Float64Array(5 ** 3).fill(2);
  assert.equal(interpolateFromAmbient(uniform, 5, 5, 5, 2, 2, 2), 2);
  for (const x of [-0.5, 4.5]) assert.equal(interpolateFromAmbient(uniform, 5, 5, 5, x, 2, 2), 1);
  for (const z of [-0.5, 4.5]) assert.equal(interpolateFromAmbient(uniform, 5, 5, 5, 2, 2, z), 1);
  assert.equal(interpolateFromAmbient(uniform, 5, 5, 5, -1, 2, 2), 0);
  assert.equal(interpolateFromAmbient(uniform, 5, 5, 5, 2, 2, 5), 0);
});

test('速度上限超過と非有限値を区別して、計算停止の診断を残す', () => {
  for (const badValue of [1000, NaN]) {
    const sim = create(), q = 7 + sim.nx * (10 + sim.ny * 32);
    sim.velocity[0][q] = badValue;
    assert.throws(() => sim.project(), (error: unknown) => {
      assert.ok(error instanceof FlowSolverError);
      assert.equal(error.failure.code, Number.isFinite(badValue) ? 'speed-limit' : 'non-finite');
      assert.deepEqual(error.failure.settings, DEFAULT_SETTINGS);
      if (Number.isFinite(badValue)) assert.ok(error.failure.diagnostics!.maxSpeed! > 50);
      else assert.equal(error.failure.diagnostics!.maxSpeed, null);
      return true;
    });
  }
});
