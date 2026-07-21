/**
 * lib/daytrade/strategies/index.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Registro central dos playbooks disponíveis no módulo de Day Trade.
 *
 * Responsabilidades:
 * - Reexportar tipos, constantes e funções das estratégias.
 * - Expor metadados estáveis para interface, backtest e avaliadores.
 * - Definir explicitamente quais estratégias podem criar ordens.
 *
 * Regra de segurança atual:
 * - trend_breakout: autorizado para oportunidades e ordens Testnet.
 * - trend_pullback: somente observação e comparação.
 * - squeeze_breakout: somente observação e comparação.
 * - range_mean_reversion: somente observação e comparação.
 */

import {
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_BREAKOUT_STRATEGY_VERSION,
} from './trendBreakout';

import {
  TREND_PULLBACK_STRATEGY_ID,
  TREND_PULLBACK_STRATEGY_VERSION,
} from './trendPullback';

import {
  SQUEEZE_BREAKOUT_STRATEGY_ID,
  SQUEEZE_BREAKOUT_STRATEGY_VERSION,
} from './squeezeBreakout';

import {
  RANGE_MEAN_REVERSION_STRATEGY_ID,
  RANGE_MEAN_REVERSION_STRATEGY_VERSION,
} from './rangeMeanReversion';

// -----------------------------------------------------------------------------
// Reexports
// -----------------------------------------------------------------------------

export * from './trendBreakout';
export * from './trendPullback';
export * from './squeezeBreakout';
export * from './rangeMeanReversion';

// -----------------------------------------------------------------------------
// Tipos do registro
// -----------------------------------------------------------------------------

export type DayTradeStrategyId =
  | typeof TREND_BREAKOUT_STRATEGY_ID
  | typeof TREND_PULLBACK_STRATEGY_ID
  | typeof SQUEEZE_BREAKOUT_STRATEGY_ID
  | typeof RANGE_MEAN_REVERSION_STRATEGY_ID;

export type DayTradeStrategyVersion =
  | typeof TREND_BREAKOUT_STRATEGY_VERSION
  | typeof TREND_PULLBACK_STRATEGY_VERSION
  | typeof SQUEEZE_BREAKOUT_STRATEGY_VERSION
  | typeof RANGE_MEAN_REVERSION_STRATEGY_VERSION;

export type DayTradeStrategyCategory =
  | 'trend_following'
  | 'mean_reversion';

export type DayTradeStrategyExecutionMode =
  | 'testnet_allowed'
  | 'shadow';

export type DayTradeMarketRegime =
  | 'tendência'
  | 'compressão'
  | 'lateralidade';

export interface DayTradeStrategyDefinition {
  id: DayTradeStrategyId;
  version: DayTradeStrategyVersion;

  label: string;
  shortLabel: string;
  description: string;

  category: DayTradeStrategyCategory;
  preferredRegimes: readonly DayTradeMarketRegime[];

  /**
   * testnet_allowed:
   * pode gerar oportunidade automática e chegar ao executor Testnet.
   *
   * shadow:
   * pode ser calculada, salva e comparada, mas não pode criar ordens.
   */
  executionMode: DayTradeStrategyExecutionMode;

  /**
   * Trava explícita para qualquer fluxo que possa criar oportunidade ou ordem.
   */
  authorizedForAutomaticOrders: boolean;

  /**
   * Permite exibir e executar backtest da estratégia.
   */
  enabledForBacktest: boolean;

  /**
   * Permite salvar avaliações históricas em daytrade_setups.
   */
  enabledForPersistence: boolean;

  /**
   * Ordem sugerida para apresentação na interface.
   */
  displayOrder: number;
}

// -----------------------------------------------------------------------------
// Registro
// -----------------------------------------------------------------------------

export const DEFAULT_DAYTRADE_STRATEGY_ID =
  TREND_BREAKOUT_STRATEGY_ID;

export const DAYTRADE_STRATEGY_REGISTRY = {
  [TREND_BREAKOUT_STRATEGY_ID]: {
    id: TREND_BREAKOUT_STRATEGY_ID,
    version: TREND_BREAKOUT_STRATEGY_VERSION,
    label: 'Tendência com rompimento',
    shortLabel: 'Trend Breakout',
    description:
      'Busca tendência positiva, alinhamento das médias, rompimento confirmado, volume e plano mínimo de risco e retorno.',
    category: 'trend_following',
    preferredRegimes: ['tendência'],
    executionMode: 'testnet_allowed',
    authorizedForAutomaticOrders: true,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 1,
  },

  [TREND_PULLBACK_STRATEGY_ID]: {
    id: TREND_PULLBACK_STRATEGY_ID,
    version: TREND_PULLBACK_STRATEGY_VERSION,
    label: 'Pullback na tendência',
    shortLabel: 'Trend Pullback',
    description:
      'Procura recuo controlado até a zona das médias e recuperação confirmada dentro de uma tendência positiva.',
    category: 'trend_following',
    preferredRegimes: ['tendência'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 2,
  },

  [SQUEEZE_BREAKOUT_STRATEGY_ID]: {
    id: SQUEEZE_BREAKOUT_STRATEGY_ID,
    version: SQUEEZE_BREAKOUT_STRATEGY_VERSION,
    label: 'Rompimento de compressão',
    shortLabel: 'Squeeze Breakout',
    description:
      'Procura redução de amplitude seguida por rompimento confirmado com expansão de volume.',
    category: 'trend_following',
    preferredRegimes: ['compressão', 'tendência'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 3,
  },

  [RANGE_MEAN_REVERSION_STRATEGY_ID]: {
    id: RANGE_MEAN_REVERSION_STRATEGY_ID,
    version: RANGE_MEAN_REVERSION_STRATEGY_VERSION,
    label: 'Reversão à média na faixa',
    shortLabel: 'Range Mean Reversion',
    description:
      'Procura preço descontado próximo ao suporte de uma faixa lateral, com recuperação em direção à média recente.',
    category: 'mean_reversion',
    preferredRegimes: ['lateralidade'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 4,
  },
} as const satisfies Record<
  DayTradeStrategyId,
  DayTradeStrategyDefinition
>;

// -----------------------------------------------------------------------------
// Listas derivadas
// -----------------------------------------------------------------------------

export const DAYTRADE_STRATEGY_IDS = [
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_PULLBACK_STRATEGY_ID,
  SQUEEZE_BREAKOUT_STRATEGY_ID,
  RANGE_MEAN_REVERSION_STRATEGY_ID,
] as const satisfies readonly DayTradeStrategyId[];

export const EXECUTABLE_DAYTRADE_STRATEGY_IDS =
  DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

export const SHADOW_DAYTRADE_STRATEGY_IDS =
  DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      !DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function isDayTradeStrategyId(
  value: unknown,
): value is DayTradeStrategyId {
  return (
    typeof value === 'string' &&
    DAYTRADE_STRATEGY_IDS.includes(
      value as DayTradeStrategyId,
    )
  );
}

export function assertDayTradeStrategyId(
  value: unknown,
): DayTradeStrategyId {
  if (!isDayTradeStrategyId(value)) {
    throw new Error(
      `Estratégia inválida. Valores aceitos: ${DAYTRADE_STRATEGY_IDS.join(', ')}.`,
    );
  }

  return value;
}

export function getDayTradeStrategyDefinition(
  strategyId: DayTradeStrategyId,
): DayTradeStrategyDefinition {
  return DAYTRADE_STRATEGY_REGISTRY[strategyId];
}

export function isDayTradeStrategyAuthorizedForOrders(
  strategyId: DayTradeStrategyId,
): boolean {
  return DAYTRADE_STRATEGY_REGISTRY[strategyId]
    .authorizedForAutomaticOrders;
}

export function listDayTradeStrategyDefinitions(
  options: {
    includeShadow?: boolean;
    onlyBacktestEnabled?: boolean;
    onlyPersistenceEnabled?: boolean;
  } = {},
): DayTradeStrategyDefinition[] {
  const {
    includeShadow = true,
    onlyBacktestEnabled = false,
    onlyPersistenceEnabled = false,
  } = options;

  return DAYTRADE_STRATEGY_IDS
    .map(
      (strategyId) =>
        DAYTRADE_STRATEGY_REGISTRY[strategyId],
    )
    .filter(
      (strategy) =>
        includeShadow ||
        strategy.executionMode !== 'shadow',
    )
    .filter(
      (strategy) =>
        !onlyBacktestEnabled ||
        strategy.enabledForBacktest,
    )
    .filter(
      (strategy) =>
        !onlyPersistenceEnabled ||
        strategy.enabledForPersistence,
    )
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder,
    );
}

// -----------------------------------------------------------------------------
// Avaliação e backtest multiestratégia
// -----------------------------------------------------------------------------

/**
 * O avaliador central compartilha o mesmo snapshot de indicadores entre as
 * quatro estratégias. O adaptador converte as avaliações para o contrato comum
 * usado pelo motor genérico de backtest.
 */
export * from './evaluateAll';
export * from './backtestAdapter';

/**
 * Reexports de conveniência para consumidores que já utilizam o registro
 * central de estratégias.
 *
 * Estes módulos são puros: não consultam APIs, não gravam no banco e não
 * executam ordens.
 */
export * from '../multiStrategyBacktest';
export * from '../compareBacktests';