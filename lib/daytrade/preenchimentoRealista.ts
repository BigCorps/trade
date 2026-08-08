/**
 * lib/daytrade/preenchimentoRealista.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Modelo de preenchimento que considera gap de abertura.
 *
 * O BUG QUE ESTE ARQUIVO CORRIGE
 * ------------------------------
 * `multiStrategyBacktest.ts` aplica slippage como percentual fixo sobre o
 * preço do stop (`applyBacktestSellSlippage`). Isso assume que o stop sempre
 * executa no preço do stop, mais uma derrapagem pequena e constante.
 *
 * Não é o que acontece. Quando o candle ABRE além do stop, a ordem executa na
 * abertura — que pode estar muito além. O simulador não modelava isso.
 *
 * Impacto medido nesta base (07/08/2026):
 *
 *   stop modelado pelo backtest .......... ~1,05 R
 *   stop realizado no forward test ....... 1,241 R
 *   subestimação ......................... ~0,19 R por operação perdedora
 *
 * Isso explica boa parte da degradação observada:
 *
 *   backtest 1h/360d, custos reais ....... −0,189 R/operação
 *   forward test ao vivo ................. −0,530 R/operação
 *
 * Enquanto o gap não for modelado, TODO backtest nasce otimista e a
 * comparação entre estratégias fica distorcida — as que operam ativos mais
 * voláteis são as mais penalizadas na realidade e as menos penalizadas na
 * simulação.
 *
 * COMO INTEGRAR
 * -------------
 * Em `multiStrategyBacktest.ts`, no ponto em que a saída por stop é
 * resolvida, substitua o cálculo direto por `resolverPreenchimentoStop`.
 * Veja INTEGRACAO.md para o passo a passo.
 */

export type TradeDirection = 'long' | 'short';

export interface CandleLike {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StopFillInput {
  direction: TradeDirection;
  stopPrice: number;
  candle: CandleLike;
  /** Slippage adversa por execução, em percentual. Padrão: 0,05. */
  slippagePct?: number;
}

export interface StopFill {
  /** Se o stop foi acionado neste candle. */
  triggered: boolean;
  /** Preço de execução estimado. */
  fillPrice: number | null;
  /** Se a abertura já estava além do stop. */
  gapped: boolean;
  /** Quanto o gap custou além do preço do stop, em percentual do preço. */
  gapCostPct: number;
  reason: 'sem_acionamento' | 'gap_na_abertura' | 'acionado_no_candle';
}

/**
 * Resolve o preenchimento do stop considerando gap de abertura.
 *
 * Ordem de verificação — a abertura vem primeiro, sempre:
 *
 *   1. A abertura já está além do stop? Executa na abertura. Este é o caso
 *      que o modelo antigo ignorava e que custa caro em ativos voláteis.
 *   2. O candle tocou o stop durante o período? Executa no stop, com
 *      slippage normal.
 *   3. Não tocou? Sem acionamento.
 */
export function resolverPreenchimentoStop(input: StopFillInput): StopFill {
  const { direction, stopPrice, candle } = input;
  const slippagePct = input.slippagePct ?? 0.05;

  const isLong = direction === 'long';

  // 1. Gap de abertura — a abertura já ultrapassou o stop.
  const openedBeyondStop = isLong
    ? candle.open <= stopPrice
    : candle.open >= stopPrice;

  if (openedBeyondStop) {
    // Executa na abertura. Ainda há slippage, pois o livro está desequilibrado.
    const fillPrice = isLong
      ? candle.open * (1 - slippagePct / 100)
      : candle.open * (1 + slippagePct / 100);

    const gapCostPct =
      stopPrice > 0 ? (Math.abs(candle.open - stopPrice) / stopPrice) * 100 : 0;

    return {
      triggered: true,
      fillPrice,
      gapped: true,
      gapCostPct,
      reason: 'gap_na_abertura',
    };
  }

  // 2. Stop tocado durante o candle.
  const touchedStop = isLong
    ? candle.low <= stopPrice
    : candle.high >= stopPrice;

  if (touchedStop) {
    const fillPrice = isLong
      ? stopPrice * (1 - slippagePct / 100)
      : stopPrice * (1 + slippagePct / 100);

    return {
      triggered: true,
      fillPrice,
      gapped: false,
      gapCostPct: 0,
      reason: 'acionado_no_candle',
    };
  }

  return {
    triggered: false,
    fillPrice: null,
    gapped: false,
    gapCostPct: 0,
    reason: 'sem_acionamento',
  };
}

/**
 * Mesma lógica para o alvo, mas o gap aqui é FAVORÁVEL.
 *
 * Modelar só o gap adverso do stop e ignorar o favorável do alvo criaria um
 * viés pessimista. O objetivo é realismo, não conservadorismo artificial.
 */
export function resolverPreenchimentoAlvo(input: {
  direction: TradeDirection;
  targetPrice: number;
  candle: CandleLike;
  slippagePct?: number;
}): StopFill {
  const { direction, targetPrice, candle } = input;
  const slippagePct = input.slippagePct ?? 0.05;

  const isLong = direction === 'long';

  const openedBeyondTarget = isLong
    ? candle.open >= targetPrice
    : candle.open <= targetPrice;

  if (openedBeyondTarget) {
    const fillPrice = isLong
      ? candle.open * (1 - slippagePct / 100)
      : candle.open * (1 + slippagePct / 100);

    const gapCostPct =
      targetPrice > 0 ? (Math.abs(candle.open - targetPrice) / targetPrice) * 100 : 0;

    return {
      triggered: true,
      fillPrice,
      gapped: true,
      gapCostPct: -gapCostPct,
      reason: 'gap_na_abertura',
    };
  }

  const touchedTarget = isLong
    ? candle.high >= targetPrice
    : candle.low <= targetPrice;

  if (touchedTarget) {
    const fillPrice = isLong
      ? targetPrice * (1 - slippagePct / 100)
      : targetPrice * (1 + slippagePct / 100);

    return {
      triggered: true,
      fillPrice,
      gapped: false,
      gapCostPct: 0,
      reason: 'acionado_no_candle',
    };
  }

  return {
    triggered: false,
    fillPrice: null,
    gapped: false,
    gapCostPct: 0,
    reason: 'sem_acionamento',
  };
}

/**
 * Regra de precedência quando o candle toca stop E alvo.
 *
 * Sem dados intracandle é impossível saber qual veio primeiro. Assumir o alvo
 * é otimismo puro e infla qualquer backtest.
 *
 * Convenção adotada: o STOP vence. É a suposição conservadora e a única
 * defensável sem dados de menor granularidade.
 */
export function resolverCandleAmbiguo(
  stopFill: StopFill,
  targetFill: StopFill,
): { escolhido: 'stop' | 'alvo' | 'nenhum'; ambiguo: boolean } {
  if (stopFill.triggered && targetFill.triggered) {
    return { escolhido: 'stop', ambiguo: true };
  }
  if (stopFill.triggered) return { escolhido: 'stop', ambiguo: false };
  if (targetFill.triggered) return { escolhido: 'alvo', ambiguo: false };
  return { escolhido: 'nenhum', ambiguo: false };
}
