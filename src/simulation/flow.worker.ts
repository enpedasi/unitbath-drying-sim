import { TransientFlow } from './transient';
import type { FlowRequest, FlowResponse } from './session';
import type { Settings } from './model';
import { createFlowFailure, FlowSolverError } from './errors';
let simulation: TransientFlow | undefined;
let requestedSettings: Settings | null = null;
self.onmessage = (event: MessageEvent<FlowRequest>) => {
  try {
    const started = performance.now();
    const request = event.data;
    if (request.type === 'init' || request.type === 'fan') requestedSettings = { ...request.settings };
    if (request.type === 'init') simulation = new TransientFlow(request.settings);
    if (!simulation) throw new Error('Simulation not initialized');
    if (request.type === 'fan') { simulation.setFan(request.settings); return; }
    if (request.type === 'advance') simulation.advance(request.duration);
    const field = simulation.snapshot();
    field.computationMs = performance.now() - started;
    const response: FlowResponse = { field };
    self.postMessage(response, { transfer: [field.velocity.buffer, field.fluid.buffer, field.vorticity.buffer, ...field.faceVelocity.map(v => v.buffer)] });
  } catch (error) {
    const failure = error instanceof FlowSolverError ? error.failure
      : createFlowFailure('unexpected', String(error), requestedSettings, simulation?.time ?? 0);
    self.postMessage({ error: failure } satisfies FlowResponse);
  }
};
