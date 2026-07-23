/**
 * scripts/teste-sizing.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Testa esquemas de tamanho de posição sobre as sequências reais de operações.
 *
 * Por que isso funciona sem mexer no motor: o tamanho da posição não altera
 * quais operações acontecem nem quando — só quanto se arrisca em cada uma.
 * Então basta pegar a sequência de resultados em R produzida pelo backtest e
 * multiplicar cada resultado pelo tamanho que o esquema teria usado.
 *
 * MÉTRICA IMPORTANTE: com tamanho variável, somar R deixa de fazer sentido
 * (cada R vale um valor diferente em dinheiro). Por isso o relatório usa
 * resultado ponderado, rebaixamento máximo e a razão entre os dois — que é o
 * que de fato importa quando se compara esquemas de risco.
 *
 * O tamanho é calculado DENTRO de cada símbolo (a sequência de ganhos de uma
 * moeda não deve influenciar o tamanho em outra), e a curva de capital junta
 * todas as operações em ordem cronológica, como aconteceria operando a carteira.
 *
 * Uso:
 *
 *   npx tsx scripts/teste-sizing.ts [TIMEFRAME] [DIAS] [SIMBOLOS] [ESTRATEGIA] [CUSTOS]
 *
 * Exemplo:
 *
 *   npx tsx scripts/teste-sizing.ts 1d 2900 BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT trend_pullback
 *
 * Não grava nada no banco e não executa ordens.
 */

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '../lib/daytrade/indicators';

import type { DayTradeStrategyId } from '../lib/daytrade/strategies';

import { runWalkForwardBacktest } from '../lib/daytrade/walkForward';

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const BINANCE_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
] as const;

const TIMEFRAME_MS: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '4h': 4 * 60 * 60 * 1_000,
  '1d': 24 * 60 * 60 * 1_000,
};

const WINDOW_BY_TIMEFRAME: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 2_000,
  '15m': 2_000,
  '30m': 2_000,
  '1h': 2_000,
  '4h': 750,
  '1d': 250,
};

const PAGE_SIZE = 1_000;
const MAX_PAGES = 250;

// -----------------------------------------------------------------------------
// Esquemas de tamanho
// -----------------------------------------------------------------------------

/**
 * Cada esquema recebe a sequência de vitórias consecutivas e de derrotas
 * consecutivas imediatamente anteriores e devolve o multiplicador de risco.
 * O primeiro trade de cada símbolo sempre usa tamanho 1.
 */
interface Esquema {
  nome: string;
  descricao: string;
  multiplicador: (ganhosSeguidos: number, perdasSeguidas: number) => number;
}

const ESQUEMAS: Esquema[] = [
  {
    nome: 'fixo',
    descricao: 'sempre o mesmo tamanho (referência)',
    multiplicador: () => 1,
  },
  {
    nome: 'anti-mart suave',
    descricao: 'x1,5 após ganho; normal após perda',
    multiplicador: (ganhos) => (ganhos > 0 ? 1.5 : 1),
  },
  {
    nome: 'anti-mart escada',
    descricao: 'aumenta com a sequência de ganhos, teto x3',
    multiplicador: (ganhos) => Math.min(3, 1 + 0.5 * ganhos),
  },
  {
    nome: 'anti-mart agressivo',
    descricao: 'x2 após ganho; metade após perda',
    multiplicador: (ganhos) => (ganhos > 0 ? 2 : 0.5),
  },
  {
    nome: 'martingale',
    descricao: 'dobra a cada perda seguida, teto x8',
    multiplicador: (_ganhos, perdas) => Math.min(8, 2 ** perdas),
  },
];

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\nErro: ${message}\n`);
  process.exit(1);
}

const [, , rawTimeframe, rawDays, rawSymbols, rawStrategy, rawCosts] =
  process.argv;

const timeframe = (rawTimeframe ?? '1d') as DayTradeIndicatorTimeframe;
if (!(timeframe in TIMEFRAME_MS)) fail(`Timeframe inválido: ${rawTimeframe}.`);

const days = rawDays ? Number(rawDays) : 2_900;
if (!Number.isFinite(days) || days < 5 || days > 3_650) {
  fail(`Dias inválido: ${rawDays}.`);
}

const symbols = (rawSymbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
  .split(',')
  .map((item) => item.toUpperCase().trim())
  .filter((item) => item.length > 0);

const strategyId = (rawStrategy ?? 'trend_pullback') as DayTradeStrategyId;

const costsKey = (rawCosts ?? 'reais').toLowerCase().trim();
const feeRatePct = costsKey === 'zero' ? 0 : 0.1;
const slippagePct = costsKey === 'zero' ? 0 : 0.05;

const WINDOW_CANDLES = WINDOW_BY_TIMEFRAME[timeframe];

// -----------------------------------------------------------------------------
// Download
// -----------------------------------------------------------------------------

async function fetchHistory(symbol: string): Promise<DayTradeCandle[]> {
  const intervalMs = TIMEFRAME_MS[timeframe];
  const endTime = Date.now();
  const candles: DayTradeCandle[] = [];

  let cursor = endTime - days * 24 * 60 * 60 * 1_000;
  let pages = 0;

  while (cursor < endTime && pages < MAX_PAGES) {
    let page: unknown[] | null = null;

    for (const baseUrl of BINANCE_BASE_URLS) {
      try {
        const url = new URL('/api/v3/klines', baseUrl);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', timeframe);
        url.searchParams.set('startTime', String(cursor));
        url.searchParams.set('endTime', String(endTime));
        url.searchParams.set('limit', String(PAGE_SIZE));

        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) continue;

        const payload = (await response.json()) as unknown;
        if (Array.isArray(payload)) {
          page = payload;
          break;
        }
      } catch {
        // tenta o próximo domínio
      }
    }

    if (page === null || page.length === 0) break;

    for (const row of page) {
      if (!Array.isArray(row) || row.length < 8) continue;

      const candle: DayTradeCandle = {
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closeTime: Number(row[6]),
        quoteVolume: Number(row[7]),
        isClosed: Number(row[6]) <= Date.now(),
      };

      if (
        Object.values(candle).some(
          (value) => typeof value === 'number' && !Number.isFinite(value),
        )
      ) {
        continue;
      }

      candles.push(candle);
    }

    const lastOpen = Number(page[page.length - 1]?.[0 as never]);
    if (!Number.isFinite(lastOpen)) break;

    cursor = lastOpen + intervalMs;
    pages += 1;

    if (page.length < PAGE_SIZE) break;
  }

  return candles;
}

// -----------------------------------------------------------------------------
// Simulação dos esquemas
// -----------------------------------------------------------------------------

interface Operacao {
  simbolo: string;
  entrada: number;
  resultadoR: number;
}

interface Metricas {
  operacoes: number;
  resultado: number;
  rebaixamento: number;
  razao: number | null;
  /** Média dividida pelo desvio padrão por operação. Robusta e sem escala. */
  consistencia: number | null;
}

interface Avaliacao {
  esquema: string;
  descricao: string;
  total: Metricas;
  primeiraMetade: Metricas;
  segundaMetade: Metricas;
  maiorAposta: number;
  piorPerdaUnica: number;
}

/**
 * Calcula as métricas de uma sequência já ponderada pelo tamanho.
 *
 * A razão resultado/rebaixamento é intuitiva mas frágil: o rebaixamento máximo
 * é um único episódio extremo e muda muito com pequenas alterações. Por isso
 * vem acompanhada da consistência (média sobre desvio padrão por operação),
 * que usa toda a amostra e é bem mais estável. Quando as duas discordam,
 * a razão provavelmente está refletindo sorte de um episódio específico.
 */
function calcularMetricas(ganhos: readonly number[]): Metricas {
  if (ganhos.length === 0) {
    return {
      operacoes: 0,
      resultado: 0,
      rebaixamento: 0,
      razao: null,
      consistencia: null,
    };
  }

  let acumulado = 0;
  let pico = 0;
  let rebaixamento = 0;

  for (const ganho of ganhos) {
    acumulado += ganho;
    pico = Math.max(pico, acumulado);
    rebaixamento = Math.max(rebaixamento, pico - acumulado);
  }

  const media = acumulado / ganhos.length;

  const desvio =
    ganhos.length < 2
      ? null
      : Math.sqrt(
          ganhos.reduce((total, g) => total + (g - media) ** 2, 0) /
            (ganhos.length - 1),
        );

  return {
    operacoes: ganhos.length,
    resultado: acumulado,
    rebaixamento,
    razao: rebaixamento > 0 ? acumulado / rebaixamento : null,
    consistencia:
      desvio === null || desvio < 1e-9 ? null : media / desvio,
  };
}

function avaliar(
  esquema: Esquema,
  porSimbolo: Map<string, Operacao[]>,
): Avaliacao {
  interface Marcada {
    entrada: number;
    ganho: number;
  }

  const marcadas: Marcada[] = [];
  let maiorAposta = 0;
  let piorPerdaUnica = 0;

  for (const operacoes of porSimbolo.values()) {
    let ganhosSeguidos = 0;
    let perdasSeguidas = 0;

    for (const operacao of operacoes) {
      const tamanho = esquema.multiplicador(ganhosSeguidos, perdasSeguidas);
      const ganho = operacao.resultadoR * tamanho;

      marcadas.push({ entrada: operacao.entrada, ganho });

      maiorAposta = Math.max(maiorAposta, tamanho);
      piorPerdaUnica = Math.min(piorPerdaUnica, ganho);

      if (operacao.resultadoR > 0) {
        ganhosSeguidos += 1;
        perdasSeguidas = 0;
      } else if (operacao.resultadoR < 0) {
        perdasSeguidas += 1;
        ganhosSeguidos = 0;
      }
    }
  }

  // Curva de capital da carteira, em ordem cronológica.
  marcadas.sort((a, b) => a.entrada - b.entrada);

  const ganhos = marcadas.map((item) => item.ganho);
  const corte = Math.floor(ganhos.length / 2);

  return {
    esquema: esquema.nome,
    descricao: esquema.descricao,
    total: calcularMetricas(ganhos),
    primeiraMetade: calcularMetricas(ganhos.slice(0, corte)),
    segundaMetade: calcularMetricas(ganhos.slice(corte)),
    maiorAposta,
    piorPerdaUnica,
  };
}

// -----------------------------------------------------------------------------
// Execução
// -----------------------------------------------------------------------------

function fmt(value: number | null, casas = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sinal = value > 0 ? '+' : '';
  return `${sinal}${value.toFixed(casas)}`;
}

async function main(): Promise<void> {
  console.log(
    `Teste de tamanho de posição: ${strategyId} · ${timeframe} · ${days} dias · custos ${costsKey}`,
  );
  console.log(`Símbolos: ${symbols.join(', ')}\n`);

  const porSimbolo = new Map<string, Operacao[]>();

  for (const simbolo of symbols) {
    process.stdout.write(`\rProcessando ${simbolo}...            `);

    let candles: DayTradeCandle[];

    try {
      candles = await fetchHistory(simbolo);
    } catch {
      continue;
    }

    if (candles.length < WINDOW_CANDLES + 300) continue;

    const resultado = runWalkForwardBacktest({
      strategyId,
      candles,
      indicatorOptions: DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
      backtestOptions: {
        initialCapitalUsdt: 1_000,
        riskPercent: 1,
        feeRatePct,
        slippagePct,
      },
      walkForwardOptions: {
        windowCandles: WINDOW_CANDLES,
        warmupCandles: 300,
      },
    });

    const operacoes: Operacao[] = [];

    for (const janela of resultado.windowResults) {
      if (!janela) continue;

      for (const trade of janela.trades) {
        if (trade.exitReason === 'end_of_data') continue;

        operacoes.push({
          simbolo,
          entrada: trade.entryTime,
          resultadoR: trade.resultR,
        });
      }
    }

    operacoes.sort((a, b) => a.entrada - b.entrada);
    if (operacoes.length > 0) porSimbolo.set(simbolo, operacoes);
  }

  process.stdout.write('\r                                        \r');

  const total = [...porSimbolo.values()].reduce(
    (soma, lista) => soma + lista.length,
    0,
  );

  if (total === 0) fail('Nenhuma operação encontrada.');

  console.log(
    `Operações: ${total} em ${porSimbolo.size} símbolos\n`,
  );

  const avaliacoes = ESQUEMAS.map((esquema) => avaliar(esquema, porSimbolo));
  const referencia = avaliacoes[0];

  console.log('=== PERÍODO COMPLETO ===\n');
  console.log(
    'esquema              | resultado | rebaixa. | result/rebaix. | consistência | maior aposta',
  );
  console.log(
    '---------------------|-----------|----------|----------------|--------------|-------------',
  );

  for (const a of avaliacoes) {
    console.log(
      `${a.esquema.padEnd(20)} | ${fmt(a.total.resultado).padStart(9)} | ` +
        `${a.total.rebaixamento.toFixed(2).padStart(8)} | ${fmt(a.total.razao).padStart(14)} | ` +
        `${fmt(a.total.consistencia, 3).padStart(12)} | ` +
        `${('x' + a.maiorAposta.toFixed(1)).padStart(12)}`,
    );
  }

  console.log('\n=== VALIDAÇÃO EM DUAS METADES (o teste que decide) ===\n');
  console.log(
    'esquema              | 1a metade razão | 2a metade razão | 1a consist. | 2a consist.',
  );
  console.log(
    '---------------------|-----------------|-----------------|-------------|------------',
  );

  for (const a of avaliacoes) {
    console.log(
      `${a.esquema.padEnd(20)} | ${fmt(a.primeiraMetade.razao).padStart(15)} | ` +
        `${fmt(a.segundaMetade.razao).padStart(15)} | ` +
        `${fmt(a.primeiraMetade.consistencia, 3).padStart(11)} | ` +
        `${fmt(a.segundaMetade.consistencia, 3).padStart(11)}`,
    );
  }

  console.log('\nDescrição dos esquemas:');
  for (const a of avaliacoes) {
    console.log(`  ${a.esquema.padEnd(20)} ${a.descricao}`);
  }

  console.log('\n=== Leitura ===\n');
  console.log(
    'A coluna que decide é result/rebaix. — quanto se ganha por unidade de',
  );
  console.log(
    'sofrimento. Aumentar o tamanho quase sempre aumenta o resultado bruto;',
  );
  console.log(
    'isso sozinho não é mérito, porque aumentar o risco também aumentaria o',
  );
  console.log('resultado de uma estratégia perdedora.\n');

  console.log(
    'A consistência (média sobre desvio padrão por operação) é a métrica mais',
  );
  console.log(
    'confiável: usa toda a amostra, enquanto o rebaixamento máximo depende de',
  );
  console.log(
    'um único episódio. Quando as duas discordam, confie na consistência.\n',
  );

  /** Um esquema só é considerado aprovado se superar o fixo nas duas metades. */
  const aprovados = avaliacoes.filter((a) => {
    if (a.esquema === referencia.esquema) return false;

    const c1 = a.primeiraMetade.consistencia;
    const c2 = a.segundaMetade.consistencia;
    const r1 = referencia.primeiraMetade.consistencia;
    const r2 = referencia.segundaMetade.consistencia;

    if (c1 === null || c2 === null || r1 === null || r2 === null) return false;

    return c1 > r1 && c2 > r2;
  });

  if (aprovados.length === 0) {
    console.log(
      'Nenhum esquema superou o tamanho fixo em consistência nas DUAS metades.',
    );
    console.log(
      'Melhora que aparece só no período completo ou só numa metade é o padrão',
    );
    console.log(
      'típico de ajuste ao passado, não de vantagem que se repete adiante.',
    );
  } else {
    console.log('Superaram o tamanho fixo em consistência nas duas metades:');

    for (const a of aprovados) {
      console.log(
        `  ${a.esquema.padEnd(20)} 1a ${fmt(a.primeiraMetade.consistencia, 3)} ` +
          `vs ${fmt(referencia.primeiraMetade.consistencia, 3)} · ` +
          `2a ${fmt(a.segundaMetade.consistencia, 3)} ` +
          `vs ${fmt(referencia.segundaMetade.consistencia, 3)}`,
      );
    }

    console.log(
      '\nMesmo aprovado, lembre-se de que o esquema foi escolhido entre cinco',
    );
    console.log(
      'candidatos sobre os mesmos dados — parte da vantagem pode ser seleção.',
    );
  }

  console.log(
    '\nLimitação do modelo: os resultados são somados em R, como se cada',
  );
  console.log(
    'operação arriscasse um valor fixo. Arriscando percentual do capital há',
  );
  console.log(
    'capitalização, que amplifica tanto os ganhos quanto os rebaixamentos.',
  );

  console.log(
    '\nResultado educacional. Não representa recomendação nem promessa de resultado.\n',
  );
}

main().catch((error) => {
  console.error(
    `\nFalha: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
