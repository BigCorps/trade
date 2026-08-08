/**
 * lib/estatistica/multipleTesting.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Correção estatística para busca em múltiplas combinações.
 *
 * O PROBLEMA QUE ESTE ARQUIVO RESOLVE
 * -----------------------------------
 * Ao testar N combinações (símbolo × estratégia × timeframe × gestão) e
 * escolher a melhor, o resultado escolhido é enviesado para cima por
 * construção. Mesmo com dados 100% aleatórios, o melhor de 72 sorteios
 * parece excelente.
 *
 * Exemplo real desta base (bateria 1d/2900d, 64 combinações):
 *   melhor t observado ........................ +2,04
 *   t esperado do melhor SE tudo fosse ruído .. +2,20
 *   p corrigido ............................... 0,737
 *
 * O "vencedor" da tabela era menos impressionante que ruído puro.
 *
 * REGRA DE USO
 * ------------
 * Nunca avalie um resultado isoladamente. Sempre informe quantas
 * combinações foram testadas para chegar até ele — incluindo as
 * descartadas e as de baterias anteriores sobre os mesmos dados.
 *
 * Este arquivo é matemática pura: não consulta APIs, não lê banco,
 * não executa ordens.
 */

// ---------------------------------------------------------------------------
// Distribuição normal
// ---------------------------------------------------------------------------

/** Função de distribuição acumulada da normal padrão. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Erro de Gauss — aproximação de Abramowitz & Stegun 7.1.26 (|erro| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);

  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))));

  return sign * (1 - polynomial * Math.exp(-absolute * absolute));
}

/** Quantil da normal padrão — algoritmo de Acklam (|erro| < 1.15e-9). */
export function normalQuantile(probability: number): number {
  if (!(probability > 0 && probability < 1)) return Number.NaN;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
             -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
             3.754408661907416e0];

  const low = 0.02425;
  const high = 1 - low;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------------------------------------------------------------------------
// Correção por múltiplos testes
// ---------------------------------------------------------------------------

/** p unilateral (cauda direita) de um t observado. */
export function oneSidedPValue(tStatistic: number): number {
  return 1 - normalCdf(tStatistic);
}

/**
 * p corrigido pela família de testes (Šidák).
 *
 * Responde: "qual a chance de ver um resultado ao menos tão bom quanto este,
 * em ao menos uma das N combinações, se nenhuma tivesse edge?"
 */
export function sidakFamilyWisePValue(
  singleTestPValue: number,
  numberOfTests: number,
): number {
  if (numberOfTests <= 1) return singleTestPValue;
  const bounded = Math.min(1, Math.max(0, singleTestPValue));
  return 1 - Math.pow(1 - bounded, numberOfTests);
}

/**
 * t esperado do MELHOR de N testes sob a hipótese nula.
 *
 * Aproximação de Gumbel para o máximo de N normais padrão. É a régua
 * honesta: se o seu melhor t não superar este valor, ele não é notícia.
 */
export function expectedMaxTUnderNull(numberOfTests: number): number {
  if (numberOfTests <= 1) return 0;

  const logN = Math.log(numberOfTests);
  const root = Math.sqrt(2 * logN);

  if (numberOfTests < 3) return root;

  return root - (Math.log(logN) + Math.log(4 * Math.PI)) / (2 * root);
}

/**
 * Limiar de t que uma combinação precisa superar para ser levada a sério,
 * dado que N combinações foram testadas.
 */
export function requiredTStatistic(
  numberOfTests: number,
  significanceLevel = 0.05,
): number {
  const perTest = 1 - Math.pow(1 - significanceLevel, 1 / Math.max(1, numberOfTests));
  return normalQuantile(1 - perTest);
}

// ---------------------------------------------------------------------------
// Deflated Sharpe Ratio (López de Prado)
// ---------------------------------------------------------------------------

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Sharpe máximo esperado sob a nula, dado N tentativas independentes.
 * Serve como o "piso" que o Sharpe observado precisa superar.
 */
export function expectedMaxSharpeUnderNull(
  numberOfTrials: number,
  sharpeVariance = 1,
): number {
  if (numberOfTrials <= 1) return 0;

  const deviation = Math.sqrt(Math.max(0, sharpeVariance));
  const first = normalQuantile(1 - 1 / numberOfTrials);
  const second = normalQuantile(1 - 1 / (numberOfTrials * Math.E));

  return deviation * ((1 - EULER_MASCHERONI) * first + EULER_MASCHERONI * second);
}

export interface DeflatedSharpeInput {
  /** Sharpe observado, na mesma frequência das observações. */
  observedSharpe: number;
  /** Número de observações (operações). */
  sampleSize: number;
  /** Quantas configurações foram testadas até chegar nesta. */
  numberOfTrials: number;
  /**
   * Variância dos Sharpe observados ENTRE as tentativas.
   *
   * Quando não informada, usa 1/sampleSize — a variância assintótica do
   * estimador de Sharpe sob a nula. Se você guardou os Sharpe de todas as
   * combinações da bateria, prefira informar a variância amostral real:
   * ela é a medida mais fiel de quanto a busca poderia ter garimpado.
   */
  sharpeVariance?: number;
  /** Assimetria dos retornos. Padrão: 0. */
  skewness?: number;
  /** Curtose dos retornos. Padrão: 3 (normal). */
  kurtosis?: number;
}

/**
 * Probabilidade de o Sharpe observado ser real, e não o melhor de várias
 * tentativas sobre ruído. Acima de 0,95 é o padrão aceito na literatura.
 */
export function deflatedSharpeRatio(input: DeflatedSharpeInput): number | null {
  const { observedSharpe, sampleSize, numberOfTrials } = input;
  const skewness = input.skewness ?? 0;
  const kurtosis = input.kurtosis ?? 3;

  if (sampleSize < 2) return null;

  const sharpeVariance = input.sharpeVariance ?? 1 / sampleSize;
  const benchmark = expectedMaxSharpeUnderNull(numberOfTrials, sharpeVariance);

  const denominator = Math.sqrt(
    Math.max(
      1e-12,
      1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe * observedSharpe,
    ),
  );

  const statistic =
    ((observedSharpe - benchmark) * Math.sqrt(sampleSize - 1)) / denominator;

  return normalCdf(statistic);
}

// ---------------------------------------------------------------------------
// Dimensionamento de amostra
// ---------------------------------------------------------------------------

/**
 * Quantas operações são necessárias para detectar um edge de determinado
 * tamanho, já corrigindo pelo número de combinações testadas.
 *
 * Este número costuma ser desconfortável — e é o ponto. Ele mostra o custo
 * real de provar um edge pequeno antes de arriscar capital.
 */
export function requiredSampleSize(
  expectedMeanR: number,
  standardDeviationR: number,
  numberOfTests = 1,
  significanceLevel = 0.05,
): number | null {
  if (expectedMeanR <= 0 || standardDeviationR <= 0) return null;

  const targetT = requiredTStatistic(numberOfTests, significanceLevel);
  return Math.ceil(Math.pow((targetT * standardDeviationR) / expectedMeanR, 2));
}

// ---------------------------------------------------------------------------
// Avaliação completa
// ---------------------------------------------------------------------------

export interface EvidenceInput {
  meanR: number;
  standardDeviationR: number;
  sampleSize: number;
  /** Combinações testadas até chegar a esta. Seja honesto: inclua as descartadas. */
  numberOfTests: number;
  significanceLevel?: number;
  skewness?: number;
  kurtosis?: number;
}

export type EvidenceVerdict =
  | 'amostra_insuficiente'
  | 'indistinguivel_de_ruido'
  | 'negativo_significativo'
  | 'promissor_sem_confirmacao'
  | 'aprovado';

export interface EvidenceAssessment {
  tStatistic: number | null;
  singleTestPValue: number | null;
  familyWisePValue: number | null;
  expectedMaxTUnderNull: number;
  requiredTStatistic: number;
  excessOverNoise: number | null;
  deflatedSharpe: number | null;
  operationsStillNeeded: number | null;
  verdict: EvidenceVerdict;
  explanation: string;
}

/**
 * Avaliação única e honesta de uma combinação.
 *
 * O veredito NUNCA é "aprovado" apenas por soma de R positiva. Exige que o
 * t observado supere o t esperado do melhor de N testes sob ruído.
 */
export function assessEvidence(input: EvidenceInput): EvidenceAssessment {
  const {
    meanR,
    standardDeviationR,
    sampleSize,
    numberOfTests,
    significanceLevel = 0.05,
  } = input;

  const noiseFloor = expectedMaxTUnderNull(numberOfTests);
  const threshold = requiredTStatistic(numberOfTests, significanceLevel);

  const minimumSample = 30;

  if (sampleSize < 2 || standardDeviationR <= 0) {
    return {
      tStatistic: null,
      singleTestPValue: null,
      familyWisePValue: null,
      expectedMaxTUnderNull: noiseFloor,
      requiredTStatistic: threshold,
      excessOverNoise: null,
      deflatedSharpe: null,
      operationsStillNeeded: minimumSample - sampleSize,
      verdict: 'amostra_insuficiente',
      explanation:
        `Apenas ${sampleSize} operações. Nenhuma conclusão é possível ainda.`,
    };
  }

  const tStatistic = (meanR / standardDeviationR) * Math.sqrt(sampleSize);
  const singleP = oneSidedPValue(tStatistic);
  const familyP = sidakFamilyWisePValue(singleP, numberOfTests);
  const sharpe = meanR / standardDeviationR;

  const deflated = deflatedSharpeRatio({
    observedSharpe: sharpe,
    sampleSize,
    numberOfTrials: numberOfTests,
    skewness: input.skewness,
    kurtosis: input.kurtosis,
  });

  const needed = requiredSampleSize(
    Math.abs(meanR),
    standardDeviationR,
    numberOfTests,
    significanceLevel,
  );

  const stillNeeded = needed === null ? null : Math.max(0, needed - sampleSize);

  // Edge negativo com significância: informação valiosa, não neutra.
  if (tStatistic <= -threshold && sampleSize >= minimumSample) {
    return {
      tStatistic,
      singleTestPValue: singleP,
      familyWisePValue: familyP,
      expectedMaxTUnderNull: noiseFloor,
      requiredTStatistic: threshold,
      excessOverNoise: tStatistic - noiseFloor,
      deflatedSharpe: deflated,
      operationsStillNeeded: 0,
      verdict: 'negativo_significativo',
      explanation:
        `t = ${tStatistic.toFixed(2)} com ${sampleSize} operações. ` +
        `O edge negativo é estatisticamente sólido — isto não é azar, ` +
        `é um resultado que tende a se repetir. Encerre a hipótese.`,
    };
  }

  if (sampleSize < minimumSample) {
    return {
      tStatistic,
      singleTestPValue: singleP,
      familyWisePValue: familyP,
      expectedMaxTUnderNull: noiseFloor,
      requiredTStatistic: threshold,
      excessOverNoise: tStatistic - noiseFloor,
      deflatedSharpe: deflated,
      operationsStillNeeded: stillNeeded,
      verdict: 'amostra_insuficiente',
      explanation:
        `${sampleSize} operações é pouco para concluir qualquer coisa. ` +
        `Mínimo de ${minimumSample} antes de interpretar o t.`,
    };
  }

  if (tStatistic < noiseFloor) {
    return {
      tStatistic,
      singleTestPValue: singleP,
      familyWisePValue: familyP,
      expectedMaxTUnderNull: noiseFloor,
      requiredTStatistic: threshold,
      excessOverNoise: tStatistic - noiseFloor,
      deflatedSharpe: deflated,
      operationsStillNeeded: stillNeeded,
      verdict: 'indistinguivel_de_ruido',
      explanation:
        `t = ${tStatistic.toFixed(2)}, abaixo do piso de ruído ${noiseFloor.toFixed(2)} ` +
        `para ${numberOfTests} combinações testadas. O acaso produziria isto.`,
    };
  }

  if (tStatistic >= threshold && (deflated ?? 0) >= 0.95) {
    return {
      tStatistic,
      singleTestPValue: singleP,
      familyWisePValue: familyP,
      expectedMaxTUnderNull: noiseFloor,
      requiredTStatistic: threshold,
      excessOverNoise: tStatistic - noiseFloor,
      deflatedSharpe: deflated,
      operationsStillNeeded: 0,
      verdict: 'aprovado',
      explanation:
        `t = ${tStatistic.toFixed(2)} supera o limiar ${threshold.toFixed(2)} ` +
        `e o Sharpe deflacionado é ${(deflated! * 100).toFixed(1)}%. ` +
        `Evidência sobrevive à correção por múltiplos testes.`,
    };
  }

  return {
    tStatistic,
    singleTestPValue: singleP,
    familyWisePValue: familyP,
    expectedMaxTUnderNull: noiseFloor,
    requiredTStatistic: threshold,
    excessOverNoise: tStatistic - noiseFloor,
    deflatedSharpe: deflated,
    operationsStillNeeded: stillNeeded,
    verdict: 'promissor_sem_confirmacao',
    explanation:
      `t = ${tStatistic.toFixed(2)} está acima do ruído (${noiseFloor.toFixed(2)}) ` +
      `mas ainda abaixo do limiar ${threshold.toFixed(2)}. ` +
      `Continue coletando: faltam ~${stillNeeded ?? '?'} operações.`,
  };
}
