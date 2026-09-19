import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, isFluidSegment } from '../src/simulation/model.ts';
import { TransientFlow } from '../src/simulation/transient.ts';
import { flowVectors, uniformFlowSeeds, VECTOR_SPACING } from '../src/scene/sampling.ts';
import type { FlowVector, Position } from '../src/scene/sampling.ts';
import { VectorMotion, VECTOR_MOTION_SCALE } from '../src/scene/vectorMotion.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const distance = (a: Position, b: Position) => Math.hypot(...a.map((x, axis) => x - b[axis]));
const sample = (speed: number, length = 1, position: Position = [0, 0, 0]): FlowVector => ({
  position, end: [position[0] - length * 0.6, position[1] + length * 0.8, position[2]], speed, vorticity: 0,
});

test('移動距離は風速×共通表示倍率×計算時間で、ガイド長によらず風下へ進む', () => {
  for (const speed of [0.00001, 0.001, 0.02, 0.5]) for (const length of [0.1, 0.25]) {
    const motion = new VectorMotion(); motion.setSamples([sample(speed, length)]);
    const before = motion.arrow(0)!.end;
    motion.advance(0.001);
    const after = motion.arrow(0)!.end;
    near(distance(before, after), speed * VECTOR_MOTION_SCALE * 0.001);
    assert.ok(after[0] < before[0] && after[1] > before[1]);
    near(after[2], before[2]);
  }
});

test('停止中と無風は動かず、風速・着色用の値を更新しても位相を巻き戻さない', () => {
  const motion = new VectorMotion(); motion.setSamples([sample(0.01)]);
  motion.advance(0.2);
  const phase = motion.tracks[0].phase, end = motion.arrow(0)!.end;
  for (const dt of [0, -1, NaN, Infinity]) motion.advance(dt);
  assert.deepEqual(motion.arrow(0)!.end, end);
  motion.setSamples([{ ...sample(0.02), vorticity: 2 }]);
  assert.equal(motion.tracks[0].phase, phase);
  assert.deepEqual(motion.arrow(0)!.end, end);
  motion.advance(0.1);
  near(distance(end, motion.arrow(0)!.end), 0.02 * VECTOR_MOTION_SCALE * 0.1);
  motion.setSamples([sample(0)]);
  const stopped = motion.tracks[0].phase;
  motion.advance(100);
  assert.equal(motion.tracks[0].phase, stopped);
  assert.equal(motion.arrow(0), null);
  assert.equal(motion.tracks.length, 1, 'zero speed retains the observation point');
});

test('フレーム分割によらず同じ位置になり、再生倍率は計算時間を通じて一度だけ反映する', () => {
  const whole = new VectorMotion(), split = new VectorMotion();
  const samples = [sample(0.003), sample(2.4, 0.2, [0, 0, 1])];
  whole.setSamples(samples); split.setSamples(samples);
  whole.advance(2);
  for (let i = 0; i < 120; i++) split.advance(2 / 120);
  whole.tracks.forEach((t, i) => near(t.phase, split.tracks[i].phase));
  const moving = new VectorMotion(); moving.setSamples([sample(0.001)]);
  const start = moving.arrow(0)!.end;
  moving.advance(0.5); const halfSpeedDistance = distance(start, moving.arrow(0)!.end);
  moving.clear(); moving.setSamples([sample(0.001)]);
  moving.advance(2);
  near(distance(start, moving.arrow(0)!.end), halfSpeedDistance * 4);
});

test('繰り返しの前後で矢印を接続せず、初期位相が分散し、リセットで初期状態へ戻る', () => {
  const motion = new VectorMotion();
  const samples = Array.from({ length: 40 }, (_, i) => sample(0.01, 0.2, [0, 0, i]));
  motion.setSamples(samples);
  const initial = motion.tracks.map(t => t.phase);
  assert.equal(new Set(initial.map(p => Math.floor(p * 8))).size, 8);
  const period = 0.2 / (0.01 * VECTOR_MOTION_SCALE);
  motion.advance((1 - initial[0] - 0.0001) * period);
  assert.ok(motion.arrow(0)!.opacity < 0.001);
  motion.advance(0.0002 * period);
  const wrapped = motion.arrow(0)!;
  assert.ok(wrapped.opacity < 0.002);
  assert.ok(distance(wrapped.start, wrapped.end) < 0.001);
  motion.clear(); assert.equal(motion.tracks.length, 0);
  motion.setSamples(samples);
  assert.deepEqual(motion.tracks.map(t => t.phase), initial);
});

test('両サイズで矢印が動いても観測点の全域配置を保ち、浴槽・衣類・壁を貫通しない', () => {
  for (const size of [3, 4.5] as const) {
    const settings = { ...DEFAULT_SETTINGS, size, door: 15, clothes: 3, fan: false };
    const field = new TransientFlow(settings).snapshot();
    const before = field.faceVelocity.map(v => v.slice());
    const samples = flowVectors(field, uniformFlowSeeds(settings, VECTOR_SPACING));
    const motion = new VectorMotion(); motion.setSamples(samples);
    const origins = samples.map(s => s.position.slice());
    for (let frame = 0; frame < 80; frame++) {
      motion.advance(0.08);
      motion.tracks.forEach((track, i) => {
        assert.ok(track.phase >= 0 && track.phase < 1);
        const arrow = motion.arrow(i);
        if (!arrow) return;
        assert.ok(arrow.end.every(Number.isFinite));
        assert.ok(isFluidSegment(field, arrow.start, arrow.end));
        assert.ok(distance(track.sample.position, arrow.end) <= track.length + 1e-10);
      });
    }
    assert.deepEqual(motion.tracks.map(t => t.sample.position), origins);
    field.faceVelocity.forEach((v, i) => assert.deepEqual(v, before[i]));
  }
});
