import type { Settings } from './model';

export type FlowFailureCode = 'non-finite' | 'speed-limit' | 'pressure-residual' | 'worker-error' | 'unexpected';
export interface FlowFailure {
  code: FlowFailureCode;
  message: string;
  occurredAt: string;
  time: number;
  settings: Settings | null;
  diagnostics: { maxSpeed: number | null; maxDivergence: number | null; iterations: number } | null;
}

/** Plain, cloneable data survives the Worker boundary and JSON downloads.
 * null explicitly marks a non-finite diagnostic instead of silently losing it. */
export function createFlowFailure(code: FlowFailureCode, message: string, settings: Settings | null, time: number,
  diagnostics?: { maxSpeed: number; maxDivergence: number; iterations: number }): FlowFailure {
  return {
    code, message, occurredAt: new Date().toISOString(), time, settings: settings ? { ...settings } : null,
    diagnostics: diagnostics ? {
      maxSpeed: Number.isFinite(diagnostics.maxSpeed) ? diagnostics.maxSpeed : null,
      maxDivergence: Number.isFinite(diagnostics.maxDivergence) ? diagnostics.maxDivergence : null,
      iterations: diagnostics.iterations,
    } : null,
  };
}

export class FlowSolverError extends Error {
  constructor(readonly failure: FlowFailure) { super(failure.message); this.name = 'FlowSolverError'; }
}

export function flowFailureMessage(failure: FlowFailure): string {
  switch (failure.code) {
    case 'non-finite': return '計算値が不正になったため停止しました。再試行すると最初から計算します。';
    case 'speed-limit': return '流速が異常に大きくなったため計算を停止しました。再試行すると最初から計算します。';
    case 'pressure-residual': return '空気の流量を補正できなかったため停止しました。再試行すると最初から計算します。';
    case 'worker-error': return '計算処理を実行できませんでした。再試行してください。';
    case 'unexpected': return '流れの計算中に予期しないエラーが発生しました。再試行してください。';
  }
}
