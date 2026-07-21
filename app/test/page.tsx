'use client';

/**
 * app/test/page.tsx — VigIA Trade
 * -----------------------------------------------------------------------------
 * Bancada interna de backtest multiestratégia.
 *
 * Modos:
 * - estratégia individual;
 * - comparação das quatro estratégias no mesmo histórico.
 *
 * A página chama a Edge Function backtest-daytrade autenticada pela sessão
 * atual do Supabase e oferece saída em Markdown e JSON.
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

interface StrategyOption {
  id: StrategyId;
  label: string;
  shortLabel: string;
  description: string;
  executionMode:
    | 'testnet_allowed'
    | 'shadow';
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

// -----------------------------------------------------------------------------
// Helpers
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
  return (
    typeof value === 'number' &&
    Number.isFinite(value)
  )
    ? value
    : null;
}

function asString(
  value: unknown,
): string {
  return typeof value === 'string'
    ? value
    : '';
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
    `| Operações executadas | ${formatInteger(metrics.enteredTrades)} |`,
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
      comparison
        .provisionalRanking,
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

  const period =
    formatDateRange(
      comparison
        .firstCandleOpenTime,
      comparison
        .lastCandleCloseTime,
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
    const mode =
      row.executionMode ===
        'shadow'
        ? 'Shadow'
        : 'Testnet';

    lines.push(
      `| ${String(row.shortLabel ?? row.label ?? row.strategy ?? '—')} | ${mode} | ${formatInteger(row.totalTrades)} | ${formatNumber(row.winRatePct)}% | ${formatNumber(row.netReturnPct)}% | ${formatNumber(row.netPnlUsdt)} | ${formatProfitFactor(row.profitFactor)} | ${formatNumber(row.averageR)} | ${formatNumber(row.maximumDrawdownPct)}% | ${String(row.sampleQuality ?? '—')} |`,
    );
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
    candleCount,
    setCandleCount,
  ] = useState('3000');

  const [
    riskPercent,
    setRiskPercent,
  ] = useState('1');

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

  const selectedStrategy =
    getStrategy(strategy);

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

  const run =
    useCallback(
      async () => {
        setBusy(true);
        setError('');
        setMarkdown('');
        setJson('');
        setCopied(null);

        try {
          const parsedCandleCount =
            Number(candleCount);

          const parsedRiskPercent =
            Number(riskPercent);

          const parsedMinimumTrades =
            Number(
              minimumTradesForRanking,
            );

          if (
            !Number.isInteger(
              parsedCandleCount,
            ) ||
            parsedCandleCount < 350 ||
            parsedCandleCount > 3000
          ) {
            throw new Error(
              'Candles deve ser um inteiro entre 350 e 3000.',
            );
          }

          if (
            !Number.isFinite(
              parsedRiskPercent,
            ) ||
            parsedRiskPercent <= 0 ||
            parsedRiskPercent > 2
          ) {
            throw new Error(
              'O risco deve ser maior que zero e no máximo 2%.',
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

          const body =
            mode === 'compare_all'
              ? {
                  mode:
                    'compare_all',

                  symbol,

                  timeframe,

                  candle_count:
                    parsedCandleCount,

                  backtest_options: {
                    riskPercent:
                      parsedRiskPercent,
                  },

                  comparison_options: {
                    minimumTradesForRanking:
                      parsedMinimumTrades,

                    continueOnStrategyError:
                      true,
                  },
                }
              : {
                  mode:
                    'single',

                  strategy,

                  symbol,

                  timeframe,

                  candle_count:
                    parsedCandleCount,

                  backtest_options: {
                    riskPercent:
                      parsedRiskPercent,
                  },
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

          setJson(
            JSON.stringify(
              response,
              null,
              2,
            ),
          );

          setMarkdown(
            mode === 'compare_all'
              ? buildComparisonMarkdown(
                  response,
                )
              : buildSingleMarkdown(
                  response,
                ),
          );
        } catch (runError) {
          setError(
            runError instanceof Error
              ? runError.message
              : 'Erro ao executar o backtest.',
          );
        } finally {
          setBusy(false);
        }
      },
      [
        supabase,
        mode,
        strategy,
        symbol,
        timeframe,
        candleCount,
        riskPercent,
        minimumTradesForRanking,
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
          uso interno · quatro estratégias · execução individual ou comparativa
        </div>
      </header>

      <div
        style={{
          maxWidth: 1100,
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
                          'repeat(auto-fit, minmax(155px, 1fr))',
                        gap: 12,
                        alignItems:
                          'end',
                      }}
                    >
                      <label
                        style={
                          labelStyle
                        }
                      >
                        Modo
                        <select
                          value={
                            mode
                          }
                          onChange={(
                            event,
                          ) =>
                            setMode(
                              event
                                .target
                                .value as BacktestMode,
                            )
                          }
                          style={
                            inputStyle
                          }
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
                            mode ===
                            'compare_all'
                              ? 0.5
                              : 1,
                        }}
                      >
                        Estratégia
                        <select
                          value={
                            strategy
                          }
                          disabled={
                            mode ===
                            'compare_all'
                          }
                          onChange={(
                            event,
                          ) =>
                            setStrategy(
                              event
                                .target
                                .value as StrategyId,
                            )
                          }
                          style={{
                            ...inputStyle,
                            cursor:
                              mode ===
                              'compare_all'
                                ? 'not-allowed'
                                : 'pointer',
                          }}
                        >
                          {STRATEGIES.map(
                            (
                              item,
                            ) => (
                              <option
                                key={
                                  item.id
                                }
                                value={
                                  item.id
                                }
                              >
                                {item.shortLabel}
                                {item.executionMode ===
                                'shadow'
                                  ? ' · shadow'
                                  : ''}
                              </option>
                            ),
                          )}
                        </select>
                      </label>

                      <label
                        style={
                          labelStyle
                        }
                      >
                        Par
                        <select
                          value={
                            symbol
                          }
                          onChange={(
                            event,
                          ) =>
                            setSymbol(
                              event
                                .target
                                .value,
                            )
                          }
                          style={
                            inputStyle
                          }
                        >
                          {SYMBOLS.map(
                            (
                              item,
                            ) => (
                              <option
                                key={
                                  item
                                }
                                value={
                                  item
                                }
                              >
                                {item}
                              </option>
                            ),
                          )}
                        </select>
                      </label>

                      <label
                        style={
                          labelStyle
                        }
                      >
                        Timeframe
                        <select
                          value={
                            timeframe
                          }
                          onChange={(
                            event,
                          ) =>
                            setTimeframe(
                              event
                                .target
                                .value,
                            )
                          }
                          style={
                            inputStyle
                          }
                        >
                          {TIMEFRAMES.map(
                            (
                              item,
                            ) => (
                              <option
                                key={
                                  item
                                }
                                value={
                                  item
                                }
                              >
                                {item}
                              </option>
                            ),
                          )}
                        </select>
                      </label>

                      <label
                        style={
                          labelStyle
                        }
                      >
                        Candles
                        <input
                          type="number"
                          min="350"
                          max="3000"
                          value={
                            candleCount
                          }
                          onChange={(
                            event,
                          ) =>
                            setCandleCount(
                              event
                                .target
                                .value,
                            )
                          }
                          style={
                            inputStyle
                          }
                        />
                      </label>

                      <label
                        style={
                          labelStyle
                        }
                      >
                        Risco por trade
                        <div
                          style={{
                            display:
                              'flex',
                            alignItems:
                              'center',
                            gap: 5,
                          }}
                        >
                          <input
                            type="number"
                            min="0.01"
                            max="2"
                            step="0.25"
                            value={
                              riskPercent
                            }
                            onChange={(
                              event,
                            ) =>
                              setRiskPercent(
                                event
                                  .target
                                  .value,
                              )
                            }
                            style={{
                              ...inputStyle,
                              width:
                                '100%',
                            }}
                          />

                          <span>
                            %
                          </span>
                        </div>
                      </label>

                      {mode ===
                        'compare_all' && (
                        <label
                          style={
                            labelStyle
                          }
                        >
                          Amostra mínima
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={
                              minimumTradesForRanking
                            }
                            onChange={(
                              event,
                            ) =>
                              setMinimumTradesForRanking(
                                event
                                  .target
                                  .value,
                              )
                            }
                            style={
                              inputStyle
                            }
                          />
                        </label>
                      )}

                      <button
                        type="button"
                        onClick={
                          run
                        }
                        disabled={
                          busy
                        }
                        style={{
                          background:
                            COLORS.accent,
                          color:
                            COLORS.accentText,
                          border:
                            'none',
                          borderRadius:
                            8,
                          padding:
                            '10px 18px',
                          fontSize:
                            14,
                          fontWeight:
                            700,
                          cursor:
                            busy
                              ? 'wait'
                              : 'pointer',
                          opacity:
                            busy
                              ? 0.6
                              : 1,
                          minHeight:
                            39,
                        }}
                      >
                        {busy
                          ? mode ===
                            'compare_all'
                            ? 'Comparando...'
                            : 'Executando...'
                          : mode ===
                            'compare_all'
                            ? 'Comparar estratégias'
                            : 'Rodar backtest'}
                      </button>
                    </div>
                  </Card>

                  <Card
                    style={{
                      background:
                        COLORS.panelSoft,
                    }}
                  >
                    {mode ===
                    'compare_all' ? (
                      <div
                        style={{
                          display:
                            'flex',
                          flexDirection:
                            'column',
                          gap: 8,
                        }}
                      >
                        <strong
                          style={{
                            fontSize:
                              13,
                          }}
                        >
                          Comparação das quatro estratégias
                        </strong>

                        <span
                          style={{
                            color:
                              COLORS.muted,
                            fontSize:
                              12,
                            lineHeight:
                              1.5,
                          }}
                        >
                          Todas recebem o mesmo par, timeframe, período, capital, risco, taxas e slippage. Cada uma mantém uma simulação independente com uma posição por vez.
                        </span>

                        <div
                          style={{
                            display:
                              'flex',
                            flexWrap:
                              'wrap',
                            gap: 8,
                          }}
                        >
                          {STRATEGIES.map(
                            (
                              item,
                            ) => (
                              <div
                                key={
                                  item.id
                                }
                                style={{
                                  display:
                                    'flex',
                                  alignItems:
                                    'center',
                                  gap: 6,
                                  border:
                                    `1px solid ${COLORS.border}`,
                                  borderRadius:
                                    7,
                                  padding:
                                    '5px 8px',
                                  fontSize:
                                    11,
                                }}
                              >
                                <span>
                                  {item.shortLabel}
                                </span>

                                <ModeBadge
                                  mode={
                                    item.executionMode
                                  }
                                />
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          display:
                            'flex',
                          flexDirection:
                            'column',
                          gap: 7,
                        }}
                      >
                        <div
                          style={{
                            display:
                              'flex',
                            alignItems:
                              'center',
                            flexWrap:
                              'wrap',
                            gap: 8,
                          }}
                        >
                          <strong
                            style={{
                              fontSize:
                                13,
                            }}
                          >
                            {selectedStrategy.label}
                          </strong>

                          <ModeBadge
                            mode={
                              selectedStrategy.executionMode
                            }
                          />
                        </div>

                        <span
                          style={{
                            color:
                              COLORS.muted,
                            fontSize:
                              12,
                            lineHeight:
                              1.5,
                          }}
                        >
                          {selectedStrategy.description}
                        </span>
                      </div>
                    )}
                  </Card>

                  <div
                    style={{
                      fontSize:
                        11,
                      color:
                        COLORS.muted,
                      textAlign:
                        'center',
                      lineHeight:
                        1.5,
                    }}
                  >
                    3000 candles em 1h representam aproximadamente 125 dias. Os timeframes menores cobrem períodos mais curtos por chamada.
                  </div>

                  {error && (
                    <Card
                      style={{
                        color:
                          COLORS.red,
                        fontSize:
                          13,
                        textAlign:
                          'center',
                      }}
                    >
                      {error}
                    </Card>
                  )}

                  {markdown && (
                    <Card>
                      <div
                        style={{
                          display:
                            'flex',
                          justifyContent:
                            'space-between',
                          alignItems:
                            'center',
                          gap: 12,
                          marginBottom:
                            8,
                        }}
                      >
                        <strong
                          style={{
                            fontSize:
                              14,
                          }}
                        >
                          Resumo em Markdown
                        </strong>

                        <button
                          type="button"
                          onClick={() =>
                            copy(
                              markdown,
                              'md',
                            )
                          }
                          style={{
                            ...secondaryButtonStyle,
                            color:
                              copied ===
                              'md'
                                ? COLORS.green
                                : COLORS.accent,
                            borderColor:
                              copied ===
                              'md'
                                ? COLORS.green
                                : COLORS.accent,
                          }}
                        >
                          {copied ===
                          'md'
                            ? 'Copiado ✓'
                            : 'Copiar'}
                        </button>
                      </div>

                      <textarea
                        readOnly
                        value={
                          markdown
                        }
                        style={
                          textareaStyle
                        }
                        onFocus={(
                          event,
                        ) =>
                          event
                            .currentTarget
                            .select()
                        }
                      />
                    </Card>
                  )}

                  {json && (
                    <Card>
                      <div
                        style={{
                          display:
                            'flex',
                          justifyContent:
                            'space-between',
                          alignItems:
                            'center',
                          gap: 12,
                          marginBottom:
                            8,
                        }}
                      >
                        <strong
                          style={{
                            fontSize:
                              14,
                          }}
                        >
                          JSON completo
                        </strong>

                        <button
                          type="button"
                          onClick={() =>
                            copy(
                              json,
                              'json',
                            )
                          }
                          style={{
                            ...secondaryButtonStyle,
                            color:
                              copied ===
                              'json'
                                ? COLORS.green
                                : COLORS.accent,
                            borderColor:
                              copied ===
                              'json'
                                ? COLORS.green
                                : COLORS.accent,
                          }}
                        >
                          {copied ===
                          'json'
                            ? 'Copiado ✓'
                            : 'Copiar'}
                        </button>
                      </div>

                      <textarea
                        readOnly
                        value={
                          json
                        }
                        style={{
                          ...textareaStyle,
                          minHeight:
                            380,
                        }}
                        onFocus={(
                          event,
                        ) =>
                          event
                            .currentTarget
                            .select()
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