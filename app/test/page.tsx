'use client';

/**
 * app/test/page.tsx — VigIA Trade
 * -----------------------------------------------------------------------------
 * Bancada interna de backtest multiestratégia.
 *
 * Recursos:
 * - estratégia individual ou comparação das quatro estratégias;
 * - histórico por quantidade de candles;
 * - histórico por intervalo de datas, com presets;
 * - execução imediata para amostras menores;
 * - acompanhamento de análises assíncronas extensas;
 * - recuperação da análise em andamento após recarregar a página;
 * - gerenciamento fixo, anti-martingale e martingale exclusivo de backtest/Testnet;
 * - comparação do dimensionamento selecionado contra a mesma simulação em risco fixo;
 * - saída em Markdown e JSON.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import type {
  Session,
} from '@supabase/supabase-js';

import {
  getSupabase,
} from '../../lib/supabaseClient';

// -----------------------------------------------------------------------------
// Tipos
// -----------------------------------------------------------------------------

type StrategyId =
  | 'trend_breakout'
  | 'trend_pullback'
  | 'squeeze_breakout'
  | 'range_mean_reversion';

type BacktestMode =
  | 'single'
  | 'compare_all';

type MoneyManagementMode =
  | 'fixed'
  | 'anti_martingale'
  | 'martingale_testnet';

type HistoryMode =
  | 'candle_count'
  | 'date_range';

type PeriodPreset =
  | '30d'
  | '90d'
  | '6m'
  | '1y'
  | '2y'
  | 'custom';

type BacktestRunStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

interface StrategyOption {
  id: StrategyId;
  label: string;
  shortLabel: string;
  description: string;
  executionMode:
    | 'testnet_allowed'
    | 'shadow';
}

interface ActiveRun {
  id: string;
  mode: BacktestMode;
  strategy: StrategyId;
  symbol: string;
  timeframe: string;
  historyMode: HistoryMode;
  startedAt: string;
}

interface RunProgress {
  status: BacktestRunStatus;
  progressPct: number;
  processedCandles: number;
  totalCandles: number;
  message: string;
  updatedAt: string;
}

interface SingleBacktestPayload {
  symbol?: unknown;
  timeframe?: unknown;
  execution_ms?: unknown;
  generated_at?: unknown;
  result?: unknown;
  error?: unknown;
}

interface ComparisonPayload {
  symbol?: unknown;
  timeframe?: unknown;
  execution_ms?: unknown;
  generated_at?: unknown;
  comparison?: unknown;
  error?: unknown;
}

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const COLORS = {
  background: '#101418',
  panel: '#181f26',
  panelSoft: '#141a20',
  border: '#2a343f',
  text: '#d7dee6',
  muted: '#7d8a97',
  accent: '#e8a13c',
  accentText: '#1a1206',
  green: '#3fb26f',
  red: '#d05555',
  blue: '#4c8ed9',
  yellow: '#d7ae4f',
} as const;

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
] as const;

const TIMEFRAMES = [
  '5m',
  '15m',
  '30m',
  '1h',
] as const;

const STRATEGIES: readonly StrategyOption[] = [
  {
    id: 'trend_breakout',
    label: 'Tendência com rompimento',
    shortLabel: 'Rompimento',
    description:
      'Continuação de tendência após rompimento confirmado com volume.',
    executionMode: 'testnet_allowed',
  },
  {
    id: 'trend_pullback',
    label: 'Tendência com pullback',
    shortLabel: 'Pullback',
    description:
      'Retorno à zona das médias seguido de recuperação da tendência.',
    executionMode: 'shadow',
  },
  {
    id: 'squeeze_breakout',
    label: 'Compressão com rompimento',
    shortLabel: 'Squeeze',
    description:
      'Expansão após compressão de preço e volatilidade.',
    executionMode: 'shadow',
  },
  {
    id: 'range_mean_reversion',
    label: 'Reversão à média em lateralização',
    shortLabel: 'Reversão à média',
    description:
      'Entrada próxima ao suporte de uma faixa lateral com alvo na média.',
    executionMode: 'shadow',
  },
] as const;

const DIRECT_EXECUTION_CANDLE_LIMIT = 3_000;
const MINIMUM_CANDLE_COUNT = 350;
const MAXIMUM_CANDLE_COUNT = 3_000;
const MAXIMUM_DATE_RANGE_DAYS = 731;
const MAXIMUM_ESTIMATED_CANDLES = 220_000;
const RUN_STORAGE_KEY = 'vigia:backtest-daytrade:active-run';
const POLL_INTERVAL_MS = 2_500;

const TIMEFRAME_MILLISECONDS: Record<string, number> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
};

const PRESET_LABELS: Record<PeriodPreset, string> = {
  '30d': '30 dias',
  '90d': '90 dias',
  '6m': '6 meses',
  '1y': '1 ano',
  '2y': '2 anos',
  custom: 'Personalizado',
};

const MONEY_MANAGEMENT_LABELS: Record<MoneyManagementMode, string> = {
  fixed: 'Risco fixo',
  anti_martingale: 'Anti-martingale',
  martingale_testnet: 'Martingale · somente backtest/Testnet',
};

const MONEY_MANAGEMENT_DESCRIPTIONS: Record<MoneyManagementMode, string> = {
  fixed:
    'Mantém o mesmo percentual-base de risco em todas as operações.',
  anti_martingale:
    'Aumenta o risco após vitórias e reduz após perdas, sempre respeitando pisos, tetos e limite de sequência.',
  martingale_testnet:
    'Aumenta o risco após perdas. É experimental e fica restrito a backtest e Binance Spot Testnet.',
};

const MONEY_MANAGEMENT_POLICY_VERSION = '1.0.0';

// -----------------------------------------------------------------------------
// Estilos
// -----------------------------------------------------------------------------

const inputStyle: CSSProperties = {
  background: COLORS.background,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  color: COLORS.text,
  padding: '8px 10px',
  fontSize: 14,
  textAlign: 'center',
  outline: 'none',
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: COLORS.muted,
  textAlign: 'center',
};

const secondaryButtonStyle: CSSProperties = {
  background: 'transparent',
  color: COLORS.accent,
  border: `1px solid ${COLORS.accent}`,
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 260,
  background: COLORS.background,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  color: COLORS.text,
  padding: 12,
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  whiteSpace: 'pre',
  overflow: 'auto',
  resize: 'vertical',
};

// -----------------------------------------------------------------------------
// Componentes pequenos
// -----------------------------------------------------------------------------

function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function ModeBadge({
  mode,
}: {
  mode: StrategyOption['executionMode'];
}) {
  const shadow =
    mode === 'shadow';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 700,
        background:
          shadow
            ? 'rgba(76, 142, 217, 0.14)'
            : 'rgba(63, 178, 111, 0.14)',
        color:
          shadow
            ? COLORS.blue
            : COLORS.green,
        border: `1px solid ${
          shadow
            ? 'rgba(76, 142, 217, 0.35)'
            : 'rgba(63, 178, 111, 0.35)'
        }`,
      }}
    >
      {shadow
        ? 'SHADOW'
        : 'TESTNET LIBERADO'}
    </span>
  );
}

function StatusBadge({
  status,
}: {
  status: BacktestRunStatus;
}) {
  const colors: Record<BacktestRunStatus, string> = {
    pending: COLORS.yellow,
    processing: COLORS.blue,
    completed: COLORS.green,
    failed: COLORS.red,
  };

  const labels: Record<BacktestRunStatus, string> = {
    pending: 'NA FILA',
    processing: 'PROCESSANDO',
    completed: 'CONCLUÍDO',
    failed: 'FALHOU',
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '3px 9px',
        fontSize: 10,
        fontWeight: 800,
        color: colors[status],
        border: `1px solid ${colors[status]}`,
      }}
    >
      {labels[status]}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Helpers gerais
// -----------------------------------------------------------------------------

function asRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as Record<
    string,
    unknown
  >;
}

function asArray(
  value: unknown,
): unknown[] {
  return Array.isArray(value)
    ? value
    : [];
}

function asNumber(
  value: unknown,
): number | null {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value === 'string' &&
    value.trim() !== ''
  ) {
    const parsed =
      Number(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function asString(
  value: unknown,
): string {
  return typeof value === 'string'
    ? value
    : '';
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    maximum,
    Math.max(minimum, value),
  );
}

function parseBoundedNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${label} deve estar entre ${minimum} e ${maximum}.`,
    );
  }

  return parsed;
}

function parseBoundedInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${label} deve ser um inteiro entre ${minimum} e ${maximum}.`,
    );
  }

  return parsed;
}

function formatSignedNumber(
  value: unknown,
  digits = 2,
): string {
  const number = asNumber(value);

  if (number === null) {
    return '—';
  }

  const prefix = number > 0 ? '+' : '';
  return `${prefix}${formatNumber(number, digits)}`;
}

function formatMoneyManagementMode(
  value: unknown,
): string {
  const mode = asString(value) as MoneyManagementMode;
  return MONEY_MANAGEMENT_LABELS[mode] ?? mode ?? '—';
}

function formatNumber(
  value: unknown,
  digits = 2,
): string {
  const number =
    asNumber(value);

  if (number === null) {
    return '—';
  }

  return number.toLocaleString(
    'pt-BR',
    {
      minimumFractionDigits:
        digits,
      maximumFractionDigits:
        digits,
    },
  );
}

function formatInteger(
  value: unknown,
): string {
  const number =
    asNumber(value);

  if (number === null) {
    return '—';
  }

  return Math.trunc(number)
    .toLocaleString('pt-BR');
}

function formatDateRange(
  firstValue: unknown,
  lastValue: unknown,
): string {
  const first =
    asNumber(firstValue);

  const last =
    asNumber(lastValue);

  if (
    first === null ||
    last === null
  ) {
    return '—';
  }

  return `${new Date(first).toLocaleDateString('pt-BR')} a ${new Date(last).toLocaleDateString('pt-BR')}`;
}

function formatProfitFactor(
  value: unknown,
): string {
  if (value === null) {
    return '∞ (sem perdas)';
  }

  return formatNumber(value);
}

function getStrategy(
  strategyId: StrategyId,
): StrategyOption {
  return (
    STRATEGIES.find(
      (strategy) =>
        strategy.id === strategyId,
    ) ??
    STRATEGIES[0]
  );
}

function toInputDate(
  date: Date,
): string {
  const year =
    date.getUTCFullYear();

  const month =
    String(
      date.getUTCMonth() + 1,
    ).padStart(2, '0');

  const day =
    String(
      date.getUTCDate(),
    ).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function parseInputDateUtc(
  value: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date =
    new Date(
      `${value}T00:00:00.000Z`,
    );

  return Number.isFinite(
    date.getTime(),
  )
    ? date
    : null;
}

function addUtcDays(
  date: Date,
  days: number,
): Date {
  return new Date(
    date.getTime() +
      days * 24 * 60 * 60 * 1_000,
  );
}

function resolvePresetDates(
  preset: PeriodPreset,
): {
  startDate: string;
  endDate: string;
} {
  const now =
    new Date();

  const todayUtc =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
      ),
    );

  let start =
    new Date(todayUtc);

  switch (preset) {
    case '30d':
      start = addUtcDays(
        todayUtc,
        -29,
      );
      break;

    case '90d':
      start = addUtcDays(
        todayUtc,
        -89,
      );
      break;

    case '6m':
      start.setUTCMonth(
        start.getUTCMonth() - 6,
      );
      break;

    case '1y':
      start.setUTCFullYear(
        start.getUTCFullYear() - 1,
      );
      break;

    case '2y':
      start.setUTCFullYear(
        start.getUTCFullYear() - 2,
      );
      break;

    case 'custom':
      start = addUtcDays(
        todayUtc,
        -29,
      );
      break;
  }

  return {
    startDate:
      toInputDate(start),
    endDate:
      toInputDate(todayUtc),
  };
}

function resolveDateRange(
  startDateValue: string,
  endDateValue: string,
  timeframe: string,
): {
  startTime: string;
  endTime: string;
  days: number;
  estimatedCandles: number;
} {
  const start =
    parseInputDateUtc(
      startDateValue,
    );

  const endInclusive =
    parseInputDateUtc(
      endDateValue,
    );

  if (!start || !endInclusive) {
    throw new Error(
      'Informe datas inicial e final válidas.',
    );
  }

  if (
    endInclusive.getTime() <
    start.getTime()
  ) {
    throw new Error(
      'A data final deve ser igual ou posterior à data inicial.',
    );
  }

  const endExclusive =
    addUtcDays(
      endInclusive,
      1,
    );

  const rangeMs =
    endExclusive.getTime() -
    start.getTime();

  const days =
    Math.ceil(
      rangeMs /
        (24 * 60 * 60 * 1_000),
    );

  if (
    days >
    MAXIMUM_DATE_RANGE_DAYS
  ) {
    throw new Error(
      `O intervalo máximo nesta bancada é de ${MAXIMUM_DATE_RANGE_DAYS} dias.`,
    );
  }

  const intervalMs =
    TIMEFRAME_MILLISECONDS[
      timeframe
    ];

  if (!intervalMs) {
    throw new Error(
      'Timeframe inválido.',
    );
  }

  const estimatedCandles =
    Math.ceil(
      rangeMs /
        intervalMs,
    );

  if (
    estimatedCandles <
    MINIMUM_CANDLE_COUNT
  ) {
    throw new Error(
      `O período possui aproximadamente ${estimatedCandles} candles. Selecione pelo menos ${MINIMUM_CANDLE_COUNT}.`,
    );
  }

  if (
    estimatedCandles >
    MAXIMUM_ESTIMATED_CANDLES
  ) {
    throw new Error(
      `O período excede o limite de segurança de ${MAXIMUM_ESTIMATED_CANDLES.toLocaleString('pt-BR')} candles estimados.`,
    );
  }

  return {
    startTime:
      start.toISOString(),
    endTime:
      endExclusive.toISOString(),
    days,
    estimatedCandles,
  };
}

function getRunId(
  response: Record<string, unknown>,
): string {
  const run =
    asRecord(response.run);

  return (
    asString(response.run_id) ||
    asString(response.id) ||
    asString(run?.id)
  );
}

function getRunRecordPayload(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const candidates = [
    record.response_payload,
    record.output,
    record.result_payload,
    record.result,
  ];

  for (const candidate of candidates) {
    const parsed =
      asRecord(candidate);

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function normalizeCompletedRunResponse(
  record: Record<string, unknown>,
  activeRun: ActiveRun,
): Record<string, unknown> | null {
  const payload =
    getRunRecordPayload(record);

  if (!payload) {
    return null;
  }

  if (
    payload.result ||
    payload.comparison
  ) {
    return payload;
  }

  const common = {
    ok: true,
    mode:
      activeRun.mode,
    symbol:
      asString(record.symbol) ||
      activeRun.symbol,
    timeframe:
      asString(record.timeframe) ||
      activeRun.timeframe,
    generated_at:
      asString(record.completed_at) ||
      asString(record.updated_at) ||
      new Date().toISOString(),
    execution_ms:
      asNumber(record.execution_ms) ??
      null,
  };

  return activeRun.mode ===
    'compare_all'
    ? {
        ...common,
        comparison:
          payload,
      }
    : {
        ...common,
        result:
          payload,
      };
}

// -----------------------------------------------------------------------------
// Markdown individual
// -----------------------------------------------------------------------------

function buildSingleMarkdown(
  payload: SingleBacktestPayload,
): string {
  const result =
    asRecord(payload.result);

  if (!result) {
    return 'Sem resultado.';
  }

  const metrics =
    asRecord(result.metrics) ?? {};

  const assumptions =
    asRecord(
      result.assumptions,
    ) ?? {};

  const strategyId =
    asString(result.strategy) as
      | StrategyId
      | '';

  const strategy =
    strategyId
      ? getStrategy(strategyId)
      : null;

  const strategyLabel =
    asString(
      result.strategyLabel,
    ) ||
    strategy?.label ||
    strategyId ||
    'Estratégia';

  const period =
    formatDateRange(
      result.firstCandleOpenTime,
      result.lastCandleCloseTime,
    );

  const warnings =
    asArray(result.warnings)
      .filter(
        (
          value,
        ): value is string =>
          typeof value === 'string',
      );

  const moneyManagement =
    asRecord(result.moneyManagement);

  const moneyPolicy =
    asRecord(moneyManagement?.policy) ?? {};

  const moneySummary =
    asRecord(moneyManagement?.summary) ?? {};

  const comparisonToFixed =
    asRecord(moneyManagement?.comparisonToFixed);

  const lines = [
    `# Backtest — ${String(payload.symbol ?? '—')} · ${String(payload.timeframe ?? '—')}`,
    '',
    `- Estratégia: ${strategyLabel}`,
    `- ID: ${strategyId || '—'} · versão ${String(result.strategyVersion ?? '—')}`,
    `- Modo operacional: ${strategy?.executionMode === 'shadow' ? 'shadow' : 'Testnet autorizado'}`,
    `- Período: ${period}`,
    `- Candles: ${String(result.candleCount ?? '—')} (aquecimento ${String(result.warmupCandles ?? '—')}, testados ${String(result.testedCandleCount ?? '—')})`,
    `- Execução: ${String(payload.execution_ms ?? '—')} ms · gerado em ${String(payload.generated_at ?? '—')}`,
    `- Premissas: sinal no ${String(assumptions.signalTiming ?? '—')}, entrada em ${String(assumptions.entryTiming ?? '—')}, prioridade intrabar ${String(assumptions.intrabarPriority ?? '—')}, custos incluídos: ${String(assumptions.costsIncluded ?? '—')}`,
    '',
    '## Métricas',
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Capital inicial | ${formatNumber(metrics.initialCapitalUsdt)} USDT |`,
    `| Capital final | ${formatNumber(metrics.finalCapitalUsdt)} USDT |`,
    `| Retorno líquido | ${formatNumber(metrics.netReturnPct)}% |`,
    `| PnL líquido | ${formatNumber(metrics.netPnlUsdt)} USDT |`,
    `| Sinais | ${formatInteger(metrics.signals)} |`,
    `| Operações executadas | ${formatInteger(metrics.enteredTrades ?? metrics.totalTrades)} |`,
    `| Sinais ignorados | ${formatInteger(metrics.skippedSignals)} |`,
    `| Vitórias / Derrotas / Empates | ${formatInteger(metrics.wins)} / ${formatInteger(metrics.losses)} / ${formatInteger(metrics.breakeven)} |`,
    `| Taxa de acerto | ${formatNumber(metrics.winRatePct)}% |`,
    `| Profit factor | ${formatProfitFactor(metrics.profitFactor)} |`,
    `| R médio | ${formatNumber(metrics.averageR)} |`,
    `| R mediano | ${formatNumber(metrics.medianR)} |`,
    `| Melhor / Pior R | ${formatNumber(metrics.bestR)} / ${formatNumber(metrics.worstR)} |`,
    `| Drawdown máximo | ${formatNumber(metrics.maximumDrawdownPct)}% (${formatNumber(metrics.maximumDrawdownUsdt)} USDT) |`,
    `| Máx. vitórias/derrotas seguidas | ${formatInteger(metrics.maximumConsecutiveWins)} / ${formatInteger(metrics.maximumConsecutiveLosses)} |`,
    `| Exposição | ${formatNumber(metrics.exposurePct)}% do tempo |`,
    `| Holding médio | ${formatNumber(metrics.averageHoldingCandles, 1)} candles |`,
  ];

  if (moneyManagement) {
    lines.push(
      '',
      '## Gerenciamento de posição',
      '',
      `- Política: **${formatMoneyManagementMode(moneyPolicy.mode)}** · versão ${String(moneyPolicy.policyVersion ?? '—')}`,
      `- Risco base / mínimo / máximo: ${formatNumber(moneyPolicy.baseRiskPercent)}% / ${formatNumber(moneyPolicy.minimumRiskPercent)}% / ${formatNumber(moneyPolicy.maximumRiskPercent)}%`,
      `- Limite de sequência: ${formatInteger(moneyPolicy.maximumSequenceSteps)} etapa(s) · pausa sinalizada após ${formatInteger(moneyPolicy.pauseAfterConsecutiveLosses)} perda(s)`,
      `- Uso máximo do saldo: ${formatNumber(moneyPolicy.balanceUsageLimitPct)}%`,
      `- Maior multiplicador aplicado: ${formatNumber(moneySummary.maximumMultiplierApplied)}x`,
      `- Risco aplicado máximo / médio: ${formatNumber(moneySummary.maximumAppliedRiskPercent)}% / ${formatNumber(moneySummary.averageAppliedRiskPercent)}%`,
      `- Maior etapa da sequência: ${formatInteger(moneySummary.maximumSequenceStep)}`,
      `- Maior sequência elegível de vitórias / perdas: ${formatInteger(moneySummary.maximumEligibleConsecutiveWins)} / ${formatInteger(moneySummary.maximumEligibleConsecutiveLosses)}`,
      `- Sinais de pausa por perdas: ${formatInteger(moneySummary.pauseThresholdHits)}`,
      `- Limitações por saldo / notional / mínimos da corretora / quantidade zero: ${formatInteger(moneySummary.balanceLimitedTrades)} / ${formatInteger(moneySummary.notionalLimitedTrades)} / ${formatInteger(moneySummary.exchangeMinimumBlockedTrades)} / ${formatInteger(moneySummary.zeroQuantityTrades)}`,
    );

    if (comparisonToFixed?.enabled === true) {
      const selected =
        asRecord(comparisonToFixed.selected) ?? {};
      const fixed =
        asRecord(comparisonToFixed.fixed) ?? {};
      const effect =
        asRecord(comparisonToFixed.effect) ?? {};

      lines.push(
        '',
        '### Comparação com risco fixo',
        '',
        `- Mesmo caminho de sinais e saídas: ${comparisonToFixed.sameTradePath === true ? 'sim' : 'não'}`,
        '',
        '| Cenário | Capital final | Retorno | PnL | Drawdown |',
        '|---|---:|---:|---:|---:|',
        `| Política selecionada | ${formatNumber(selected.finalCapitalUsdt)} USDT | ${formatNumber(selected.netReturnPct)}% | ${formatNumber(selected.netPnlUsdt)} USDT | ${formatNumber(selected.maximumDrawdownPct)}% |`,
        `| Risco fixo equivalente | ${formatNumber(fixed.finalCapitalUsdt)} USDT | ${formatNumber(fixed.netReturnPct)}% | ${formatNumber(fixed.netPnlUsdt)} USDT | ${formatNumber(fixed.maximumDrawdownPct)}% |`,
        `| Efeito do dimensionamento | — | ${formatSignedNumber(effect.returnPct)} p.p. | ${formatSignedNumber(effect.pnlUsdt)} USDT | ${formatSignedNumber(effect.drawdownPct)} p.p. |`,
      );
    }
  }

  if (warnings.length > 0) {
    lines.push(
      '',
      '## Alertas',
      '',
      ...warnings.map(
        (warning) =>
          `- ${warning}`,
      ),
    );
  }

  lines.push(
    '',
    `> ${String(result.educationalNotice ?? '')}`,
  );

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Markdown comparativo
// -----------------------------------------------------------------------------

function buildComparisonMarkdown(
  payload: ComparisonPayload,
): string {
  const comparison =
    asRecord(
      payload.comparison,
    );

  if (!comparison) {
    return 'Sem comparação.';
  }

  const rows =
    asArray(
      comparison.rows,
    )
      .map(asRecord)
      .filter(
        (
          row,
        ): row is Record<
          string,
          unknown
        > =>
          row !== null,
      );

  const ranking =
    asArray(
      comparison.mainRanking,
    )
      .map(asRecord)
      .filter(
        (
          row,
        ): row is Record<
          string,
          unknown
        > =>
          row !== null,
      );

  const provisional =
    asArray(
      comparison.provisionalRanking,
    )
      .map(asRecord)
      .filter(
        (
          row,
        ): row is Record<
          string,
          unknown
        > =>
          row !== null,
      );

  const failures =
    asArray(
      comparison.failures,
    )
      .map(asRecord)
      .filter(
        (
          row,
        ): row is Record<
          string,
          unknown
        > =>
          row !== null,
      );

  const warnings =
    asArray(
      comparison.warnings,
    )
      .filter(
        (
          value,
        ): value is string =>
          typeof value === 'string',
      );

  const moneyManagement =
    asRecord(comparison.moneyManagement);

  const moneyPolicy =
    asRecord(moneyManagement?.policy) ?? {};

  const fixedRows =
    asArray(moneyManagement?.fixedRows)
      .map(asRecord)
      .filter(
        (
          row,
        ): row is Record<string, unknown> =>
          row !== null,
      );

  const fixedRowsByStrategy =
    new Map(
      fixedRows.map(
        (row) => [
          asString(row.strategy),
          row,
        ],
      ),
    );

  const period =
    formatDateRange(
      comparison.firstCandleOpenTime,
      comparison.lastCandleCloseTime,
    );

  const lines = [
    `# Comparação de backtests — ${String(payload.symbol ?? '—')} · ${String(payload.timeframe ?? '—')}`,
    '',
    `- Período: ${period}`,
    `- Candles: ${String(comparison.candleCount ?? '—')}`,
    `- Amostra mínima do ranking: ${String(comparison.minimumTradesForRanking ?? '—')} operações`,
    `- Execução: ${String(payload.execution_ms ?? '—')} ms · gerado em ${String(payload.generated_at ?? '—')}`,
    '',
    '## Comparação',
    '',
    '| Estratégia | Modo | Trades | Acerto | Retorno | PnL | PF | R médio | Drawdown | Amostra |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const row of rows) {
    const executionMode =
      row.executionMode ===
        'shadow'
        ? 'Shadow'
        : 'Testnet';

    lines.push(
      `| ${String(row.shortLabel ?? row.label ?? row.strategy ?? '—')} | ${executionMode} | ${formatInteger(row.totalTrades)} | ${formatNumber(row.winRatePct)}% | ${formatNumber(row.netReturnPct)}% | ${formatNumber(row.netPnlUsdt)} | ${formatProfitFactor(row.profitFactor)} | ${formatNumber(row.averageR)} | ${formatNumber(row.maximumDrawdownPct)}% | ${String(row.sampleQuality ?? '—')} |`,
    );
  }

  if (moneyManagement) {
    lines.push(
      '',
      '## Gerenciamento de posição',
      '',
      `- Política: **${formatMoneyManagementMode(moneyPolicy.mode)}** · versão ${String(moneyPolicy.policyVersion ?? '—')}`,
      `- Risco base / mínimo / máximo: ${formatNumber(moneyPolicy.baseRiskPercent)}% / ${formatNumber(moneyPolicy.minimumRiskPercent)}% / ${formatNumber(moneyPolicy.maximumRiskPercent)}%`,
      `- Mesmo caminho técnico em todos os cenários: ${moneyManagement.sameSignalAndExitPath === true ? 'sim' : 'não'}`,
    );

    if (fixedRows.length > 0) {
      lines.push(
        '',
        '### Política selecionada versus risco fixo',
        '',
        '| Estratégia | Retorno selecionado | Retorno fixo | Efeito | DD selecionado | DD fixo |',
        '|---|---:|---:|---:|---:|---:|',
      );

      for (const row of rows) {
        const fixedRow =
          fixedRowsByStrategy.get(
            asString(row.strategy),
          );

        lines.push(
          `| ${String(row.shortLabel ?? row.label ?? row.strategy ?? '—')} | ${formatNumber(row.netReturnPct)}% | ${formatNumber(fixedRow?.netReturnPct)}% | ${formatSignedNumber((asNumber(row.netReturnPct) ?? 0) - (asNumber(fixedRow?.netReturnPct) ?? 0))} p.p. | ${formatNumber(row.maximumDrawdownPct)}% | ${formatNumber(fixedRow?.maximumDrawdownPct)}% |`,
        );
      }
    }
  }

  if (ranking.length > 0) {
    lines.push(
      '',
      '## Ranking principal',
      '',
      ...ranking.map(
        (row, index) =>
          `${index + 1}. **${String(row.label ?? row.strategy ?? '—')}** — retorno ${formatNumber(row.netReturnPct)}%, PF ${formatProfitFactor(row.profitFactor)}, R médio ${formatNumber(row.averageR)}, drawdown ${formatNumber(row.maximumDrawdownPct)}%.`,
      ),
    );
  }

  if (provisional.length > 0) {
    lines.push(
      '',
      '## Ranking provisório',
      '',
      ...provisional.map(
        (row, index) =>
          `${index + 1}. **${String(row.label ?? row.strategy ?? '—')}** — ${formatInteger(row.totalTrades)} operações, retorno ${formatNumber(row.netReturnPct)}%, amostra ${String(row.sampleQuality ?? '—')}.`,
      ),
    );
  }

  if (failures.length > 0) {
    lines.push(
      '',
      '## Falhas',
      '',
      ...failures.map(
        (failure) =>
          `- **${String(failure.label ?? failure.strategy ?? '—')}**: ${String(failure.error ?? 'Erro desconhecido.')}`,
      ),
    );
  }

  if (warnings.length > 0) {
    lines.push(
      '',
      '## Alertas',
      '',
      ...warnings.map(
        (warning) =>
          `- ${warning}`,
      ),
    );
  }

  lines.push(
    '',
    `> ${String(comparison.educationalNotice ?? '')}`,
  );

  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Página
// -----------------------------------------------------------------------------

export default function TestPage() {
  const supabase =
    useMemo(
      () =>
        getSupabase(),
      [],
    );

  const initialDates =
    useMemo(
      () =>
        resolvePresetDates('90d'),
      [],
    );

  const [
    session,
    setSession,
  ] = useState<Session | null>(
    null,
  );

  const [
    authReady,
    setAuthReady,
  ] = useState(false);

  const [
    mode,
    setMode,
  ] = useState<BacktestMode>(
    'single',
  );

  const [
    strategy,
    setStrategy,
  ] = useState<StrategyId>(
    'trend_breakout',
  );

  const [
    symbol,
    setSymbol,
  ] = useState('BTCUSDT');

  const [
    timeframe,
    setTimeframe,
  ] = useState('1h');

  const [
    historyMode,
    setHistoryMode,
  ] = useState<HistoryMode>(
    'candle_count',
  );

  const [
    candleCount,
    setCandleCount,
  ] = useState('3000');

  const [
    periodPreset,
    setPeriodPreset,
  ] = useState<PeriodPreset>(
    '90d',
  );

  const [
    startDate,
    setStartDate,
  ] = useState(
    initialDates.startDate,
  );

  const [
    endDate,
    setEndDate,
  ] = useState(
    initialDates.endDate,
  );

  const [
    riskPercent,
    setRiskPercent,
  ] = useState('1');

  const [
    moneyManagementMode,
    setMoneyManagementMode,
  ] = useState<MoneyManagementMode>(
    'fixed',
  );

  const [
    minimumRiskPercent,
    setMinimumRiskPercent,
  ] = useState('0.25');

  const [
    maximumRiskPercent,
    setMaximumRiskPercent,
  ] = useState('2');

  const [
    winMultiplier,
    setWinMultiplier,
  ] = useState('1.25');

  const [
    lossMultiplier,
    setLossMultiplier,
  ] = useState('0.5');

  const [
    lossReductionStart,
    setLossReductionStart,
  ] = useState('2');

  const [
    martingaleLossMultiplier,
    setMartingaleLossMultiplier,
  ] = useState('2');

  const [
    maximumMultiplier,
    setMaximumMultiplier,
  ] = useState('1.5');

  const [
    martingaleMaximumMultiplier,
    setMartingaleMaximumMultiplier,
  ] = useState('4');

  const [
    maximumSequenceSteps,
    setMaximumSequenceSteps,
  ] = useState('2');

  const [
    pauseAfterConsecutiveLosses,
    setPauseAfterConsecutiveLosses,
  ] = useState('3');

  const [
    balanceUsageLimitPct,
    setBalanceUsageLimitPct,
  ] = useState('95');

  const [
    compareWithFixed,
    setCompareWithFixed,
  ] = useState(true);

  const [
    minimumTradesForRanking,
    setMinimumTradesForRanking,
  ] = useState('30');

  const [
    busy,
    setBusy,
  ] = useState(false);

  const [
    error,
    setError,
  ] = useState('');

  const [
    markdown,
    setMarkdown,
  ] = useState('');

  const [
    json,
    setJson,
  ] = useState('');

  const [
    copied,
    setCopied,
  ] = useState<
    'md' | 'json' | null
  >(null);

  const [
    activeRun,
    setActiveRun,
  ] = useState<ActiveRun | null>(
    null,
  );

  const [
    runProgress,
    setRunProgress,
  ] = useState<RunProgress | null>(
    null,
  );

  const selectedStrategy =
    getStrategy(strategy);

  const dateRangePreview =
    useMemo(
      () => {
        try {
          return resolveDateRange(
            startDate,
            endDate,
            timeframe,
          );
        } catch {
          return null;
        }
      },
      [
        startDate,
        endDate,
        timeframe,
      ],
    );

  const estimatedCandleCount =
    historyMode ===
      'candle_count'
      ? Number(candleCount)
      : dateRangePreview
        ?.estimatedCandles ??
        0;

  const expectedExecutionMode =
    estimatedCandleCount >
    DIRECT_EXECUTION_CANDLE_LIMIT
      ? 'async'
      : 'direct';

  useEffect(
    () => {
      void supabase.auth
        .getSession()
        .then(
          ({ data }) => {
            setSession(
              data.session,
            );

            setAuthReady(true);
          },
        );

      const {
        data: subscription,
      } =
        supabase.auth
          .onAuthStateChange(
            (
              _event,
              nextSession,
            ) => {
              setSession(
                nextSession,
              );
            },
          );

      return () => {
        subscription
          .subscription
          .unsubscribe();
      };
    },
    [supabase],
  );

  useEffect(
    () => {
      try {
        const stored =
          window.localStorage
            .getItem(
              RUN_STORAGE_KEY,
            );

        if (!stored) {
          return;
        }

        const parsed =
          asRecord(
            JSON.parse(stored),
          );

        if (!parsed) {
          return;
        }

        const id =
          asString(parsed.id);

        const storedMode =
          asString(parsed.mode) as BacktestMode;

        const storedStrategy =
          asString(parsed.strategy) as StrategyId;

        const storedHistoryMode =
          asString(parsed.historyMode) as HistoryMode;

        if (!id) {
          return;
        }

        setActiveRun({
          id,
          mode:
            storedMode ===
              'compare_all'
              ? 'compare_all'
              : 'single',
          strategy:
            STRATEGIES.some(
              (item) =>
                item.id ===
                storedStrategy,
            )
              ? storedStrategy
              : 'trend_breakout',
          symbol:
            asString(parsed.symbol) ||
            'BTCUSDT',
          timeframe:
            asString(parsed.timeframe) ||
            '1h',
          historyMode:
            storedHistoryMode ===
              'date_range'
              ? 'date_range'
              : 'candle_count',
          startedAt:
            asString(parsed.startedAt) ||
            new Date().toISOString(),
        });
      } catch {
        window.localStorage
          .removeItem(
            RUN_STORAGE_KEY,
          );
      }
    },
    [],
  );

  useEffect(
    () => {
      if (periodPreset === 'custom') {
        return;
      }

      const dates =
        resolvePresetDates(
          periodPreset,
        );

      setStartDate(
        dates.startDate,
      );

      setEndDate(
        dates.endDate,
      );
    },
    [periodPreset],
  );

  const applyResponse =
    useCallback(
      (
        response: Record<string, unknown>,
        responseMode: BacktestMode,
      ) => {
        setJson(
          JSON.stringify(
            response,
            null,
            2,
          ),
        );

        setMarkdown(
          responseMode ===
            'compare_all'
            ? buildComparisonMarkdown(
                response,
              )
            : buildSingleMarkdown(
                response,
              ),
        );
      },
      [],
    );

  const clearActiveRun =
    useCallback(
      () => {
        setActiveRun(null);
        setRunProgress(null);

        window.localStorage
          .removeItem(
            RUN_STORAGE_KEY,
          );
      },
      [],
    );

  const cancelActiveRun =
    useCallback(
      async () => {
        if (!activeRun) {
          return;
        }

        const {
          data,
          error: rpcError,
        } =
          await supabase.rpc(
            'cancel_backtest_run',
            {
              p_run_id: activeRun.id,
            },
          );

        if (rpcError) {
          setError(
            `Não foi possível cancelar: ${rpcError.message}`,
          );
          return;
        }

        if (data !== true) {
          // A run já saiu de "pending" (o worker assumiu ou concluiu).
          // O polling existente resolverá o estado final sozinho.
          setError(
            'A análise já está em processamento e não pode mais ser cancelada. Aguarde a conclusão.',
          );
          return;
        }

        clearActiveRun();
        setBusy(false);
      },
      [
        activeRun,
        supabase,
        clearActiveRun,
      ],
    );

  useEffect(
    () => {
      if (
        !session ||
        !activeRun
      ) {
        return;
      }

      let cancelled =
        false;

let timeoutId: number | null = null;

      const poll =
        async () => {
          const {
            data,
            error: queryError,
          } =
            await supabase
              .from('backtest_runs')
              .select('*')
              .eq(
                'id',
                activeRun.id,
              )
              .maybeSingle();

          if (cancelled) {
            return;
          }

          if (queryError) {
            setError(
              queryError.message,
            );

            timeoutId =
              window.setTimeout(
                () => {
                  void poll();
                },
                POLL_INTERVAL_MS,
              );

            return;
          }

          const record =
            asRecord(data);

          if (!record) {
            setError(
              'A análise em andamento não foi encontrada.',
            );

            clearActiveRun();
            return;
          }

          const rawStatus =
            asString(record.status);

          const status:
            BacktestRunStatus =
              rawStatus === 'processing' ||
              rawStatus === 'completed' ||
              rawStatus === 'failed'
                ? rawStatus
                : 'pending';

          const totalCandles =
            asNumber(
              record.total_candles,
            ) ??
            asNumber(
              record.estimated_candles,
            ) ??
            0;

          const processedCandles =
            asNumber(
              record.processed_candles,
            ) ??
            0;

          const explicitProgress =
            asNumber(
              record.progress_pct,
            );

          const progressPct =
            clamp(
              explicitProgress ??
                (
                  totalCandles > 0
                    ? processedCandles /
                      totalCandles *
                      100
                    : status ===
                        'completed'
                      ? 100
                      : 0
                ),
              0,
              100,
            );

          setRunProgress({
            status,
            progressPct,
            processedCandles,
            totalCandles,
            message:
              asString(
                record.progress_message,
              ) ||
              asString(
                record.message,
              ) ||
              (
                status === 'pending'
                  ? 'Aguardando o worker iniciar.'
                  : status === 'processing'
                    ? 'Processando o histórico em blocos.'
                    : status === 'completed'
                      ? 'Análise concluída.'
                      : 'A análise encontrou uma falha.'
              ),
            updatedAt:
              asString(
                record.updated_at,
              ) ||
              new Date().toISOString(),
          });

          if (status === 'failed') {
            setError(
              asString(
                record.error_message,
              ) ||
              'A análise aprofundada falhou.',
            );

            clearActiveRun();
            return;
          }

          if (status === 'completed') {
            const response =
              normalizeCompletedRunResponse(
                record,
                activeRun,
              );

            if (!response) {
              setError(
                'A análise foi concluída, mas o resultado salvo está vazio.',
              );

              clearActiveRun();
              return;
            }

            applyResponse(
              response,
              activeRun.mode,
            );

            clearActiveRun();
            setBusy(false);
            return;
          }

          timeoutId =
            window.setTimeout(
              () => {
                void poll();
              },
              POLL_INTERVAL_MS,
            );
        };

      void poll();

      return () => {
        cancelled =
          true;

        if (timeoutId !== null) {
          window.clearTimeout(
            timeoutId,
          );
        }
      };
    },
    [
      session,
      activeRun,
      supabase,
      applyResponse,
      clearActiveRun,
    ],
  );

  const run =
    useCallback(
      async () => {
        setBusy(true);
        setError('');
        setMarkdown('');
        setJson('');
        setCopied(null);

        try {
          if (activeRun) {
            throw new Error(
              'Já existe uma análise aprofundada em andamento.',
            );
          }

          const parsedRiskPercent =
            parseBoundedNumber(
              riskPercent,
              'O risco-base',
              0.01,
              2,
            );

          const parsedMinimumRiskPercent =
            parseBoundedNumber(
              minimumRiskPercent,
              'O risco mínimo',
              0.01,
              2,
            );

          const parsedMaximumRiskPercent =
            parseBoundedNumber(
              maximumRiskPercent,
              'O risco máximo',
              0.01,
              2,
            );

          const parsedWinMultiplier =
            parseBoundedNumber(
              winMultiplier,
              'O multiplicador por vitória',
              1,
              3,
            );

          const parsedLossMultiplier =
            parseBoundedNumber(
              lossMultiplier,
              'O fator após perda',
              0.01,
              1,
            );

          const parsedLossReductionStart =
            parseBoundedInteger(
              lossReductionStart,
              'O início da redução',
              1,
              10,
            );

          const parsedMartingaleLossMultiplier =
            parseBoundedNumber(
              martingaleLossMultiplier,
              'O multiplicador martingale',
              1,
              3,
            );

          const parsedMaximumMultiplier =
            parseBoundedNumber(
              maximumMultiplier,
              'O teto do anti-martingale',
              1,
              10,
            );

          const parsedMartingaleMaximumMultiplier =
            parseBoundedNumber(
              martingaleMaximumMultiplier,
              'O teto do martingale',
              1,
              64,
            );

          const parsedMaximumSequenceSteps =
            parseBoundedInteger(
              maximumSequenceSteps,
              'O limite da sequência',
              0,
              10,
            );

          const parsedPauseAfterConsecutiveLosses =
            parseBoundedInteger(
              pauseAfterConsecutiveLosses,
              'A pausa após perdas',
              0,
              20,
            );

          const parsedBalanceUsageLimitPct =
            parseBoundedNumber(
              balanceUsageLimitPct,
              'O uso máximo do saldo',
              1,
              100,
            );

          const parsedMinimumTrades =
            Number(
              minimumTradesForRanking,
            );

          if (
            moneyManagementMode !== 'fixed' &&
            parsedMinimumRiskPercent > parsedRiskPercent
          ) {
            throw new Error(
              'O risco mínimo não pode ser maior que o risco-base.',
            );
          }

          if (
            moneyManagementMode !== 'fixed' &&
            parsedMaximumRiskPercent < parsedRiskPercent
          ) {
            throw new Error(
              'O risco máximo não pode ser menor que o risco-base.',
            );
          }

          if (
            !Number.isInteger(
              parsedMinimumTrades,
            ) ||
            parsedMinimumTrades < 1
          ) {
            throw new Error(
              'A amostra mínima deve ser um inteiro maior ou igual a 1.',
            );
          }

          let historyRequest:
            Record<string, unknown>;

          if (
            historyMode ===
            'candle_count'
          ) {
            const parsedCandleCount =
              Number(candleCount);

            if (
              !Number.isInteger(
                parsedCandleCount,
              ) ||
              parsedCandleCount <
                MINIMUM_CANDLE_COUNT ||
              parsedCandleCount >
                MAXIMUM_CANDLE_COUNT
            ) {
              throw new Error(
                `Candles deve ser um inteiro entre ${MINIMUM_CANDLE_COUNT} e ${MAXIMUM_CANDLE_COUNT}.`,
              );
            }

            historyRequest = {
              history_mode:
                'candle_count',
              candle_count:
                parsedCandleCount,
            };
          } else {
            const dateRange =
              resolveDateRange(
                startDate,
                endDate,
                timeframe,
              );

            historyRequest = {
              history_mode:
                'date_range',
              start_time:
                dateRange.startTime,
              end_time:
                dateRange.endTime,
              estimated_candle_count:
                dateRange.estimatedCandles,
            };
          }

          const commonBody = {
            action: 'run',
            symbol,
            timeframe,
            ...historyRequest,
            backtest_options: {
              riskPercent:
                parsedRiskPercent,
            },
            money_management_options: {
              mode:
                moneyManagementMode,
              policyVersion:
                MONEY_MANAGEMENT_POLICY_VERSION,
              baseRiskPercent:
                parsedRiskPercent,
              minimumRiskPercent:
                moneyManagementMode === 'fixed'
                  ? parsedRiskPercent
                  : parsedMinimumRiskPercent,
              maximumRiskPercent:
                moneyManagementMode === 'fixed'
                  ? parsedRiskPercent
                  : parsedMaximumRiskPercent,
              winMultiplier:
                parsedWinMultiplier,
              lossMultiplier:
                parsedLossMultiplier,
              lossReductionStart:
                parsedLossReductionStart,
              martingaleLossMultiplier:
                parsedMartingaleLossMultiplier,
              maximumMultiplier:
                parsedMaximumMultiplier,
              martingaleMaximumMultiplier:
                parsedMartingaleMaximumMultiplier,
              maximumSequenceSteps:
                parsedMaximumSequenceSteps,
              pauseAfterConsecutiveLosses:
                parsedPauseAfterConsecutiveLosses,
              balanceUsageLimitPct:
                parsedBalanceUsageLimitPct,
              compareWithFixed:
                moneyManagementMode === 'fixed'
                  ? false
                  : compareWithFixed,
            },
          };

          const body =
            mode === 'compare_all'
              ? {
                  ...commonBody,
                  mode:
                    'compare_all',
                  comparison_options: {
                    minimumTradesForRanking:
                      parsedMinimumTrades,
                    continueOnStrategyError:
                      true,
                  },
                }
              : {
                  ...commonBody,
                  mode:
                    'single',
                  strategy,
                };

          const {
            data,
            error: functionError,
          } =
            await supabase.functions
              .invoke(
                'backtest-daytrade',
                {
                  body,
                },
              );

          if (functionError) {
            throw new Error(
              functionError.message,
            );
          }

          const response =
            asRecord(data);

          if (!response) {
            throw new Error(
              'A função retornou uma resposta inválida.',
            );
          }

          if (response.error) {
            throw new Error(
              String(
                response.error,
              ),
            );
          }

          const runId =
            getRunId(response);

          const queued =
            response.queued === true ||
            response.asynchronous === true ||
            asString(response.status) === 'pending' ||
            asString(response.status) === 'processing' ||
            runId !== '';

          if (queued) {
            if (!runId) {
              throw new Error(
                'A análise foi enfileirada, mas a função não retornou o ID.',
              );
            }

            const nextRun:
              ActiveRun = {
                id: runId,
                mode,
                strategy,
                symbol,
                timeframe,
                historyMode,
                startedAt:
                  new Date().toISOString(),
              };

            setActiveRun(
              nextRun,
            );

            setRunProgress({
              status: 'pending',
              progressPct: 0,
              processedCandles: 0,
              totalCandles:
                estimatedCandleCount,
              message:
                'Análise criada e aguardando processamento.',
              updatedAt:
                new Date().toISOString(),
            });

            window.localStorage
              .setItem(
                RUN_STORAGE_KEY,
                JSON.stringify(
                  nextRun,
                ),
              );

            return;
          }

          applyResponse(
            response,
            mode,
          );
        } catch (runError) {
          setError(
            runError instanceof Error
              ? runError.message
              : 'Erro ao executar o backtest.',
          );

          setBusy(false);
        } finally {
          if (!activeRun) {
            setBusy(false);
          }
        }
      },
      [
        activeRun,
        riskPercent,
        moneyManagementMode,
        minimumRiskPercent,
        maximumRiskPercent,
        winMultiplier,
        lossMultiplier,
        lossReductionStart,
        martingaleLossMultiplier,
        maximumMultiplier,
        martingaleMaximumMultiplier,
        maximumSequenceSteps,
        pauseAfterConsecutiveLosses,
        balanceUsageLimitPct,
        compareWithFixed,
        minimumTradesForRanking,
        historyMode,
        candleCount,
        startDate,
        endDate,
        timeframe,
        symbol,
        mode,
        strategy,
        supabase,
        applyResponse,
        estimatedCandleCount,
      ],
    );

  const copy =
    useCallback(
      async (
        text: string,
        target:
          | 'md'
          | 'json',
      ) => {
        try {
          await navigator
            .clipboard
            .writeText(text);

          setCopied(target);

          window.setTimeout(
            () =>
              setCopied(null),
            1500,
          );
        } catch {
          setError(
            'Não foi possível copiar automaticamente; selecione e copie manualmente.',
          );
        }
      },
      [],
    );

  return (
    <main
      style={{
        minHeight: '100vh',
        background:
          COLORS.background,
        color:
          COLORS.text,
        fontFamily:
          'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <header
        style={{
          borderBottom:
            `1px solid ${COLORS.border}`,
          background:
            COLORS.panel,
          padding:
            '12px 20px',
          textAlign:
            'center',
        }}
      >
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
          }}
        >
          Bancada de backtest
        </div>

        <div
          style={{
            fontSize: 11,
            color:
              COLORS.muted,
            marginTop: 2,
          }}
        >
          uso interno · quatro estratégias · risco fixo ou sequencial · histórico rápido ou aprofundado
        </div>
      </header>

      <div
        style={{
          maxWidth: 1120,
          margin: '0 auto',
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!authReady
          ? null
          : !session
            ? (
                <Card
                  style={{
                    textAlign:
                      'center',
                    color:
                      COLORS.muted,
                    fontSize: 14,
                  }}
                >
                  Faça login em{' '}
                  <a
                    href="/alertas"
                    style={{
                      color:
                        COLORS.accent,
                    }}
                  >
                    /alertas
                  </a>{' '}
                  neste navegador e recarregue esta página.
                </Card>
              )
            : (
                <>
                  <Card>
                    <div
                      style={{
                        display:
                          'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(150px, 1fr))',
                        gap: 12,
                        alignItems:
                          'end',
                      }}
                    >
                      <label style={labelStyle}>
                        Modo
                        <select
                          value={mode}
                          disabled={Boolean(activeRun)}
                          onChange={(event) =>
                            setMode(
                              event.target.value as BacktestMode,
                            )
                          }
                          style={inputStyle}
                        >
                          <option value="single">
                            Estratégia individual
                          </option>

                          <option value="compare_all">
                            Comparar todas
                          </option>
                        </select>
                      </label>

                      <label
                        style={{
                          ...labelStyle,
                          opacity:
                            mode === 'compare_all'
                              ? 0.5
                              : 1,
                        }}
                      >
                        Estratégia
                        <select
                          value={strategy}
                          disabled={
                            mode === 'compare_all' ||
                            Boolean(activeRun)
                          }
                          onChange={(event) =>
                            setStrategy(
                              event.target.value as StrategyId,
                            )
                          }
                          style={inputStyle}
                        >
                          {STRATEGIES.map((item) => (
                            <option
                              key={item.id}
                              value={item.id}
                            >
                              {item.shortLabel}
                              {item.executionMode === 'shadow'
                                ? ' · shadow'
                                : ''}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label style={labelStyle}>
                        Par
                        <select
                          value={symbol}
                          disabled={Boolean(activeRun)}
                          onChange={(event) =>
                            setSymbol(event.target.value)
                          }
                          style={inputStyle}
                        >
                          {SYMBOLS.map((item) => (
                            <option
                              key={item}
                              value={item}
                            >
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label style={labelStyle}>
                        Timeframe
                        <select
                          value={timeframe}
                          disabled={Boolean(activeRun)}
                          onChange={(event) =>
                            setTimeframe(event.target.value)
                          }
                          style={inputStyle}
                        >
                          {TIMEFRAMES.map((item) => (
                            <option
                              key={item}
                              value={item}
                            >
                              {item}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label style={labelStyle}>
                        Risco-base por operação (%)
                        <input
                          type="number"
                          min="0.01"
                          max="2"
                          step="0.05"
                          value={riskPercent}
                          disabled={Boolean(activeRun)}
                          onChange={(event) =>
                            setRiskPercent(event.target.value)
                          }
                          style={inputStyle}
                        />
                      </label>

                      <label
                        style={{
                          ...labelStyle,
                          opacity:
                            mode === 'single'
                              ? 0.5
                              : 1,
                        }}
                      >
                        Trades mínimos no ranking
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={minimumTradesForRanking}
                          disabled={
                            mode === 'single' ||
                            Boolean(activeRun)
                          }
                          onChange={(event) =>
                            setMinimumTradesForRanking(
                              event.target.value,
                            )
                          }
                          style={inputStyle}
                        />
                      </label>
                    </div>
                  </Card>

                  <Card>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                        gap: 12,
                        marginBottom: 14,
                      }}
                    >
                      <div style={{ flex: '1 1 320px' }}>
                        <strong style={{ fontSize: 14 }}>
                          Gerenciamento de posição
                        </strong>

                        <div
                          style={{
                            color: COLORS.muted,
                            fontSize: 11,
                            marginTop: 3,
                            lineHeight: 1.5,
                          }}
                        >
                          O caminho técnico da estratégia permanece igual. Apenas quantidade, risco em USDT, custos proporcionais, PnL e curva patrimonial são recalculados.
                        </div>
                      </div>

                      <label
                        style={{
                          ...labelStyle,
                          flex: '1 1 280px',
                          maxWidth: 420,
                        }}
                      >
                        Política
                        <select
                          value={moneyManagementMode}
                          disabled={Boolean(activeRun)}
                          onChange={(event) =>
                            setMoneyManagementMode(
                              event.target.value as MoneyManagementMode,
                            )
                          }
                          style={inputStyle}
                        >
                          <option value="fixed">
                            Risco fixo
                          </option>

                          <option value="anti_martingale">
                            Anti-martingale
                          </option>

                          <option value="martingale_testnet">
                            Martingale · somente backtest/Testnet
                          </option>
                        </select>
                      </label>
                    </div>

                    <div
                      style={{
                        border: `1px solid ${
                          moneyManagementMode === 'martingale_testnet'
                            ? 'rgba(208, 85, 85, 0.55)'
                            : COLORS.border
                        }`,
                        background:
                          moneyManagementMode === 'martingale_testnet'
                            ? 'rgba(208, 85, 85, 0.08)'
                            : COLORS.panelSoft,
                        borderRadius: 8,
                        padding: '10px 12px',
                        color:
                          moneyManagementMode === 'martingale_testnet'
                            ? COLORS.red
                            : COLORS.muted,
                        fontSize: 12,
                        lineHeight: 1.55,
                        marginBottom:
                          moneyManagementMode === 'fixed'
                            ? 0
                            : 14,
                      }}
                    >
                      <strong
                        style={{
                          color:
                            moneyManagementMode === 'martingale_testnet'
                              ? COLORS.red
                              : COLORS.text,
                        }}
                      >
                        {MONEY_MANAGEMENT_LABELS[moneyManagementMode]}
                      </strong>
                      {' — '}
                      {MONEY_MANAGEMENT_DESCRIPTIONS[moneyManagementMode]}
                      {moneyManagementMode === 'martingale_testnet'
                        ? ' Esta opção não autoriza nem deve ser transportada para operações com dinheiro real.'
                        : ''}
                    </div>

                    {moneyManagementMode !== 'fixed' && (
                      <>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns:
                              'repeat(auto-fit, minmax(155px, 1fr))',
                            gap: 12,
                            alignItems: 'end',
                          }}
                        >
                          <label style={labelStyle}>
                            Risco mínimo (%)
                            <input
                              type="number"
                              min="0.01"
                              max="2"
                              step="0.05"
                              value={minimumRiskPercent}
                              disabled={Boolean(activeRun)}
                              onChange={(event) =>
                                setMinimumRiskPercent(event.target.value)
                              }
                              style={inputStyle}
                            />
                          </label>

                          <label style={labelStyle}>
                            Risco máximo (%)
                            <input
                              type="number"
                              min="0.01"
                              max="2"
                              step="0.05"
                              value={maximumRiskPercent}
                              disabled={Boolean(activeRun)}
                              onChange={(event) =>
                                setMaximumRiskPercent(event.target.value)
                              }
                              style={inputStyle}
                            />
                          </label>

                          {moneyManagementMode === 'anti_martingale'
                            ? (
                                <>
                                  <label style={labelStyle}>
                                    Multiplicador por vitória
                                    <input
                                      type="number"
                                      min="1"
                                      max="3"
                                      step="0.05"
                                      value={winMultiplier}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setWinMultiplier(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>

                                  <label style={labelStyle}>
                                    Redução após perda
                                    <input
                                      type="number"
                                      min="0.01"
                                      max="1"
                                      step="0.05"
                                      value={lossMultiplier}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setLossMultiplier(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>

                                  <label style={labelStyle}>
                                    Reduzir a partir da perda nº
                                    <input
                                      type="number"
                                      min="1"
                                      max="10"
                                      step="1"
                                      value={lossReductionStart}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setLossReductionStart(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>

                                  <label style={labelStyle}>
                                    Teto do multiplicador
                                    <input
                                      type="number"
                                      min="1"
                                      max="10"
                                      step="0.05"
                                      value={maximumMultiplier}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setMaximumMultiplier(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>
                                </>
                              )
                            : (
                                <>
                                  <label style={labelStyle}>
                                    Multiplicador após perda
                                    <input
                                      type="number"
                                      min="1"
                                      max="3"
                                      step="0.1"
                                      value={martingaleLossMultiplier}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setMartingaleLossMultiplier(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>

                                  <label style={labelStyle}>
                                    Teto do martingale
                                    <input
                                      type="number"
                                      min="1"
                                      max="64"
                                      step="0.5"
                                      value={martingaleMaximumMultiplier}
                                      disabled={Boolean(activeRun)}
                                      onChange={(event) =>
                                        setMartingaleMaximumMultiplier(event.target.value)
                                      }
                                      style={inputStyle}
                                    />
                                  </label>
                                </>
                              )}

                          <label style={labelStyle}>
                            Máximo de etapas
                            <input
                              type="number"
                              min="0"
                              max="10"
                              step="1"
                              value={maximumSequenceSteps}
                              disabled={Boolean(activeRun)}
                              onChange={(event) =>
                                setMaximumSequenceSteps(event.target.value)
                              }
                              style={inputStyle}
                            />
                          </label>

                          <label style={labelStyle}>
                            Sinalizar pausa após perdas
                            <input
                              type="number"
                              min="0"
                              max="20"
                              step="1"
                              value={pauseAfterConsecutiveLosses}
                              disabled={Boolean(activeRun)}
                              onChange={(event) =>
                                setPauseAfterConsecutiveLosses(event.target.value)
                              }
                              style={inputStyle}
                            />
                          </label>

                          <label style={labelStyle}>
                            Uso máximo do saldo (%)
                            <input
                              type="number"
                              min="1"
                              max="100"
                              step="1"
                              value={balanceUsageLimitPct}
                              disabled={Boolean(activeRun)}
                              onChange={(event) =>
                                setBalanceUsageLimitPct(event.target.value)
                              }
                              style={inputStyle}
                            />
                          </label>
                        </div>

                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 9,
                            marginTop: 14,
                            color: COLORS.muted,
                            fontSize: 12,
                            cursor: activeRun ? 'not-allowed' : 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={compareWithFixed}
                            disabled={Boolean(activeRun)}
                            onChange={(event) =>
                              setCompareWithFixed(event.target.checked)
                            }
                          />
                          Comparar o resultado com a mesma sequência em risco fixo
                        </label>
                      </>
                    )}
                  </Card>

                  <Card>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 10,
                        marginBottom: 14,
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: 14 }}>
                          Histórico da análise
                        </strong>

                        <div
                          style={{
                            color: COLORS.muted,
                            fontSize: 11,
                            marginTop: 3,
                          }}
                        >
                          Use candles para testes rápidos ou datas para análises aprofundadas.
                        </div>
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <button
                          type="button"
                          disabled={Boolean(activeRun)}
                          onClick={() =>
                            setHistoryMode('candle_count')
                          }
                          style={{
                            ...secondaryButtonStyle,
                            background:
                              historyMode === 'candle_count'
                                ? COLORS.accent
                                : 'transparent',
                            color:
                              historyMode === 'candle_count'
                                ? COLORS.accentText
                                : COLORS.accent,
                          }}
                        >
                          Quantidade de candles
                        </button>

                        <button
                          type="button"
                          disabled={Boolean(activeRun)}
                          onClick={() =>
                            setHistoryMode('date_range')
                          }
                          style={{
                            ...secondaryButtonStyle,
                            background:
                              historyMode === 'date_range'
                                ? COLORS.accent
                                : 'transparent',
                            color:
                              historyMode === 'date_range'
                                ? COLORS.accentText
                                : COLORS.accent,
                          }}
                        >
                          Período por datas
                        </button>
                      </div>
                    </div>

                    {historyMode === 'candle_count'
                      ? (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns:
                                'repeat(auto-fit, minmax(180px, 1fr))',
                              gap: 12,
                              alignItems: 'end',
                            }}
                          >
                            <label style={labelStyle}>
                              Candles
                              <input
                                type="number"
                                min={MINIMUM_CANDLE_COUNT}
                                max={MAXIMUM_CANDLE_COUNT}
                                step="50"
                                value={candleCount}
                                disabled={Boolean(activeRun)}
                                onChange={(event) =>
                                  setCandleCount(event.target.value)
                                }
                                style={inputStyle}
                              />
                            </label>

                            <div
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 7,
                                padding: '9px 11px',
                                fontSize: 12,
                                color: COLORS.muted,
                                textAlign: 'center',
                              }}
                            >
                              Limite rápido atual: <strong style={{ color: COLORS.text }}>3.000 candles</strong>
                            </div>
                          </div>
                        )
                      : (
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns:
                                'repeat(auto-fit, minmax(150px, 1fr))',
                              gap: 12,
                              alignItems: 'end',
                            }}
                          >
                            <label style={labelStyle}>
                              Período
                              <select
                                value={periodPreset}
                                disabled={Boolean(activeRun)}
                                onChange={(event) =>
                                  setPeriodPreset(
                                    event.target.value as PeriodPreset,
                                  )
                                }
                                style={inputStyle}
                              >
                                {(Object.keys(PRESET_LABELS) as PeriodPreset[]).map((item) => (
                                  <option
                                    key={item}
                                    value={item}
                                  >
                                    {PRESET_LABELS[item]}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label style={labelStyle}>
                              Data inicial
                              <input
                                type="date"
                                value={startDate}
                                disabled={Boolean(activeRun)}
                                onChange={(event) => {
                                  setStartDate(event.target.value);
                                  setPeriodPreset('custom');
                                }}
                                style={inputStyle}
                              />
                            </label>

                            <label style={labelStyle}>
                              Data final
                              <input
                                type="date"
                                value={endDate}
                                disabled={Boolean(activeRun)}
                                onChange={(event) => {
                                  setEndDate(event.target.value);
                                  setPeriodPreset('custom');
                                }}
                                style={inputStyle}
                              />
                            </label>

                            <div
                              style={{
                                border: `1px solid ${COLORS.border}`,
                                borderRadius: 7,
                                padding: '8px 10px',
                                textAlign: 'center',
                                fontSize: 11,
                                color: COLORS.muted,
                                lineHeight: 1.45,
                              }}
                            >
                              {dateRangePreview
                                ? (
                                    <>
                                      <strong style={{ color: COLORS.text }}>
                                        {dateRangePreview.estimatedCandles.toLocaleString('pt-BR')}
                                      </strong>{' '}
                                      candles estimados em{' '}
                                      <strong style={{ color: COLORS.text }}>
                                        {dateRangePreview.days}
                                      </strong>{' '}
                                      dias
                                    </>
                                  )
                                : 'Período inválido ou curto demais'}
                            </div>
                          </div>
                        )}

                    <div
                      style={{
                        marginTop: 13,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 10,
                        borderTop: `1px solid ${COLORS.border}`,
                        paddingTop: 13,
                      }}
                    >
                      <div
                        style={{
                          color: COLORS.muted,
                          fontSize: 11,
                          lineHeight: 1.5,
                        }}
                      >
                        Execução prevista:{' '}
                        <strong
                          style={{
                            color:
                              expectedExecutionMode === 'async'
                                ? COLORS.blue
                                : COLORS.green,
                          }}
                        >
                          {expectedExecutionMode === 'async'
                            ? 'assíncrona em blocos'
                            : 'imediata'}
                        </strong>
                        {' · '}
                        {estimatedCandleCount > 0
                          ? `${Math.trunc(estimatedCandleCount).toLocaleString('pt-BR')} candles`
                          : 'aguardando período válido'}
                      </div>

                      <button
                        type="button"
                        disabled={
                          busy ||
                          Boolean(activeRun)
                        }
                        onClick={() => {
                          void run();
                        }}
                        style={{
                          background:
                            busy || activeRun
                              ? COLORS.border
                              : COLORS.accent,
                          color:
                            busy || activeRun
                              ? COLORS.muted
                              : COLORS.accentText,
                          border: 0,
                          borderRadius: 7,
                          padding: '10px 18px',
                          fontWeight: 800,
                          fontSize: 13,
                          cursor:
                            busy || activeRun
                              ? 'not-allowed'
                              : 'pointer',
                        }}
                      >
                        {activeRun
                          ? 'Análise em andamento'
                          : busy
                            ? 'Iniciando...'
                            : expectedExecutionMode === 'async'
                              ? 'Iniciar análise aprofundada'
                              : 'Executar backtest'}
                      </button>
                    </div>
                  </Card>

                  <Card>
                    {mode === 'compare_all'
                      ? (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <strong style={{ fontSize: 13 }}>
                              Comparação das quatro estratégias
                            </strong>

                            <span
                              style={{
                                color: COLORS.muted,
                                fontSize: 12,
                                lineHeight: 1.5,
                              }}
                            >
                              Todas recebem o mesmo par, timeframe, período, capital, risco, taxas e slippage. Cada estratégia mantém uma simulação independente.
                            </span>

                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 8,
                              }}
                            >
                              {STRATEGIES.map((item) => (
                                <div
                                  key={item.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    border: `1px solid ${COLORS.border}`,
                                    borderRadius: 7,
                                    padding: '5px 8px',
                                    fontSize: 11,
                                  }}
                                >
                                  <span>{item.shortLabel}</span>
                                  <ModeBadge mode={item.executionMode} />
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      : (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 7,
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                                gap: 8,
                              }}
                            >
                              <strong style={{ fontSize: 13 }}>
                                {selectedStrategy.label}
                              </strong>

                              <ModeBadge mode={selectedStrategy.executionMode} />
                            </div>

                            <span
                              style={{
                                color: COLORS.muted,
                                fontSize: 12,
                                lineHeight: 1.5,
                              }}
                            >
                              {selectedStrategy.description}
                            </span>
                          </div>
                        )}
                  </Card>

                  {activeRun && runProgress && (
                    <Card>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 10,
                          marginBottom: 12,
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: 14 }}>
                            Análise aprofundada
                          </strong>

                          <div
                            style={{
                              color: COLORS.muted,
                              fontSize: 11,
                              marginTop: 3,
                            }}
                          >
                            {activeRun.symbol} · {activeRun.timeframe} · ID {activeRun.id.slice(0, 8)}…
                          </div>
                        </div>

                        <StatusBadge status={runProgress.status} />

                        {runProgress.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => void cancelActiveRun()}
                            style={{
                              background: 'transparent',
                              color: COLORS.red,
                              border: `1px solid ${COLORS.red}`,
                              borderRadius: 8,
                              padding: '4px 10px',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            Cancelar análise
                          </button>
                        )}
                      </div>

                      <div
                        style={{
                          width: '100%',
                          height: 10,
                          background: COLORS.background,
                          borderRadius: 999,
                          overflow: 'hidden',
                          border: `1px solid ${COLORS.border}`,
                        }}
                      >
                        <div
                          style={{
                            width: `${runProgress.progressPct}%`,
                            height: '100%',
                            background:
                              runProgress.status === 'failed'
                                ? COLORS.red
                                : runProgress.status === 'completed'
                                  ? COLORS.green
                                  : COLORS.blue,
                            transition: 'width 300ms ease',
                          }}
                        />
                      </div>

                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          flexWrap: 'wrap',
                          gap: 8,
                          marginTop: 9,
                          color: COLORS.muted,
                          fontSize: 11,
                        }}
                      >
                        <span>
                          {runProgress.message}
                        </span>

                        <span>
                          {formatInteger(runProgress.processedCandles)} de{' '}
                          {formatInteger(runProgress.totalCandles)} candles ·{' '}
                          {formatNumber(runProgress.progressPct, 1)}%
                        </span>
                      </div>
                    </Card>
                  )}

                  <div
                    style={{
                      fontSize: 11,
                      color: COLORS.muted,
                      textAlign: 'center',
                      lineHeight: 1.5,
                    }}
                  >
                    Até 3.000 candles a resposta é imediata. Períodos maiores são processados em segundo plano e continuam disponíveis após recarregar a página.
                  </div>

                  {error && (
                    <Card
                      style={{
                        color: COLORS.red,
                        fontSize: 13,
                        textAlign: 'center',
                      }}
                    >
                      {error}
                    </Card>
                  )}

                  {markdown && (
                    <Card>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12,
                          marginBottom: 8,
                        }}
                      >
                        <strong style={{ fontSize: 14 }}>
                          Resumo em Markdown
                        </strong>

                        <button
                          type="button"
                          onClick={() =>
                            copy(markdown, 'md')
                          }
                          style={{
                            ...secondaryButtonStyle,
                            color:
                              copied === 'md'
                                ? COLORS.green
                                : COLORS.accent,
                            borderColor:
                              copied === 'md'
                                ? COLORS.green
                                : COLORS.accent,
                          }}
                        >
                          {copied === 'md'
                            ? 'Copiado ✓'
                            : 'Copiar'}
                        </button>
                      </div>

                      <textarea
                        readOnly
                        value={markdown}
                        style={textareaStyle}
                        onFocus={(event) =>
                          event.currentTarget.select()
                        }
                      />
                    </Card>
                  )}

                  {json && (
                    <Card>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 12,
                          marginBottom: 8,
                        }}
                      >
                        <strong style={{ fontSize: 14 }}>
                          JSON completo
                        </strong>

                        <button
                          type="button"
                          onClick={() =>
                            copy(json, 'json')
                          }
                          style={{
                            ...secondaryButtonStyle,
                            color:
                              copied === 'json'
                                ? COLORS.green
                                : COLORS.accent,
                            borderColor:
                              copied === 'json'
                                ? COLORS.green
                                : COLORS.accent,
                          }}
                        >
                          {copied === 'json'
                            ? 'Copiado ✓'
                            : 'Copiar'}
                        </button>
                      </div>

                      <textarea
                        readOnly
                        value={json}
                        style={{
                          ...textareaStyle,
                          minHeight: 380,
                        }}
                        onFocus={(event) =>
                          event.currentTarget.select()
                        }
                      />
                    </Card>
                  )}
                </>
              )}
      </div>
    </main>
  );
}
