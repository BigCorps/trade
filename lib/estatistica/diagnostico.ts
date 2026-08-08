/**
 * lib/estatistica/diagnostico.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Separa as duas causas independentes de prejuízo, que exigem correções
 * completamente diferentes:
 *
 *   1. SINAL   — a entrada não prevê nada. Só se resolve trocando a hipótese.
 *   2. FRICÇÃO — o sinal existe mas os custos o consomem. Resolve-se com
 *                stop mais largo, taxa menor ou timeframe maior.
 *
 * Confundir as duas leva a meses perdidos ajustando gestão de saída quando o
 * problema era a entrada — ou trocando de estratégia quando bastava reduzir
 * a taxa.
 *
 * O TESTE DECISIVO: excursão favorável máxima (MFE) das operações perdedoras.
 *
 *   MFE alta nas perdedoras  → a entrada acerta, a saída erra. Ajuste gestão.
 *   MFE baixa nas perdedoras → a entrada não acerta. Gestão não salva.
 *
 * Nesta base, em 07/08/2026, a MFE média das 101 perdedoras era +0,44 R.
 * Elas iam direto ao stop. Por isso as quatro gestões testadas
 * (nenhuma, parcial, breakeven, trailing) deram resultados idênticos.
 */

// ---------------------------------------------------------------------------
// Ponto de equilíbrio
// ---------------------------------------------------------------------------

/**
 * Taxa de acerto necessária para empatar, dado o payoff real observado.
 *
 * Use os valores REAIS (o que a corretora entregou), não os planejados.
 * A diferença entre os dois é justamente a fricção.
 */
export function breakEvenWinRate(
  averageWinR: number,
  averageLossR: number,
): number | null {
  const win = Math.abs(averageWinR);
  const loss = Math.abs(averageLossR);
  if (win + loss <= 0) return null;
  return loss / (win + loss);
}

// ---------------------------------------------------------------------------
// Decomposição sinal × fricção
// ---------------------------------------------------------------------------

export interface EdgeDecompositionInput {
  /** Operações encerradas no alvo. */
  wins: number;
  /** Operações encerradas no stop. */
  losses: number;
  /** R médio realmente entregue pelos ganhos. Ex.: +1,789 */
  actualAverageWinR: number;
  /** R médio realmente custado pelas perdas, em módulo. Ex.: 1,241 */
  actualAverageLossR: number;
  /** Relação risco/retorno planejada. Ex.: 2,01 */
  plannedRewardToRisk: number;
}

export interface EdgeDecomposition {
  sampleSize: number;
  winRate: number;
  actualExpectancyR: number;
  /** Expectativa se a execução fosse perfeita, mantendo a taxa de acerto. */
  frictionlessExpectancyR: number;
  /** Parte do prejuízo atribuível à qualidade da entrada. */
  signalContributionR: number;
  /** Parte do prejuízo atribuível a custos, slippage e gaps. */
  frictionContributionR: number;
  frictionSharePct: number | null;
  breakEvenWinRateActual: number | null;
  breakEvenWinRateFrictionless: number | null;
  /** Pontos percentuais que faltam mesmo com execução perfeita. */
  winRateDeficitPp: number | null;
  slippageBeyondOneR: number;
  targetShortfallR: number;
  primaryProblem: 'sinal' | 'friccao' | 'ambos' | 'nenhum';
  explanation: string;
}

export function decomposeEdge(input: EdgeDecompositionInput): EdgeDecomposition {
  const {
    wins,
    losses,
    actualAverageWinR,
    actualAverageLossR,
    plannedRewardToRisk,
  } = input;

  const sampleSize = wins + losses;
  const winRate = sampleSize > 0 ? wins / sampleSize : 0;

  const lossMagnitude = Math.abs(actualAverageLossR);

  const actualExpectancy =
    winRate * actualAverageWinR - (1 - winRate) * lossMagnitude;

  // Cenário contrafactual: alvo entrega o planejado, stop custa exatamente 1 R.
  const frictionlessExpectancy =
    winRate * plannedRewardToRisk - (1 - winRate) * 1;

  const signalContribution = frictionlessExpectancy;
  const frictionContribution = actualExpectancy - frictionlessExpectancy;

  const totalLoss = Math.abs(signalContribution) + Math.abs(frictionContribution);
  const frictionShare =
    totalLoss > 0 ? (Math.abs(frictionContribution) / totalLoss) * 100 : null;

  const breakEvenActual = breakEvenWinRate(actualAverageWinR, lossMagnitude);
  const breakEvenFrictionless = breakEvenWinRate(plannedRewardToRisk, 1);

  const deficit =
    breakEvenFrictionless === null ? null : (breakEvenFrictionless - winRate) * 100;

  const slippage = lossMagnitude - 1;
  const shortfall = plannedRewardToRisk - actualAverageWinR;

  const signalBroken = frictionlessExpectancy < 0;
  const frictionHeavy = Math.abs(frictionContribution) > 0.05;

  let primaryProblem: EdgeDecomposition['primaryProblem'] = 'nenhum';
  let explanation = 'Expectativa positiva mesmo após fricção.';

  if (signalBroken && frictionHeavy) {
    primaryProblem = 'ambos';
    explanation =
      `A entrada perde ${Math.abs(signalContribution).toFixed(3)} R mesmo com ` +
      `execução perfeita, e a fricção custa outros ` +
      `${Math.abs(frictionContribution).toFixed(3)} R. Reduzir custo não basta: ` +
      `sem trocar o sinal, o resultado continua negativo.`;
  } else if (signalBroken) {
    primaryProblem = 'sinal';
    explanation =
      `Mesmo com execução perfeita a expectativa seria ` +
      `${frictionlessExpectancy.toFixed(3)} R. O problema é a entrada. ` +
      `Nenhum ajuste de custo ou gestão resolve.`;
  } else if (frictionHeavy) {
    primaryProblem = 'friccao';
    explanation =
      `O sinal é positivo (${frictionlessExpectancy.toFixed(3)} R bruto) mas a ` +
      `fricção de ${Math.abs(frictionContribution).toFixed(3)} R o consome. ` +
      `Alargue o stop, reduza a taxa ou suba o timeframe.`;
  }

  return {
    sampleSize,
    winRate,
    actualExpectancyR: actualExpectancy,
    frictionlessExpectancyR: frictionlessExpectancy,
    signalContributionR: signalContribution,
    frictionContributionR: frictionContribution,
    frictionSharePct: frictionShare,
    breakEvenWinRateActual: breakEvenActual,
    breakEvenWinRateFrictionless: breakEvenFrictionless,
    winRateDeficitPp: deficit,
    slippageBeyondOneR: slippage,
    targetShortfallR: shortfall,
    primaryProblem,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Imposto de custo por operação
// ---------------------------------------------------------------------------

export interface CostTaxInput {
  /** Distância do stop como percentual do preço de entrada. Ex.: 1,647 */
  stopDistancePctOfPrice: number;
  /** Taxa por execução, em percentual. Ex.: 0,1 */
  feeRatePct: number;
  /** Slippage por execução, em percentual. Ex.: 0,05 */
  slippagePct: number;
}

export interface CostTax {
  roundTripCostPct: number;
  /** Fração de cada unidade de risco entregue à corretora. */
  costAsShareOfR: number;
  costAsSharePct: number;
  severity: 'aceitavel' | 'alto' | 'proibitivo';
  /** Stop mínimo, em % do preço, para o custo cair a 5% de R. */
  stopNeededForFivePctTax: number;
  explanation: string;
}

/**
 * Quanto de cada R é entregue à corretora antes de qualquer decisão de mercado.
 *
 * Referência prática: acima de 10% o edge bruto precisa ser excepcional só
 * para empatar. Acima de 20% quase nenhuma estratégia direcional sobrevive.
 */
export function calculateCostTax(input: CostTaxInput): CostTax {
  const { stopDistancePctOfPrice, feeRatePct, slippagePct } = input;

  const roundTrip = (feeRatePct + slippagePct) * 2;
  const share =
    stopDistancePctOfPrice > 0 ? roundTrip / stopDistancePctOfPrice : Number.POSITIVE_INFINITY;

  const severity: CostTax['severity'] =
    share <= 0.1 ? 'aceitavel' : share <= 0.2 ? 'alto' : 'proibitivo';

  const stopNeeded = roundTrip / 0.05;

  const explanation =
    severity === 'aceitavel'
      ? `${(share * 100).toFixed(1)}% de cada R vai para custos. Sustentável.`
      : severity === 'alto'
        ? `${(share * 100).toFixed(1)}% de cada R vai para custos. Exige edge bruto forte. ` +
          `Para cair a 5%, o stop precisaria de ${stopNeeded.toFixed(2)}% do preço.`
        : `${(share * 100).toFixed(1)}% de cada R vai para custos — proibitivo. ` +
          `Stop de ${stopNeeded.toFixed(2)}% do preço, taxa menor ou timeframe maior.`;

  return {
    roundTripCostPct: roundTrip,
    costAsShareOfR: share,
    costAsSharePct: share * 100,
    severity,
    stopNeededForFivePctTax: stopNeeded,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Teste de excursão: a entrada tem seguimento?
// ---------------------------------------------------------------------------

export interface ExcursionInput {
  /** MFE média das operações que terminaram no stop, em R. */
  averageFavourableExcursionOnLosersR: number;
  /** MFE máxima observada entre as perdedoras, em R. */
  maximumFavourableExcursionOnLosersR: number;
  losers: number;
}

export interface ExcursionVerdict {
  entryHasFollowThrough: boolean;
  managementCanHelp: boolean;
  /** Fração das perdedoras que chegaria a 1 R e poderia ir a breakeven. */
  breakevenWouldTrigger: boolean;
  verdict: string;
}

/**
 * Decide se ajustar a gestão de saída pode ou não melhorar o resultado.
 *
 * Se as perdedoras mal andam a favor, mover stop para breakeven, tirar
 * parcial em 1 R ou usar trailing não têm o que capturar. É por isso que
 * testar as quatro gestões produz números praticamente iguais.
 */
export function assessExcursion(input: ExcursionInput): ExcursionVerdict {
  const {
    averageFavourableExcursionOnLosersR: averageMfe,
    maximumFavourableExcursionOnLosersR: maximumMfe,
    losers,
  } = input;

  const hasFollowThrough = averageMfe >= 0.8;
  const breakevenTriggers = maximumMfe >= 1;

  if (losers < 20) {
    return {
      entryHasFollowThrough: hasFollowThrough,
      managementCanHelp: false,
      breakevenWouldTrigger: breakevenTriggers,
      verdict: `Apenas ${losers} perdedoras. Amostra insuficiente para concluir.`,
    };
  }

  if (!hasFollowThrough) {
    return {
      entryHasFollowThrough: false,
      managementCanHelp: false,
      breakevenWouldTrigger: breakevenTriggers,
      verdict:
        `MFE média das perdedoras: ${averageMfe.toFixed(2)} R. As operações que ` +
        `perdem vão direto ao stop, sem andar a favor. Breakeven, parcial e ` +
        `trailing não têm o que capturar — o problema é a entrada, não a saída.`,
    };
  }

  return {
    entryHasFollowThrough: true,
    managementCanHelp: true,
    breakevenWouldTrigger: breakevenTriggers,
    verdict:
      `MFE média das perdedoras: ${averageMfe.toFixed(2)} R. As entradas acertam ` +
      `a direção antes de reverter. Vale testar gestão de saída — há excursão ` +
      `favorável a ser capturada.`,
  };
}
