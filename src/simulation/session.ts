import type { FlowField, Settings } from './model';
import { sameGeometry } from './model';
import { createFlowFailure } from './errors';
import type { FlowFailure } from './errors';

export type FlowRequest = { type: 'init' | 'fan'; settings: Settings } | { type: 'advance'; duration: number };
export type FlowResponse = { field: FlowField; error?: never } | { error: FlowFailure; field?: never };
export interface WorkerPort {
  onmessage: ((event: MessageEvent<FlowResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: FlowRequest): void;
  terminate(): void;
}

/** Single-flight, frame-driven worker. It neither queues unbounded time nor
 * advances the visible result while paused. Geometry changes replace it. */
export class FlowSession {
  private busy = true;
  private playing = true;
  private speed = 1;
  private accumulated = 0;
  private disposed = false;
  private initialized = false;
  private buffered: FlowField | null = null;
  private time = 0;
  constructor(private worker: WorkerPort, private settings: Settings, private publish: (field: FlowField) => void, private fail: (error: FlowFailure) => void) {
    this.settings = { ...settings };
    worker.onmessage = event => {
      if (this.disposed) return;
      this.busy = false;
      if (event.data.error) { this.stopWithError(event.data.error); return; }
      const field = event.data.field!;
      this.time = field.time;
      if (!this.initialized || this.playing) this.publish(field);
      else this.buffered = field;
      this.initialized = true;
    };
    worker.onerror = event => {
      this.stopWithError(createFlowFailure('worker-error', event.message, this.settings, this.time));
    };
    this.send({ type: 'init', settings: this.settings });
  }
  setPlayback(playing: boolean, speed: number) {
    this.playing = playing; this.speed = speed;
    if (!playing) this.accumulated = 0;
    if (playing && this.buffered) { this.publish(this.buffered); this.buffered = null; }
  }
  setFan(settings: Settings) {
    if (!this.disposed && sameGeometry(this.settings, settings)) {
      this.settings = { ...settings };
      this.send({ type: 'fan', settings: this.settings });
    }
  }
  tick(dt: number) {
    if (this.disposed || !this.playing || !this.initialized) return;
    this.accumulated = Math.min(0.12, this.accumulated + Math.max(0, Math.min(dt, 0.25)) * this.speed);
    if (!this.busy && this.accumulated >= 0.04) {
      this.busy = true; this.send({ type: 'advance', duration: this.accumulated }); this.accumulated = 0;
    }
  }
  private send(message: FlowRequest) {
    try { this.worker.postMessage(message); }
    catch (error) { this.stopWithError(createFlowFailure('worker-error', String(error), this.settings, this.time)); }
  }
  private stopWithError(error: FlowFailure) {
    if (this.disposed) return;
    this.dispose();
    this.fail(error);
  }
  dispose() { this.disposed = true; this.buffered = null; this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); }
}
