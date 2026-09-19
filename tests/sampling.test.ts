import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, isFluid, isFluidSegment, sampleVelocity } from '../src/simulation/model.ts';
import type { FlowField } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';
import { flowVectors, particleSeed, particleSeedCells, uniformFlowSeeds, VECTOR_SPACING, STREAMLINE_SPACING } from '../src/scene/sampling.ts';
import { streamlineSeeds } from '../src/scene/streamlines.ts';

function constantField(speed: number): FlowField {
  const n = 32, count = n ** 3;
  return { nx: n, ny: n, nz: n, h: 0.2, origin: [-3.2, 0, -2], time: 0,
    velocity: new Float32Array(count * 3), fluid: new Uint8Array(count).fill(1), vorticity: new Float32Array(count),
    faceVelocity: [new Float32Array(count).fill(speed), new Float32Array(count), new Float32Array(count)],
    exhaustCells: [], exhaustOpening: null,
    diagnostics: { doorNetInflow: 0, boundaryNetInflow: 0, exhaustOutflow: 0, maxDivergence: 0, maxSpeed: Math.abs(speed), kineticEnergy: 0 },
    metrics: { meanSpeed: Math.abs(speed), clothingSpeed: 0, airChanges: 0, exhaust: 0, stagnant: 0, residual: 0, iterations: 0, meanVorticity: 0 } };
}

test('両サイズの矢印・流線は全域の等間隔格子で、給排気口の追加点を持たない', () => {
  for (const size of [3, 4.5] as const) {
    const settings = { ...DEFAULT_SETTINGS, size };
    for (const [spacing, positions] of [[VECTOR_SPACING, uniformFlowSeeds(settings, VECTOR_SPACING)],
      [STREAMLINE_SPACING, streamlineSeeds(settings)]] as const) {
      const axes = [0, 1, 2].map(axis => [...new Set(positions.map(p => p[axis]))].sort((a, b) => a - b));
      assert.equal(new Set(positions.map(p => p.join(','))).size, positions.length);
      assert.equal(positions.length, axes.reduce((count, values) => count * values.length, 1), 'complete Cartesian grid');
      for (const values of axes) for (let i = 1; i < values.length; i++) assert.ok(Math.abs(values[i] - values[i - 1] - spacing) < 1e-9);
      assert.ok(axes[0][0] < -0.5 && axes[0].at(-1)! > 0.5);
      assert.ok(axes[1][0] < 0.3 && axes[1].at(-1)! > 1.9);
      assert.ok(axes[2][0] < -1 && axes[2].at(-1)! > 2.7);
    }
    assert.deepEqual(uniformFlowSeeds(settings, VECTOR_SPACING), uniformFlowSeeds({ ...settings, fan: false, door: 0, clothes: 0 }, VECTOR_SPACING));
  }
});

test('無風・微風・強風で観測点を増減せず、方向と実風速を保持する', () => {
  const seeds = uniformFlowSeeds(DEFAULT_SETTINGS, VECTOR_SPACING);
  const still = flowVectors(constantField(0), seeds), weak = flowVectors(constantField(1e-5), seeds);
  const strong = flowVectors(constantField(0.5), seeds), reverse = flowVectors(constantField(-0.5), seeds);
  for (const vectors of [still, weak, strong, reverse]) assert.deepEqual(vectors.map(v => v.position), seeds);
  still.forEach(v => { assert.equal(v.speed, 0); assert.deepEqual(v.end, v.position); });
  weak.forEach((v, i) => {
    assert.ok(Math.abs(v.speed - 1e-5) < 1e-10);
    assert.ok(v.end[0] > v.position[0] + 0.1, 'weak wind direction stays legible');
    assert.equal(v.end[1], v.position[1]); assert.equal(v.end[2], v.position[2]);
    assert.ok(strong[i].end[0] - strong[i].position[0] > v.end[0] - v.position[0]);
    assert.ok(reverse[i].end[0] < reverse[i].position[0]);
  });
});

test('実計算場の矢印は浴槽や壁を貫通せず、表示が速度場を変更しない', () => {
  for (const size of [3, 4.5] as const) for (const door of [0, 25]) {
    const settings = { ...DEFAULT_SETTINGS, size, clothes: 0, door, fan: false };
    const field = new TransientFlow(settings).snapshot(), before = field.faceVelocity.map(a => a.slice());
    const seeds = uniformFlowSeeds(settings, VECTOR_SPACING), vectors = flowVectors(field, seeds);
    assert.equal(vectors.length, seeds.filter(p => isFluid(field, ...p)).length);
    for (const v of vectors) {
      assert.ok(v.end.every(Number.isFinite));
      assert.ok(isFluidSegment(field, v.position, v.end));
      assert.equal(v.speed, Math.hypot(...sampleVelocity(field, ...v.position, [0, 0, 0])));
    }
    field.faceVelocity.forEach((a, i) => assert.deepEqual(a, before[i]));
  }
});

test('粒子の初期配置と再配置は等体積の空気セルを等しく選び、換気口を優遇しない', () => {
  for (const size of [3, 4.5] as const) {
    const settings = { ...DEFAULT_SETTINGS, size, clothes: 0, door: 25, fan: false };
    const field = new TransientFlow(settings).snapshot(), cells = particleSeedCells(field, settings);
    const selected = new Set<number>();
    for (let n = 0; n < cells.length; n++) {
      const p = particleSeed(field, cells, (n + 0.5) / cells.length, () => 0.5);
      assert.ok(isFluid(field, ...p));
      const i = Math.floor((p[0] - field.origin[0]) / field.h), j = Math.floor(p[1] / field.h), k = Math.floor((p[2] - field.origin[2]) / field.h);
      selected.add(i + field.nx * (j + field.ny * k));
    }
    assert.equal(selected.size, cells.length, 'each equal-volume cell selected once');
    assert.deepEqual(selected, new Set(cells));
    assert.ok(field.exhaustCells.every(q => selected.has(q)), 'outlet region is included once, not excluded');
    assert.ok([...selected].some(q => Math.floor(q / (field.nx * field.ny)) > 26), 'exterior included');
  }
});
