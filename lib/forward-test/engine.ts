import type { DayTradeCandle } from '@/lib/daytrade/indicators';

export interface ForwardSignalInput {
  candle_open_time: string;
  entrada_referencia: number;
  stop_referencia: number;
  alvo_referencia: number;
  atr: number | null;
  status: string;
  entrada_preco: number | null;
}

export interface ForwardExecutionConfig {
  fee_rate_pct: number;
  slippage_pct: number;
  max_next_open_distance_atr: number;
}

export interface ForwardResolution {
  status: 'aguardando_entrada' | 'aberto' | 'fechado' | 'cancelado';
  entrada_preco?: number;
  alvo_efetivo?: number;
  risco_efetivo?: number;
  cancelamento_motivo?: string;
  entrada_em?: string;
  saida_preco?: number;
  saida_em?: string;
  saida_motivo?: 'stop' | 'alvo' | 'cancelado';
  resultado_r?: number;
  excursao_favoravel_r?: number;
  excursao_adversa_r?: number;
}

export interface RecoverySelection {
  indexes: number[];
  eligibleCount: number;
  backlog: number;
  recoveredCount: number;
  latestClosedOpenTime: number | null;
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function selectRecoveryCandles(
  candles: readonly DayTradeCandle[],
  lastEvaluatedOpenTime: string | null | undefined,
  maximumCandles = 24,
): RecoverySelection {
  if (!Number.isInteger(maximumCandles) || maximumCandles < 1) {
    throw new Error('maximumCandles deve ser um inteiro positivo.');
  }
  const closed = candles
    .map((candle, index) => ({ candle, index }))
    .filter(({ candle }) => candle.isClosed)
    .sort((a, b) => a.candle.openTime - b.candle.openTime);
  if (closed.length === 0) {
    return { indexes: [], eligibleCount: 0, backlog: 0, recoveredCount: 0, latestClosedOpenTime: null };
  }
  const latest = closed[closed.length - 1].candle.openTime;
  const checkpoint = validTime(lastEvaluatedOpenTime);
  const eligible = checkpoint === null
    ? [closed[closed.length - 1]]
    : closed.filter(({ candle }) => candle.openTime > checkpoint);
  const selected = eligible.slice(0, maximumCandles);
  return {
    indexes: selected.map(({ index }) => index),
    eligibleCount: eligible.length,
    backlog: Math.max(0, eligible.length - selected.length),
    recoveredCount: selected.filter(({ candle }) => candle.openTime < latest).length,
    latestClosedOpenTime: latest,
  };
}

export function evaluationWindow(
  candles: readonly DayTradeCandle[],
  terminalIndex: number,
  desiredWarmup = 400,
): DayTradeCandle[] {
  if (!Number.isInteger(terminalIndex) || terminalIndex < 0 || terminalIndex >= candles.length) {
    throw new Error('terminalIndex está fora da série de candles.');
  }
  const start = Math.max(0, terminalIndex - Math.max(1, desiredWarmup) + 1);
  return candles.slice(start, terminalIndex + 1);
}

const buyWithSlippage = (price: number, pct: number) => price * (1 + pct / 100);
const sellWithSlippage = (price: number, pct: number) => price * (1 - pct / 100);

export function resolveForwardLongSignal(
  signal: ForwardSignalInput,
  candles: readonly DayTradeCandle[],
  config: ForwardExecutionConfig,
): ForwardResolution {
  const signalTime = new Date(signal.candle_open_time).getTime();
  const signalIndex = candles.findIndex((candle) => candle.openTime === signalTime);
  if (signalIndex < 0) return { status: signal.status as ForwardResolution['status'] };

  const entryCandle = candles[signalIndex + 1];
  if (!entryCandle || !entryCandle.isClosed) return { status: 'aguardando_entrada' };

  const plannedRisk = signal.entrada_referencia - signal.stop_referencia;
  if (!Number.isFinite(plannedRisk) || plannedRisk <= 0) {
    return { status: 'cancelado', saida_motivo: 'cancelado', cancelamento_motivo: 'plano_invalido', saida_em: new Date(entryCandle.openTime).toISOString() };
  }
  if (signal.atr !== null && entryCandle.open > signal.entrada_referencia + signal.atr * config.max_next_open_distance_atr) {
    return { status: 'cancelado', saida_motivo: 'cancelado', cancelamento_motivo: 'abertura_distante', saida_em: new Date(entryCandle.openTime).toISOString() };
  }

  const entryPrice = signal.entrada_preco ?? buyWithSlippage(entryCandle.open, config.slippage_pct);
  const stop = signal.stop_referencia;
  const actualRisk = entryPrice - stop;
  if (!Number.isFinite(actualRisk) || actualRisk <= 0) {
    return { status: 'cancelado', saida_motivo: 'cancelado', cancelamento_motivo: 'risco_real_invalido', saida_em: new Date(entryCandle.openTime).toISOString() };
  }

  const targetRatio = (signal.alvo_referencia - signal.entrada_referencia) / plannedRisk;
  const target = entryPrice + actualRisk * targetRatio;
  let mfe = 0;
  let mae = 0;

  for (let index = signalIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle.isClosed) break;
    mfe = Math.max(mfe, (candle.high - entryPrice) / actualRisk);
    mae = Math.min(mae, (candle.low - entryPrice) / actualRisk);
    let reason: 'stop' | 'alvo' | null = null;
    let rawExit = 0;
    if (candle.open <= stop) { reason = 'stop'; rawExit = candle.open; }
    else if (candle.open >= target) { reason = 'alvo'; rawExit = target; }
    else if (candle.low <= stop) { reason = 'stop'; rawExit = stop; }
    else if (candle.high >= target) { reason = 'alvo'; rawExit = target; }

    if (reason) {
      const exitPrice = sellWithSlippage(rawExit, config.slippage_pct);
      const fees = entryPrice * (config.fee_rate_pct / 100) + exitPrice * (config.fee_rate_pct / 100);
      return {
        status: 'fechado', entrada_preco: entryPrice,
        entrada_em: new Date(entryCandle.openTime).toISOString(), alvo_efetivo: target,
        risco_efetivo: actualRisk, saida_preco: exitPrice,
        saida_em: new Date(candle.closeTime).toISOString(), saida_motivo: reason,
        resultado_r: (exitPrice - entryPrice - fees) / actualRisk,
        excursao_favoravel_r: mfe, excursao_adversa_r: mae,
      };
    }
  }

  return {
    status: 'aberto', entrada_preco: entryPrice,
    entrada_em: new Date(entryCandle.openTime).toISOString(),
    alvo_efetivo: target, risco_efetivo: actualRisk,
    excursao_favoravel_r: mfe, excursao_adversa_r: mae,
  };
}
