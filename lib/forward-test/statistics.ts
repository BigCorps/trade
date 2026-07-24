export interface ForwardStatisticsRow {
  operacoes_fechadas: number | string | null;
  ganhos: number | string | null;
  perdas: number | string | null;
  empates?: number | string | null;
  canceladas?: number | string | null;
  em_andamento?: number | string | null;
  soma_r_fixo: number | string | null;
  soma_quadrados_r_fixo?: number | string | null;
  ganho_bruto_r?: number | string | null;
  perda_bruta_r?: number | string | null;
  soma_r_anti?: number | string | null;
  max_drawdown_r_fixo?: number | string | null;
  max_drawdown_r_anti?: number | string | null;
}

const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function combineForwardStatistics(rows: readonly ForwardStatisticsRow[]) {
  const closed = rows.reduce((sum, row) => sum + number(row.operacoes_fechadas), 0);
  const wins = rows.reduce((sum, row) => sum + number(row.ganhos), 0);
  const losses = rows.reduce((sum, row) => sum + number(row.perdas), 0);
  const breakeven = rows.reduce((sum, row) => sum + number(row.empates), 0);
  const cancelled = rows.reduce((sum, row) => sum + number(row.canceladas), 0);
  const inProgress = rows.reduce((sum, row) => sum + number(row.em_andamento), 0);
  const sumR = rows.reduce((sum, row) => sum + number(row.soma_r_fixo), 0);
  const sumSquaresR = rows.reduce((sum, row) => sum + number(row.soma_quadrados_r_fixo), 0);
  const grossProfitR = rows.reduce((sum, row) => sum + number(row.ganho_bruto_r), 0);
  const grossLossR = Math.abs(rows.reduce((sum, row) => sum + number(row.perda_bruta_r), 0));
  const sumAntiR = rows.reduce((sum, row) => sum + number(row.soma_r_anti), 0);
  const meanR = closed > 0 ? sumR / closed : null;
  const standardDeviationR = closed > 1
    ? Math.sqrt(Math.max(0, sumSquaresR - (sumR * sumR) / closed) / (closed - 1))
    : null;
  const standardErrorR = standardDeviationR === null ? null : standardDeviationR / Math.sqrt(closed);
  return {
    closed, wins, losses, breakeven, cancelled, inProgress,
    winRatePct: wins + losses > 0 ? (wins / (wins + losses)) * 100 : null,
    sumR, sumSquaresR, meanR, standardDeviationR, standardErrorR,
    confidence95LowerR: meanR === null || standardErrorR === null ? null : meanR - 1.96 * standardErrorR,
    confidence95UpperR: meanR === null || standardErrorR === null ? null : meanR + 1.96 * standardErrorR,
    tStatisticR: meanR === null || standardErrorR === null || standardErrorR === 0 ? null : meanR / standardErrorR,
    grossProfitR, grossLossR,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
    sumAntiR, deltaAntiR: sumAntiR - sumR,
    worstDrawdownFixedR: rows.reduce((max, row) => Math.max(max, number(row.max_drawdown_r_fixo)), 0),
    worstDrawdownAntiR: rows.reduce((max, row) => Math.max(max, number(row.max_drawdown_r_anti)), 0),
  };
}
