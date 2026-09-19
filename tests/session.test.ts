import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowSession } from '../src/simulation/session.ts';
import type { FlowRequest, FlowResponse, WorkerPort } from '../src/simulation/session.ts';
import { DEFAULT_SETTINGS } from '../src/simulation/model.ts';
import type { FlowField } from '../src/simulation/model.ts';
import { createFlowFailure } from '../src/simulation/errors.ts';
import type { FlowFailure } from '../src/simulation/errors.ts';

class FakeWorker implements WorkerPort {
  onmessage: WorkerPort['onmessage'] = null;
  onerror: WorkerPort['onerror'] = null;
  requests: FlowRequest[] = [];
  terminated = false;
  postMessage(request: FlowRequest) { this.requests.push(request); }
  terminate() { this.terminated = true; }
  reply(time: number) { this.onmessage?.({ data: { field: { time } as FlowField } } as MessageEvent<FlowResponse>); }
}

test('一時停止中は進行要求を送らず、処理中だった結果も再開まで表示しない', () => {
  const worker = new FakeWorker(), published: number[] = [];
  const session = new FlowSession(worker, DEFAULT_SETTINGS, f => published.push(f.time), assert.fail);
  worker.reply(0); session.tick(0.04);
  assert.equal(worker.requests.length, 2);
  session.setPlayback(false, 1); worker.reply(0.04);
  for (let i = 0; i < 10; i++) session.tick(0.05);
  assert.deepEqual(published, [0]); assert.equal(worker.requests.length, 2);
  session.setPlayback(true, 1); assert.deepEqual(published, [0, 0.04]);
  session.tick(0.04); assert.equal(worker.requests.length, 3);
});

test('遅いWorkerに処理を積み上げず、設定変更時に終了したWorkerの結果を無視する', () => {
  const worker = new FakeWorker(), published: number[] = [];
  const session = new FlowSession(worker, DEFAULT_SETTINGS, f => published.push(f.time), assert.fail);
  worker.reply(0); session.tick(0.04);
  for (let i = 0; i < 100; i++) session.tick(0.05);
  assert.equal(worker.requests.length, 2, 'one in-flight advance');
  const oldHandler = worker.onmessage!;
  session.dispose();
  oldHandler({ data: { field: { time: 10 } as FlowField } } as MessageEvent<FlowResponse>);
  assert.deepEqual(published, [0]); assert.equal(worker.terminated, true);
});

test('送風だけの変更は初期化せず、形状変更を古いWorkerに送らない', () => {
  const worker = new FakeWorker();
  const session = new FlowSession(worker, DEFAULT_SETTINGS, () => {}, assert.fail);
  worker.reply(0);
  session.setFan({ ...DEFAULT_SETTINGS, fan: false });
  session.setFan({ ...DEFAULT_SETTINGS, fanYaw: 35, fanSpeed: 2.5 });
  session.setFan({ ...DEFAULT_SETTINGS, size: 4.5 });
  assert.deepEqual(worker.requests.map(r => r.type), ['init', 'fan', 'fan']);
});

test('一時停止したまま初期化しても、初期画面を描画して計算時間0を保つ', () => {
  const worker = new FakeWorker(), published: number[] = [];
  const session = new FlowSession(worker, DEFAULT_SETTINGS, f => published.push(f.time), assert.fail);
  session.setPlayback(false, 2); worker.reply(0); session.tick(0.04);
  assert.deepEqual(published, [0]); assert.equal(worker.requests.length, 1);
});

test('Workerの計算失敗時にループを止め、エラーを一度だけ通知する', () => {
  const worker = new FakeWorker(), errors: FlowFailure[] = [];
  const session = new FlowSession(worker, DEFAULT_SETTINGS, () => assert.fail('must not publish'), e => errors.push(e));
  const failure = createFlowFailure('speed-limit', 'speed exceeded', DEFAULT_SETTINGS, 10.52,
    { maxSpeed: 50.06, maxDivergence: 8.9e-6, iterations: 24 });
  const receive = worker.onmessage!;
  receive({ data: { error: failure } } as MessageEvent<FlowResponse>);
  session.tick(0.04); worker.reply(1);
  receive({ data: { error: failure } } as MessageEvent<FlowResponse>);
  assert.deepEqual(errors, [failure]); assert.equal(worker.terminated, true);
  assert.equal(worker.requests.length, 1);
});

test('Worker実行障害には直前の計算時刻と変更後の送風条件を添える', () => {
  const worker = new FakeWorker(), errors: FlowFailure[] = [];
  const session = new FlowSession(worker, DEFAULT_SETTINGS, () => {}, e => errors.push(e));
  worker.reply(12.3);
  const settings = { ...DEFAULT_SETTINGS, fanSpeed: 2.5, fanYaw: 35 };
  session.setFan(settings);
  worker.onerror!({ message: 'Worker crashed' } as ErrorEvent);
  settings.fanSpeed = 1;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'worker-error');
  assert.equal(errors[0].time, 12.3);
  assert.equal(errors[0].settings?.fanSpeed, 2.5);
  assert.equal(errors[0].message, 'Worker crashed');
  assert.equal(worker.terminated, true);
});

test('Workerへの送信自体が失敗してもエラーを報告し、処理中のまま残さない', () => {
  const worker = new FakeWorker(), errors: FlowFailure[] = [];
  worker.postMessage = () => { throw new Error('postMessage failed'); };
  const session = new FlowSession(worker, DEFAULT_SETTINGS, () => assert.fail('must not publish'), e => errors.push(e));
  session.tick(1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'worker-error');
  assert.match(errors[0].message, /postMessage failed/);
  assert.deepEqual(errors[0].settings, DEFAULT_SETTINGS);
  assert.equal(worker.terminated, true);
});

test('診断の種別と発生時の条件がWorker転送・JSON保存で失われない', () => {
  for (const code of ['non-finite', 'speed-limit', 'pressure-residual', 'unexpected'] as const) {
    const settings = { ...DEFAULT_SETTINGS, door: 5 };
    const failure = createFlowFailure(code, 'diagnostic', settings, 10.52,
      { maxSpeed: code === 'non-finite' ? NaN : 50.06, maxDivergence: 0.02, iterations: 450 });
    settings.door = 100;
    const transferred = JSON.parse(JSON.stringify(structuredClone(failure)));
    assert.deepEqual(transferred, failure);
    assert.equal(transferred.settings.door, 5);
    assert.equal(transferred.code, code);
    assert.equal(transferred.diagnostics.maxSpeed, code === 'non-finite' ? null : 50.06);
  }
});
