import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, isExhaust, isFluid, isFluidSegment, sampleVelocity } from '../src/simulation/model.ts';
import type { FlowField } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';
import { streamlineSeeds, traceStreamline } from '../src/scene/streamlines.ts';

function analytic(velocityAt: (x: number, y: number, z: number) => number[]): FlowField {
  const n = 24, h = 0.1, size = n ** 3;
  const faceVelocity: FlowField['faceVelocity'] = [new Float32Array(size), new Float32Array(size), new Float32Array(size)];
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    for (let axis = 0; axis < 3; axis++) faceVelocity[axis][i + n * (j + n * k)] = velocityAt(
      -1.2 + (i + 0.5 + (axis === 0 ? 0.5 : 0)) * h,
      (j + 0.5 + (axis === 1 ? 0.5 : 0)) * h,
      -1.2 + (k + 0.5 + (axis === 2 ? 0.5 : 0)) * h)[axis];
  }
  return { nx: n, ny: n, nz: n, h, origin: [-1.2, 0, -1.2], fluid: new Uint8Array(size).fill(1),
    velocity: new Float32Array(size * 3), faceVelocity, vorticity: new Float32Array(size), time: 0, exhaustCells: [], exhaustOpening: null,
    diagnostics: { doorNetInflow: 0, boundaryNetInflow: 0, exhaustOutflow: 0, maxDivergence: 0, maxSpeed: 0, kineticEnergy: 0 },
    metrics: { meanSpeed: 0, clothingSpeed: 0, airChanges: 0, exhaust: 0, stagnant: 0, residual: 0, iterations: 0, meanVorticity: 0 } };
}

test('弱い一様流も長い直線として描き、頂点順序は下流を向く', () => {
  const field = analytic(() => [0.0002, 0.0001, 0]);
  const path = traceStreamline(field, [0, 1.1, 0], 1.2);
  assert.ok(path.length > 30);
  assert.ok(path.at(-1)!.position[0] - path[0].position[0] > 1);
  for (let i = 1; i < path.length; i++) {
    const [x, y, z] = path[i].position;
    assert.ok(x > path[i - 1].position[0]);
    assert.ok(Math.abs(y - 1.1 - x / 2) < 1e-5);
    assert.equal(z, 0);
    assert.ok(Math.abs(path[i].speed - Math.hypot(0.0002, 0.0001)) < 1e-9);
  }
});

test('回転する解析場では半径を保ち、静止場に架空の循環を作らない', () => {
  const path = traceStreamline(analytic((x, _y, z) => [-z, 0, x]), [0.5, 1, 0], 5);
  assert.ok(path.length > 100);
  for (const { position: [x, y, z] } of path) {
    assert.ok(Math.abs(Math.hypot(x, z) - 0.5) < 0.002);
    assert.equal(y, 1);
  }
  assert.equal(traceStreamline(analytic(() => [0, 0, 0]), [0, 1, 0]).length, 1);
});

test('端点と中点が空気でも、固体の角を横切る線分は通さない', () => {
  const field = analytic(() => [1, 0, 0]);
  field.fluid[12 + 24 * (10 + 24 * 12)] = 0;
  const a = [-0.027, 1.05, 0.009], b = [0.005, 1.05, -0.001];
  assert.ok(isFluid(field, ...a as [number, number, number]));
  assert.ok(isFluid(field, ...b as [number, number, number]));
  assert.ok(isFluid(field, (a[0] + b[0]) / 2, 1.05, (a[2] + b[2]) / 2));
  assert.equal(isFluidSegment(field, a, b), false);
  assert.equal(isFluidSegment(field, [-0.1, 1, -0.1], [-0.05, 1, -0.1]), true);
});

test('表示用の補間も壁・床・天井を貫通せず、排気口だけを出口として扱う', () => {
  const sim = new TransientFlow({ ...DEFAULT_SETTINGS, clothes: 3, door: 5, fan: false });
  const field = sim.snapshot(), out = [0, 0, 0];
  const probes: [number, number, number, number][] = [
    [-0.9, 1, 0.5, 0], [0.9, 1, 0.5, 0], [0.4, 1, -1.35, 2], [0.3, 1, 1.35, 2], [0.5, 0, 0.5, 1], [0.5, 2.25, 0, 1]];
  for (const [x, y, z, axis] of probes) assert.ok(Math.abs(sampleVelocity(field, x, y, z, out)[axis]) < 1e-10);
  assert.equal(isExhaust(field, 0.5, 2.22, -0.88), false);
  assert.equal(isExhaust(field, 0.5, 2.25, -0.88), true);
  assert.equal(isExhaust(field, -0.5, 2.22, 0.5), false);
  field.faceVelocity[0].fill(10);
  assert.ok(sim.velocity[0].every(v => v !== 10), 'snapshot must not alias the running solver');
});

test('衣類3枚・戸5%・送風なしの流線は有限で、壁や浴槽を横切らない', () => {
  const settings = { ...DEFAULT_SETTINGS, clothes: 3, door: 5, fan: false };
  const field = new TransientFlow(settings).snapshot();
  let count = 0, long = 0;
  for (const seed of streamlineSeeds(settings)) {
    const path = traceStreamline(field, seed);
    if (path.length > 1) count++;
    if (path.length > 50) long++;
    for (let i = 1; i < path.length; i++) {
      assert.ok(path[i].position.every(Number.isFinite));
      assert.ok(isFluidSegment(field, path[i - 1].position, path[i].position));
    }
  }
  assert.ok(count > 40);
  assert.ok(long > 20, 'weak flow must be visible without waiting for particle history');
});
