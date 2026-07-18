/**
 * lib/daytrade/risk.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Motor puro de gerenciamento de risco para o módulo de Day Trade.
 *
 * Responsabilidades:
 * - Validar entrada, stop e alvo.
 * - Calcular risco máximo em USDT a partir do saldo e do percentual definido.
 * - Estimar taxas e slippage de forma conservadora.
 * - Calcular a quantidade máxima permitida pelo risco.
 * - Limitar a quantidade ao saldo disponível e às regras da corretora.
 * - Arredondar a quantidade para baixo conforme o stepSize do ativo.
 * - Calcular risco/retorno bruto e líquido estimado.
 * - Entregar avisos claros para a interface, sem executar ordens.
 *
 * Regras importantes:
 * - Este arquivo NÃO consulta APIs, NÃO envia ordens e NÃO usa IA para decidir.
 * - Por padrão, não permite risco superior a 2% do saldo por operação.
 * - Por padrão, não considera alavancagem.
 * - Quantidades são sempre arredondadas para baixo, nunca para cima.
 */

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type TradeDirection = 'long' | 'short';

export interface TradePlanLike {
  direction?: TradeDirection;
  entryReference: number;
  stopReference: number;
  targetReference?: number | null;
}

export interface PositionRiskPolicy {
  /** Percentual mostrado como referência conservadora. Padrão: 1%. */
  recommendedRiskPercent?: number;

  /** Percentual máximo aceito pelo cálculo. Padrão: 2%. */
  maximumRiskPercent?: number;
}

export interface PositionSizingInput {
  accountBalance: number;

  /**
   * Saldo realmente livre para a operação. Quando omitido, usa accountBalance.
   * O cálculo nunca considera mais do que o saldo total informado.
   */
  availableBalance?: number;

  /** Percentual do saldo total que pode ser perdido no stop. */
  riskPercent: number;

  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number | null;

  /** Taxa estimada por execução, em percentual. Padrão: 0,1%. */
  feeRatePct?: number;

  /** Slippage adversa estimada por execução, em percentual. Padrão: 0,05%. */
  slippagePct?: number;

  /** Incremento mínimo da quantidade aceito pela corretora. */
  stepSize?: number;

  /** Quantidade mínima permitida pela corretora. */
  minQuantity?: number;

  /** Quantidade máxima permitida pela corretora. */
  maxQuantity?: number;

  /** Valor nocional mínimo da ordem. */
  minNotional?: number;

  /** Valor nocional máximo permitido para a operação. */
  maxNotional?: number;

  /** Mantido falso no modo educacional. */
  allowLeverage?: boolean;

  /** Usado somente quando allowLeverage=true. */
  leverage?: number;

  policy?: PositionRiskPolicy;
}

export type PositionSizingFailureStatus =
  | 'invalid_input'
  | 'risk_limit_exceeded'
  | 'insufficient_balance'
  | 'quantity_below_minimum'
  | 'notional_below_minimum'
  | 'quantity_zero';

export type PositionSizingSuccessStatus =
  | 'ready'
  | 'limited_by_balance'
  | 'limited_by_max_quantity'
  | 'limited_by_max_notional';

export interface PositionSizingDiagnostics {
  recommendedRiskPercent: number;
  maximumRiskPercent: number;
  effectiveAvailableBalance: number | null;
  buyingPower: number | null;
  rawRiskQuantity: number | null;
  affordableQuantity: number | null;
  quantityBeforeRounding: number | null;
  quantityAfterRounding: number | null;
  minimumRequiredQuantity: number | null;
  minimumRequiredNotional: number | null;
}

export interface PositionSizingFailure {
  ok: false;
  status: PositionSizingFailureStatus;
  errors: string[];
  warnings: string[];
  diagnostics: PositionSizingDiagnostics;
}

export interface PositionSizingSuccess {
  ok: true;
  status: PositionSizingSuccessStatus;
  errors: [];
  warnings: string[];

  direction: TradeDirection;
  accountBalance: number;
  availableBalance: number;
  riskPercent: number;

  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;

  quantity: number;
  notional: number;

  /** Distância simples entre entrada e stop por unidade do ativo. */
  priceRiskPerUnit: number;

  /** Risco estimado por unidade incluindo taxas e slippage até o stop. */
  estimatedRiskPerUnit: number;

  maximumRiskUsdt: number;
  estimatedPriceRiskUsdt: number;
  estimatedFeesAtStopUsdt: number;
  estimatedSlippageAtStopUsdt: number;
  estimatedTotalRiskUsdt: number;
  estimatedTotalRiskPct: number;

  grossRewardPerUnit: number | null;
  estimatedNetRewardPerUnit: number | null;
  grossRiskRewardRatio: number | null;
  estimatedNetRiskRewardRatio: number | null;

  estimatedGrossRewardUsdt: number | null;
  estimatedNetRewardUsdt: number | null;

  feeRatePct: number;
  slippagePct: number;
  leverage: number;

  diagnostics: PositionSizingDiagnostics;
}

export type PositionSizingResult =
  | PositionSizingFailure
  | PositionSizingSuccess;

export interface PositionSizingFromPlanInput
  extends Omit<
    PositionSizingInput,
    'direction' | 'entryPrice' | 'stopPrice' | 'targetPrice'
  > {
  plan: TradePlanLike;
}

export interface RiskRewardInput {
  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  feeRatePct?: number;
  slippagePct?: number;
}

export interface RiskRewardResult {
  valid: boolean;
  errors: string[];
  direction: TradeDirection;
  priceRiskPerUnit: number | null;
  estimatedRiskPerUnit: number | null;
  grossRewardPerUnit: number | null;
  estimatedNetRewardPerUnit: number | null;
  grossRiskRewardRatio: number | null;
  estimatedNetRiskRewardRatio: number | null;
}

export interface RMultipleInput {
  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  exitPrice: number;
  feeRatePct?: number;
  slippagePct?: number;
}

export interface RMultipleResult {
  valid: boolean;
  errors: string[];
  grossPnlPerUnit: number | null;
  estimatedNetPnlPerUnit: number | null;
  estimatedInitialRiskPerUnit: number | null;
  grossRMultiple: number | null;
  estimatedNetRMultiple: number | null;
}

// ---------------------------------------------------------------------------
// Configuração padrão
// ---------------------------------------------------------------------------

const DEFAULT_FEE_RATE_PCT = 0.1;
const DEFAULT_SLIPPAGE_PCT = 0.05;
const DEFAULT_STEP_SIZE = 0.00000001;
const DEFAULT_RECOMMENDED_RISK_PERCENT = 1;
const DEFAULT_MAXIMUM_RISK_PERCENT = 2;
const MAX_DECIMAL_PLACES = 12;

// ---------------------------------------------------------------------------
// Validações e utilitários
// ---------------------------------------------------------------------------

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isPositive(value: number): boolean {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegative(value: number): boolean {
  return isFiniteNumber(value) && value >= 0;
}

function resolveDirection(direction?: TradeDirection): TradeDirection {
  return direction ?? 'long';
}

function resolvePolicy(policy?: PositionRiskPolicy): {
  recommendedRiskPercent: number;
  maximumRiskPercent: number;
} {
  const recommendedRiskPercent =
    policy?.recommendedRiskPercent ?? DEFAULT_RECOMMENDED_RISK_PERCENT;
  const maximumRiskPercent =
    policy?.maximumRiskPercent ?? DEFAULT_MAXIMUM_RISK_PERCENT;

  if (!isPositive(recommendedRiskPercent)) {
    throw new Error('recommendedRiskPercent deve ser maior que zero.');
  }

  if (!isPositive(maximumRiskPercent)) {
    throw new Error('maximumRiskPercent deve ser maior que zero.');
  }

  if (recommendedRiskPercent > maximumRiskPercent) {
    throw new Error(
      'recommendedRiskPercent não pode ser maior que maximumRiskPercent.',
    );
  }

  return { recommendedRiskPercent, maximumRiskPercent };
}

function resolveCostRates(input: {
  feeRatePct?: number;
  slippagePct?: number;
}): { feeRatePct: number; slippagePct: number } {
  const feeRatePct = input.feeRatePct ?? DEFAULT_FEE_RATE_PCT;
  const slippagePct = input.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  if (!isNonNegative(feeRatePct)) {
    throw new Error('feeRatePct deve ser maior ou igual a zero.');
  }

  if (!isNonNegative(slippagePct)) {
    throw new Error('slippagePct deve ser maior ou igual a zero.');
  }

  return { feeRatePct, slippagePct };
}

function validatePriceStructure(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
  targetPrice?: number | null,
): string[] {
  const errors: string[] = [];

  if (!isPositive(entryPrice)) {
    errors.push('O preço de entrada deve ser maior que zero.');
  }

  if (!isPositive(stopPrice)) {
    errors.push('O preço de stop deve ser maior que zero.');
  }

  if (targetPrice !== null && targetPrice !== undefined && !isPositive(targetPrice)) {
    errors.push('O preço-alvo deve ser maior que zero.');
  }

  if (errors.length > 0) return errors;

  if (direction === 'long') {
    if (stopPrice >= entryPrice) {
      errors.push(
        'Em uma operação comprada, o stop deve ficar abaixo da entrada.',
      );
    }

    if (
      targetPrice !== null &&
      targetPrice !== undefined &&
      targetPrice <= entryPrice
    ) {
      errors.push(
        'Em uma operação comprada, o alvo deve ficar acima da entrada.',
      );
    }
  } else {
    if (stopPrice <= entryPrice) {
      errors.push(
        'Em uma operação vendida, o stop deve ficar acima da entrada.',
      );
    }

    if (
      targetPrice !== null &&
      targetPrice !== undefined &&
      targetPrice >= entryPrice
    ) {
      errors.push(
        'Em uma operação vendida, o alvo deve ficar abaixo da entrada.',
      );
    }
  }

  return errors;
}

function decimalPlaces(value: number): number {
  if (!isFiniteNumber(value)) return 0;

  const text = value.toString().toLowerCase();

  if (text.includes('e-')) {
    const [coefficient, exponentText] = text.split('e-');
    const exponent = Number(exponentText);
    const coefficientDecimals = coefficient.split('.')[1]?.length ?? 0;
    return Math.min(MAX_DECIMAL_PLACES, exponent + coefficientDecimals);
  }

  return Math.min(MAX_DECIMAL_PLACES, text.split('.')[1]?.length ?? 0);
}

/**
 * Arredonda sempre para baixo conforme o stepSize, evitando elevar o risco.
 */
export function roundQuantityDown(
  quantity: number,
  stepSize = DEFAULT_STEP_SIZE,
): number {
  if (!isNonNegative(quantity)) {
    throw new Error('quantity deve ser maior ou igual a zero.');
  }

  if (!isPositive(stepSize)) {
    throw new Error('stepSize deve ser maior que zero.');
  }

  const precision = decimalPlaces(stepSize);
  const factor = 10 ** precision;
  const integerStep = Math.max(1, Math.round(stepSize * factor));
  const integerQuantity = Math.floor(
    (quantity * factor + Number.EPSILON * factor) / integerStep,
  ) * integerStep;

  return Number((integerQuantity / factor).toFixed(precision));
}

function priceRiskPerUnit(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
): number {
  return direction === 'long'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice;
}

function grossRewardPerUnit(
  direction: TradeDirection,
  entryPrice: number,
  targetPrice: number,
): number {
  return direction === 'long'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;
}

function executionFeePerUnit(price: number, feeRatePct: number): number {
  return price * (feeRatePct / 100);
}

function executionSlippagePerUnit(
  price: number,
  slippagePct: number,
): number {
  return price * (slippagePct / 100);
}

function calculateEstimatedRiskPerUnit(input: {
  entryPrice: number;
  stopPrice: number;
  priceRisk: number;
  feeRatePct: number;
  slippagePct: number;
}): {
  estimatedFees: number;
  estimatedSlippage: number;
  estimatedRisk: number;
} {
  const estimatedFees =
    executionFeePerUnit(input.entryPrice, input.feeRatePct) +
    executionFeePerUnit(input.stopPrice, input.feeRatePct);

  const estimatedSlippage =
    executionSlippagePerUnit(input.entryPrice, input.slippagePct) +
    executionSlippagePerUnit(input.stopPrice, input.slippagePct);

  return {
    estimatedFees,
    estimatedSlippage,
    estimatedRisk: input.priceRisk + estimatedFees + estimatedSlippage,
  };
}

function emptyDiagnostics(
  recommendedRiskPercent: number,
  maximumRiskPercent: number,
): PositionSizingDiagnostics {
  return {
    recommendedRiskPercent,
    maximumRiskPercent,
    effectiveAvailableBalance: null,
    buyingPower: null,
    rawRiskQuantity: null,
    affordableQuantity: null,
    quantityBeforeRounding: null,
    quantityAfterRounding: null,
    minimumRequiredQuantity: null,
    minimumRequiredNotional: null,
  };
}

function failure(
  status: PositionSizingFailureStatus,
  errors: string[],
  warnings: string[],
  diagnostics: PositionSizingDiagnostics,
): PositionSizingFailure {
  return {
    ok: false,
    status,
    errors,
    warnings,
    diagnostics,
  };
}

function minimumQuantityForNotional(
  minNotional: number,
  entryPrice: number,
): number {
  if (minNotional <= 0 || entryPrice <= 0) return 0;
  return minNotional / entryPrice;
}

// ---------------------------------------------------------------------------
// Relação risco/retorno
// ---------------------------------------------------------------------------

export function calculateRiskReward(
  input: RiskRewardInput,
): RiskRewardResult {
  const direction = resolveDirection(input.direction);
  const errors = validatePriceStructure(
    direction,
    input.entryPrice,
    input.stopPrice,
    input.targetPrice,
  );

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      direction,
      priceRiskPerUnit: null,
      estimatedRiskPerUnit: null,
      grossRewardPerUnit: null,
      estimatedNetRewardPerUnit: null,
      grossRiskRewardRatio: null,
      estimatedNetRiskRewardRatio: null,
    };
  }

  const priceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );
  const grossReward = grossRewardPerUnit(
    direction,
    input.entryPrice,
    input.targetPrice,
  );

  const riskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk,
    ...rates,
  });

  const rewardCosts =
    executionFeePerUnit(input.entryPrice, rates.feeRatePct) +
    executionFeePerUnit(input.targetPrice, rates.feeRatePct) +
    executionSlippagePerUnit(input.entryPrice, rates.slippagePct) +
    executionSlippagePerUnit(input.targetPrice, rates.slippagePct);

  const netReward = grossReward - rewardCosts;

  return {
    valid: true,
    errors: [],
    direction,
    priceRiskPerUnit: priceRisk,
    estimatedRiskPerUnit: riskEstimate.estimatedRisk,
    grossRewardPerUnit: grossReward,
    estimatedNetRewardPerUnit: netReward,
    grossRiskRewardRatio: grossReward / priceRisk,
    estimatedNetRiskRewardRatio:
      netReward > 0 ? netReward / riskEstimate.estimatedRisk : 0,
  };
}

// ---------------------------------------------------------------------------
// Dimensionamento da posição
// ---------------------------------------------------------------------------

export function calculatePositionSize(
  input: PositionSizingInput,
): PositionSizingResult {
  let policy: {
    recommendedRiskPercent: number;
    maximumRiskPercent: number;
  };

  try {
    policy = resolvePolicy(input.policy);
  } catch (error) {
    policy = {
      recommendedRiskPercent: DEFAULT_RECOMMENDED_RISK_PERCENT,
      maximumRiskPercent: DEFAULT_MAXIMUM_RISK_PERCENT,
    };

    return failure(
      'invalid_input',
      [error instanceof Error ? error.message : 'Política de risco inválida.'],
      [],
      emptyDiagnostics(
        policy.recommendedRiskPercent,
        policy.maximumRiskPercent,
      ),
    );
  }

  const diagnostics = emptyDiagnostics(
    policy.recommendedRiskPercent,
    policy.maximumRiskPercent,
  );
  const errors: string[] = [];
  const warnings: string[] = [];
  const direction = resolveDirection(input.direction);

  if (!isPositive(input.accountBalance)) {
    errors.push('O saldo total deve ser maior que zero.');
  }

  if (!isPositive(input.riskPercent)) {
    errors.push('O percentual de risco deve ser maior que zero.');
  }

  errors.push(
    ...validatePriceStructure(
      direction,
      input.entryPrice,
      input.stopPrice,
      input.targetPrice,
    ),
  );

  const availableBalanceInput = input.availableBalance ?? input.accountBalance;

  if (!isPositive(availableBalanceInput)) {
    errors.push('O saldo disponível deve ser maior que zero.');
  }

  const stepSize = input.stepSize ?? DEFAULT_STEP_SIZE;
  const minQuantity = input.minQuantity ?? 0;
  const maxQuantity = input.maxQuantity ?? Number.POSITIVE_INFINITY;
  const minNotional = input.minNotional ?? 0;
  const maxNotional = input.maxNotional ?? Number.POSITIVE_INFINITY;
  const allowLeverage = input.allowLeverage ?? false;
  const requestedLeverage = input.leverage ?? 1;

  if (!isPositive(stepSize)) errors.push('stepSize deve ser maior que zero.');
  if (!isNonNegative(minQuantity)) {
    errors.push('minQuantity deve ser maior ou igual a zero.');
  }
  if (!(isPositive(maxQuantity) || maxQuantity === Number.POSITIVE_INFINITY)) {
    errors.push('maxQuantity deve ser maior que zero.');
  }
  if (!isNonNegative(minNotional)) {
    errors.push('minNotional deve ser maior ou igual a zero.');
  }
  if (!(isPositive(maxNotional) || maxNotional === Number.POSITIVE_INFINITY)) {
    errors.push('maxNotional deve ser maior que zero.');
  }
  if (!isPositive(requestedLeverage)) {
    errors.push('leverage deve ser maior que zero.');
  }

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return failure('invalid_input', errors, warnings, diagnostics);
  }

  if (input.riskPercent > policy.maximumRiskPercent) {
    return failure(
      'risk_limit_exceeded',
      [
        `O risco informado de ${input.riskPercent}% supera o limite de ${policy.maximumRiskPercent}% por operação.`,
      ],
      warnings,
      diagnostics,
    );
  }

  if (input.riskPercent > policy.recommendedRiskPercent) {
    warnings.push(
      `O risco informado está acima da referência conservadora de ${policy.recommendedRiskPercent}% por operação.`,
    );
  }

  const effectiveAvailableBalance = Math.min(
    input.accountBalance,
    availableBalanceInput,
  );
  const leverage = allowLeverage ? requestedLeverage : 1;

  if (!allowLeverage && requestedLeverage > 1) {
    warnings.push(
      'A alavancagem informada foi ignorada porque allowLeverage está desativado.',
    );
  }

  if (allowLeverage && leverage > 1) {
    warnings.push(
      'O cálculo está considerando alavancagem. Perdas e liquidação exigem controles adicionais fora deste módulo.',
    );
  }

  const buyingPower = effectiveAvailableBalance * leverage;
  diagnostics.effectiveAvailableBalance = effectiveAvailableBalance;
  diagnostics.buyingPower = buyingPower;

  const priceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );

  const riskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk,
    ...rates,
  });

  const maximumRiskUsdt = input.accountBalance * (input.riskPercent / 100);
  const rawRiskQuantity = maximumRiskUsdt / riskEstimate.estimatedRisk;

  // Reserva taxa estimada da entrada para não ultrapassar o saldo disponível.
  const entryCostMultiplier =
    1 + rates.feeRatePct / 100 + rates.slippagePct / 100;
  const affordableQuantity =
    buyingPower / (input.entryPrice * entryCostMultiplier);

  diagnostics.rawRiskQuantity = rawRiskQuantity;
  diagnostics.affordableQuantity = affordableQuantity;

  let quantityBeforeRounding = Math.min(rawRiskQuantity, affordableQuantity);
  let successStatus: PositionSizingSuccessStatus = 'ready';

  if (affordableQuantity < rawRiskQuantity) {
    successStatus = 'limited_by_balance';
    warnings.push(
      'A quantidade foi reduzida porque o saldo disponível não comporta toda a posição calculada pelo limite de risco.',
    );
  }

  if (maxQuantity < quantityBeforeRounding) {
    quantityBeforeRounding = maxQuantity;
    successStatus = 'limited_by_max_quantity';
    warnings.push(
      'A quantidade foi reduzida para respeitar o limite máximo permitido.',
    );
  }

  const quantityAllowedByMaxNotional =
    maxNotional === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : maxNotional / input.entryPrice;

  if (quantityAllowedByMaxNotional < quantityBeforeRounding) {
    quantityBeforeRounding = quantityAllowedByMaxNotional;
    successStatus = 'limited_by_max_notional';
    warnings.push(
      'A quantidade foi reduzida para respeitar o valor nocional máximo.',
    );
  }

  diagnostics.quantityBeforeRounding = quantityBeforeRounding;

  const quantity = roundQuantityDown(quantityBeforeRounding, stepSize);
  const minimumByNotional = minimumQuantityForNotional(
    minNotional,
    input.entryPrice,
  );
  const minimumRequiredQuantity = Math.max(minQuantity, minimumByNotional);

  diagnostics.quantityAfterRounding = quantity;
  diagnostics.minimumRequiredQuantity = minimumRequiredQuantity;
  diagnostics.minimumRequiredNotional = minNotional;

  if (quantity <= 0) {
    return failure(
      'quantity_zero',
      [
        'O tamanho calculado ficou abaixo do incremento mínimo de quantidade. Aumentar a posição para atingir o mínimo elevaria o risco definido.',
      ],
      warnings,
      diagnostics,
    );
  }

  if (quantity < minQuantity) {
    return failure(
      'quantity_below_minimum',
      [
        `A quantidade segura calculada (${quantity}) ficou abaixo da quantidade mínima permitida (${minQuantity}).`,
      ],
      warnings,
      diagnostics,
    );
  }

  const notional = quantity * input.entryPrice;

  if (notional < minNotional) {
    return failure(
      'notional_below_minimum',
      [
        `O valor seguro calculado (${notional}) ficou abaixo do nocional mínimo permitido (${minNotional}).`,
      ],
      warnings,
      diagnostics,
    );
  }

  if (notional > buyingPower + Number.EPSILON) {
    return failure(
      'insufficient_balance',
      [
        'O saldo disponível não é suficiente para a quantidade calculada após o arredondamento.',
      ],
      warnings,
      diagnostics,
    );
  }

  const estimatedPriceRiskUsdt = priceRisk * quantity;
  const estimatedFeesAtStopUsdt = riskEstimate.estimatedFees * quantity;
  const estimatedSlippageAtStopUsdt =
    riskEstimate.estimatedSlippage * quantity;
  const estimatedTotalRiskUsdt = riskEstimate.estimatedRisk * quantity;
  const estimatedTotalRiskPct =
    (estimatedTotalRiskUsdt / input.accountBalance) * 100;

  if (estimatedTotalRiskUsdt > maximumRiskUsdt + 1e-8) {
    return failure(
      'invalid_input',
      [
        'O risco estimado ultrapassou o limite após os ajustes de quantidade. Revise stepSize e os parâmetros informados.',
      ],
      warnings,
      diagnostics,
    );
  }

  let grossReward: number | null = null;
  let netReward: number | null = null;
  let grossRiskRewardRatio: number | null = null;
  let estimatedNetRiskRewardRatio: number | null = null;
  let estimatedGrossRewardUsdt: number | null = null;
  let estimatedNetRewardUsdt: number | null = null;

  if (input.targetPrice !== null && input.targetPrice !== undefined) {
    const riskReward = calculateRiskReward({
      direction,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      ...rates,
    });

    if (riskReward.valid) {
      grossReward = riskReward.grossRewardPerUnit;
      netReward = riskReward.estimatedNetRewardPerUnit;
      grossRiskRewardRatio = riskReward.grossRiskRewardRatio;
      estimatedNetRiskRewardRatio =
        riskReward.estimatedNetRiskRewardRatio;
      estimatedGrossRewardUsdt =
        riskReward.grossRewardPerUnit !== null
          ? riskReward.grossRewardPerUnit * quantity
          : null;
      estimatedNetRewardUsdt =
        riskReward.estimatedNetRewardPerUnit !== null
          ? riskReward.estimatedNetRewardPerUnit * quantity
          : null;

      if (
        estimatedNetRiskRewardRatio !== null &&
        estimatedNetRiskRewardRatio < 1
      ) {
        warnings.push(
          'Após taxas e slippage estimados, o ganho potencial ficou menor que o risco estimado.',
        );
      }
    }
  }

  return {
    ok: true,
    status: successStatus,
    errors: [],
    warnings,

    direction,
    accountBalance: input.accountBalance,
    availableBalance: effectiveAvailableBalance,
    riskPercent: input.riskPercent,

    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    targetPrice: input.targetPrice ?? null,

    quantity,
    notional,

    priceRiskPerUnit: priceRisk,
    estimatedRiskPerUnit: riskEstimate.estimatedRisk,

    maximumRiskUsdt,
    estimatedPriceRiskUsdt,
    estimatedFeesAtStopUsdt,
    estimatedSlippageAtStopUsdt,
    estimatedTotalRiskUsdt,
    estimatedTotalRiskPct,

    grossRewardPerUnit: grossReward,
    estimatedNetRewardPerUnit: netReward,
    grossRiskRewardRatio,
    estimatedNetRiskRewardRatio,

    estimatedGrossRewardUsdt,
    estimatedNetRewardUsdt,

    feeRatePct: rates.feeRatePct,
    slippagePct: rates.slippagePct,
    leverage,

    diagnostics,
  };
}

/**
 * Atalho compatível estruturalmente com TrendBreakoutPlan.
 */
export function calculatePositionSizeFromPlan(
  input: PositionSizingFromPlanInput,
): PositionSizingResult {
  return calculatePositionSize({
    accountBalance: input.accountBalance,
    availableBalance: input.availableBalance,
    riskPercent: input.riskPercent,
    direction: input.plan.direction ?? 'long',
    entryPrice: input.plan.entryReference,
    stopPrice: input.plan.stopReference,
    targetPrice: input.plan.targetReference ?? null,
    feeRatePct: input.feeRatePct,
    slippagePct: input.slippagePct,
    stepSize: input.stepSize,
    minQuantity: input.minQuantity,
    maxQuantity: input.maxQuantity,
    minNotional: input.minNotional,
    maxNotional: input.maxNotional,
    allowLeverage: input.allowLeverage,
    leverage: input.leverage,
    policy: input.policy,
  });
}

// ---------------------------------------------------------------------------
// Resultado em múltiplos de R para o diário futuro
// ---------------------------------------------------------------------------

export function calculateRMultiple(input: RMultipleInput): RMultipleResult {
  const direction = resolveDirection(input.direction);
  const errors = validatePriceStructure(
    direction,
    input.entryPrice,
    input.stopPrice,
  );

  if (!isPositive(input.exitPrice)) {
    errors.push('O preço de saída deve ser maior que zero.');
  }

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      grossPnlPerUnit: null,
      estimatedNetPnlPerUnit: null,
      estimatedInitialRiskPerUnit: null,
      grossRMultiple: null,
      estimatedNetRMultiple: null,
    };
  }

  const initialPriceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );
  const initialRiskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk: initialPriceRisk,
    ...rates,
  });

  const grossPnl =
    direction === 'long'
      ? input.exitPrice - input.entryPrice
      : input.entryPrice - input.exitPrice;

  const exitCosts =
    executionFeePerUnit(input.entryPrice, rates.feeRatePct) +
    executionFeePerUnit(input.exitPrice, rates.feeRatePct) +
    executionSlippagePerUnit(input.entryPrice, rates.slippagePct) +
    executionSlippagePerUnit(input.exitPrice, rates.slippagePct);

  const netPnl = grossPnl - exitCosts;

  return {
    valid: true,
    errors: [],
    grossPnlPerUnit: grossPnl,
    estimatedNetPnlPerUnit: netPnl,
    estimatedInitialRiskPerUnit: initialRiskEstimate.estimatedRisk,
    grossRMultiple: grossPnl / initialPriceRisk,
    estimatedNetRMultiple: netPnl / initialRiskEstimate.estimatedRisk,
  };
}