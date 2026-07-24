/**
 * app/api/forward-test/route.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Teste prospectivo das estratégias diárias.
 *
 * Por que uma rota do Next e não uma edge function: esta rota importa
 * lib/daytrade diretamente, ou seja, roda EXATAMENTE o mesmo código que foi
 * validado no backtest. As edge functions mantêm cópias próprias das
 * estratégias, e cópias divergem com o tempo — divergência entre o que foi
 * testado e o que está sendo medido invalidaria o experimento inteiro.
 *
 * A cada execução a rota faz duas coisas:
 *   1. resolve os sinais pendentes (entrada, stop, alvo, MFE/MAE);
 *   2. detecta sinais novos no último candle diário encerrado.
 *
 * NENHUMA ORDEM É EXECUTADA. Isto é registro e medição.
 *
 * Chamada pelo pg_cron uma vez por dia, autenticada por x-cron-secret.
 */

import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '@/lib/daytrade/indicators';

import {
  evaluateAllDayTradeStrategies,
} from '@/lib/daytrade/strategies/evaluateAll';

import type { DayTradeStrategyId } from '@/lib/daytrade/strategies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

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
  '12h': 12 * 60 * 60 * 1_000,
  '1d': 24 * 60 * 60 * 1_000,
};

/** Suficiente para aquecer EMA200 e a distribuição de volatilidade. */
const CANDLES_NECESSARIOS = 400;

/**
 * Buscas simultâneas na Binance. Com 30 moedas e 4 horizontes são 120
 * requisições; em série passariam do tempo limite da função. Quatro por vez
 * mantém o total em poucos segundos sem esbarrar no limite de taxa da API.
 */
const CONCORRENCIA = 4;

async function emLotes<T, R>(
  itens: readonly T[],
  tamanho: number,
  tarefa: (item: T) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    const lote = itens.slice(i, i + tamanho);
    resultados.push(...(await Promise.all(lote.map(tarefa))));
  }

  return resultados;
}

const BINANCE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  nome: string;
  versao: string;
  timeframes: string[];
  estrategias: string[];
  simbolos: string[];
  fee_rate_pct: number;
  slippage_pct: number;
  max_next_open_distance_atr: number;
}

interface SignalRow {
  id: string;
  simbolo: string;
  estrategia: string;
  timeframe: string;
  candle_open_time: string;
  entrada_referencia: number;
  stop_referencia: number;
  alvo_referencia: number;
  atr: number | null;
  status: string;
  entrada_preco: number | null;
  entrada_em: string | null;
}

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

async function buscarCandles(
  simbolo: string,
  timeframe: DayTradeIndicatorTimeframe,
): Promise<DayTradeCandle[]> {
  const intervalo = TIMEFRAME_MS[timeframe];
  const agora = Date.now();
  const inicio = agora - CANDLES_NECESSARIOS * intervalo;

  let ultimoErro: unknown = null;

  for (const base of BINANCE_BASE_URLS) {
    try {
      const url = new URL('/api/v3/klines', base);
      url.searchParams.set('symbol', simbolo);
      url.searchParams.set('interval', timeframe);
      url.searchParams.set('startTime', String(inicio));
      url.searchParams.set('limit', '1000');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BINANCE_TIMEOUT_MS);

      const resposta = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      }).finally(() => clearTimeout(timer));

      if (!resposta.ok) {
        ultimoErro = new Error(`HTTP ${resposta.status}`);
        continue;
      }

      const dados = (await resposta.json()) as unknown;
      if (!Array.isArray(dados)) {
        ultimoErro = new Error('resposta inesperada');
        continue;
      }

      const candles: DayTradeCandle[] = [];

      for (const linha of dados) {
        if (!Array.isArray(linha) || linha.length < 8) continue;

        const candle: DayTradeCandle = {
          openTime: Number(linha[0]),
          open: Number(linha[1]),
          high: Number(linha[2]),
          low: Number(linha[3]),
          close: Number(linha[4]),
          volume: Number(linha[5]),
          closeTime: Number(linha[6]),
          quoteVolume: Number(linha[7]),
          isClosed: Number(linha[6]) <= agora,
        };

        const numeros = [
          candle.openTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.closeTime,
        ];

        if (numeros.some((valor) => !Number.isFinite(valor))) continue;

        candles.push(candle);
      }

      return candles;
    } catch (erro) {
      ultimoErro = erro;
    }
  }

  throw ultimoErro instanceof Error
    ? ultimoErro
    : new Error(`Falha ao buscar candles de ${simbolo}.`);
}

// ---------------------------------------------------------------------------
// Simulação de execução (idêntica à regra do backtest)
// ---------------------------------------------------------------------------

function precoCompraComSlippage(preco: number, slippagePct: number): number {
  return preco * (1 + slippagePct / 100);
}

function precoVendaComSlippage(preco: number, slippagePct: number): number {
  return preco * (1 - slippagePct / 100);
}

interface ResolucaoResultado {
  status: 'aguardando_entrada' | 'aberto' | 'fechado' | 'cancelado';
  entrada_preco?: number;
  /** Alvo e risco recalculados sobre o preenchimento real, que é o que a
   *  simulação de fato usou — o plano original fica em *_referencia. */
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

/**
 * Reproduz a mesma sequência do backtest: entrada na abertura do candle
 * seguinte ao sinal, resolução intrabar conservadora (stop antes do alvo
 * quando o candle toca os dois) e alvo recalculado a partir do preenchimento
 * real para preservar a relação de risco planejada.
 */
function resolverSinal(
  sinal: SignalRow,
  candles: readonly DayTradeCandle[],
  config: ConfigRow,
): ResolucaoResultado {
  const tempoSinal = new Date(sinal.candle_open_time).getTime();

  const indiceSinal = candles.findIndex(
    (candle) => candle.openTime === tempoSinal,
  );

  if (indiceSinal < 0) {
    // Candle do sinal saiu da janela baixada; nada a fazer nesta execução.
    return { status: sinal.status as ResolucaoResultado['status'] };
  }

  const indiceEntrada = indiceSinal + 1;
  const candleEntrada = candles[indiceEntrada];

  if (!candleEntrada || !candleEntrada.isClosed) {
    if (!candleEntrada) return { status: 'aguardando_entrada' };
  }

  const risco = sinal.entrada_referencia - sinal.stop_referencia;

  if (!Number.isFinite(risco) || risco <= 0) {
    return {
      status: 'cancelado',
      saida_motivo: 'cancelado',
      cancelamento_motivo: 'plano_invalido',
      saida_em: new Date().toISOString(),
    };
  }

  // Abertura muito distante do planejado: não entra, para não simular um
  // preenchimento que na prática seria péssimo.
  if (
    sinal.atr !== null &&
    candleEntrada.open >
      sinal.entrada_referencia + sinal.atr * config.max_next_open_distance_atr
  ) {
    return {
      status: 'cancelado',
      saida_motivo: 'cancelado',
      cancelamento_motivo: 'abertura_distante',
      saida_em: new Date(candleEntrada.openTime).toISOString(),
    };
  }

  const entradaPreco =
    sinal.entrada_preco ??
    precoCompraComSlippage(candleEntrada.open, config.slippage_pct);

  const stop = sinal.stop_referencia;

  // Preserva o R planejado a partir do preenchimento real.
  const riscoReal = entradaPreco - stop;

  if (riscoReal <= 0) {
    return {
      status: 'cancelado',
      saida_motivo: 'cancelado',
      cancelamento_motivo: 'risco_real_invalido',
      saida_em: new Date(candleEntrada.openTime).toISOString(),
    };
  }

  const proporcaoAlvo =
    (sinal.alvo_referencia - sinal.entrada_referencia) / risco;

  const alvo = entradaPreco + riscoReal * proporcaoAlvo;

  let mfe = 0;
  let mae = 0;

  for (let i = indiceEntrada; i < candles.length; i += 1) {
    const candle = candles[i];
    if (!candle.isClosed) break;

    /**
     * Estimativa por extremos do candle, não trajetória real: o OHLC não diz
     * em que ordem a máxima e a mínima aconteceram. No candle de saída, a
     * máxima pode ter ocorrido depois de a posição já ter sido encerrada, o
     * que superestima a excursão favorável. O resultado financeiro continua
     * conservador; apenas MFE e MAE devem ser lidos como aproximação.
     */
    mfe = Math.max(mfe, (candle.high - entradaPreco) / riscoReal);
    mae = Math.min(mae, (candle.low - entradaPreco) / riscoReal);

    /**
     * A ordem das checagens reproduz exatamente a do motor de backtest.
     *
     * O caso do gap é o que mais importa: se o candle ABRE abaixo do stop, a
     * saída real acontece na abertura, não no preço do stop — o mercado
     * simplesmente passou por cima dele. Tratar como saída no stop tornaria o
     * resultado prospectivo mais otimista que o backtest, e no horizonte
     * diário gaps são comuns. No gap acima do alvo vale o inverso: usa-se o
     * alvo como preenchimento, que é o conservador.
     */
    let motivo: 'stop' | 'alvo' | null = null;
    let precoBruto = 0;

    if (candle.open <= stop) {
      motivo = 'stop';
      precoBruto = candle.open;
    } else if (candle.open >= alvo) {
      motivo = 'alvo';
      precoBruto = alvo;
    } else {
      const tocouStop = candle.low <= stop;
      const tocouAlvo = candle.high >= alvo;

      // Conservador: quando o candle toca os dois, considera o stop.
      if (tocouStop) {
        motivo = 'stop';
        precoBruto = stop;
      } else if (tocouAlvo) {
        motivo = 'alvo';
        precoBruto = alvo;
      }
    }

    if (motivo !== null) {
      const saidaPreco = precoVendaComSlippage(precoBruto, config.slippage_pct);

      const taxas =
        entradaPreco * (config.fee_rate_pct / 100) +
        saidaPreco * (config.fee_rate_pct / 100);

      const resultadoR = (saidaPreco - entradaPreco - taxas) / riscoReal;

      return {
        status: 'fechado',
        entrada_preco: entradaPreco,
        entrada_em: new Date(candleEntrada.openTime).toISOString(),
        alvo_efetivo: alvo,
        risco_efetivo: riscoReal,
        saida_preco: saidaPreco,
        saida_em: new Date(candle.closeTime).toISOString(),
        saida_motivo: motivo,
        resultado_r: resultadoR,
        excursao_favoravel_r: mfe,
        excursao_adversa_r: mae,
      };
    }
  }

  return {
    status: 'aberto',
    entrada_preco: entradaPreco,
    entrada_em: new Date(candleEntrada.openTime).toISOString(),
    alvo_efetivo: alvo,
    risco_efetivo: riscoReal,
    excursao_favoravel_r: mfe,
    excursao_adversa_r: mae,
  };
}

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------

function respostaJson(corpo: unknown, status = 200): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const segredoEsperado = process.env.CRON_SECRET;
  const segredoRecebido = req.headers.get('x-cron-secret');

  if (!segredoEsperado || segredoRecebido !== segredoEsperado) {
    return respostaJson({ ok: false, erro: 'não autorizado' }, 401);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    return respostaJson(
      { ok: false, erro: 'Supabase não configurado no servidor.' },
      500,
    );
  }

  const supabase: SupabaseClient = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: configData, error: configErro } = await supabase
    .from('forward_test_config')
    .select('*')
    .eq('ativo', true)
    .maybeSingle();

  if (configErro || !configData) {
    return respostaJson(
      { ok: false, erro: configErro?.message ?? 'nenhuma configuração ativa' },
      500,
    );
  }

  const config = configData as ConfigRow;
  const timeframes = config.timeframes as DayTradeIndicatorTimeframe[];

  const invalidos = timeframes.filter((tf) => !(tf in TIMEFRAME_MS));

  if (timeframes.length === 0 || invalidos.length > 0) {
    return respostaJson(
      { ok: false, erro: `timeframe inválido: ${invalidos.join(', ')}` },
      500,
    );
  }

  const inicioMs = Date.now();

  // Registro de auditoria: sem isto, uma falha do cron sumiria sem rastro e
  // criaria lacunas invisíveis no experimento.
  const { data: execucao } = await supabase
    .from('forward_test_runs')
    .insert({
      config_id: config.id,
      pares_esperados: config.simbolos.length * timeframes.length,
      status: 'executando',
    })
    .select('id')
    .maybeSingle();

  const execucaoId = (execucao as { id: string } | null)?.id ?? null;

  const resumo = {
    pares_processados: 0,
    falhas: [] as string[],
    resolvidos: 0,
    fechados: 0,
    cancelados: 0,
    novos: 0,
    por_timeframe: {} as Record<string, number>,
  };

  /** Cada combinação de moeda e horizonte é uma unidade independente. */
  const combinacoes = config.simbolos.flatMap((simbolo) =>
    timeframes.map((timeframe) => ({ simbolo, timeframe })),
  );

  await emLotes(combinacoes, CONCORRENCIA, async ({ simbolo, timeframe }) => {
    let candles: DayTradeCandle[];

    try {
      candles = await buscarCandles(simbolo, timeframe);
    } catch (erro) {
      resumo.falhas.push(
        `${simbolo} ${timeframe}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return;
    }

    if (candles.length < 250) {
      resumo.falhas.push(
        `${simbolo} ${timeframe}: histórico curto (${candles.length})`,
      );
      return;
    }

    resumo.pares_processados += 1;

    // ---- 1. Resolver sinais pendentes -------------------------------------

    const { data: pendentes } = await supabase
      .from('forward_test_signals')
      .select(
        'id, simbolo, estrategia, timeframe, candle_open_time, entrada_referencia, stop_referencia, alvo_referencia, atr, status, entrada_preco, entrada_em',
      )
      .eq('config_id', config.id)
      .eq('simbolo', simbolo)
      .eq('timeframe', timeframe)
      .in('status', ['aguardando_entrada', 'aberto']);

    for (const sinal of (pendentes ?? []) as SignalRow[]) {
      const resultado = resolverSinal(sinal, candles, config);

      if (resultado.status === sinal.status && resultado.status !== 'aberto') {
        continue;
      }

      const { error: erroUpdate } = await supabase
        .from('forward_test_signals')
        .update({ ...resultado, atualizado_em: new Date().toISOString() })
        .eq('id', sinal.id);

      if (!erroUpdate) {
        resumo.resolvidos += 1;
        if (resultado.status === 'fechado') resumo.fechados += 1;
        if (resultado.status === 'cancelado') resumo.cancelados += 1;
      }
    }

    // ---- 2. Detectar sinais novos -----------------------------------------

    const fechados = candles.filter((candle) => candle.isClosed);
    if (fechados.length < 250) return;

    const ultimo = fechados[fechados.length - 1];

    let avaliacao;

    try {
      avaliacao = evaluateAllDayTradeStrategies({
        candles: fechados,
        indicatorOptions: DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
        enabledStrategies: config.estrategias as DayTradeStrategyId[],
      });
    } catch (erro) {
      resumo.falhas.push(
        `${simbolo} ${timeframe}: avaliação — ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return;
    }

    for (const estrategia of config.estrategias) {
      const resultado = (
        avaliacao.evaluations as Record<string, unknown>
      )[estrategia] as
        | {
            status?: string;
            allConditionsMet?: boolean;
            strategyVersion?: string;
            scorePct?: number;
            passedConditions?: number;
            totalConditions?: number;
            candleOpenTime?: number;
            candleCloseTime?: number;
            plan?: {
              entryReference: number;
              stopReference: number;
              targetReference: number;
              riskPerUnit: number;
              stopDistanceAtr: number;
            } | null;
          }
        | undefined;

      if (
        !resultado ||
        resultado.status !== 'condicoes_atendidas' ||
        !resultado.allConditionsMet ||
        !resultado.plan
      ) {
        continue;
      }

      // Uma posição por moeda, estratégia e horizonte de cada vez, como no
      // backtest. Horizontes diferentes operam de forma independente.
      const { count } = await supabase
        .from('forward_test_signals')
        .select('id', { count: 'exact', head: true })
        .eq('config_id', config.id)
        .eq('simbolo', simbolo)
        .eq('timeframe', timeframe)
        .eq('estrategia', estrategia)
        .in('status', ['aguardando_entrada', 'aberto']);

      if ((count ?? 0) > 0) continue;

      // Anti-martingale suave: x1,5 quando a operação anterior fechada da
      // mesma moeda, estratégia e horizonte terminou positiva.
      const { data: anterior } = await supabase
        .from('forward_test_signals')
        .select('resultado_r')
        .eq('config_id', config.id)
        .eq('simbolo', simbolo)
        .eq('timeframe', timeframe)
        .eq('estrategia', estrategia)
        .eq('status', 'fechado')
        .order('candle_open_time', { ascending: false })
        .limit(1)
        .maybeSingle();

      const resultadoAnterior =
        anterior?.resultado_r === undefined || anterior?.resultado_r === null
          ? 'nenhum'
          : Number(anterior.resultado_r) > 0
            ? 'ganho'
            : 'perda';

      const plano = resultado.plan;

      const atr =
        plano.stopDistanceAtr > 0
          ? plano.riskPerUnit / plano.stopDistanceAtr
          : null;

      const { error: erroInsert } = await supabase
        .from('forward_test_signals')
        .insert({
          config_id: config.id,
          simbolo,
          timeframe,
          estrategia,
          estrategia_versao: resultado.strategyVersion ?? null,
          candle_open_time: new Date(
            resultado.candleOpenTime ?? ultimo.openTime,
          ).toISOString(),
          candle_close_time: new Date(
            resultado.candleCloseTime ?? ultimo.closeTime,
          ).toISOString(),
          entrada_referencia: plano.entryReference,
          stop_referencia: plano.stopReference,
          alvo_referencia: plano.targetReference,
          atr,
          score_pct: resultado.scorePct ?? null,
          condicoes_atendidas: resultado.passedConditions ?? null,
          condicoes_totais: resultado.totalConditions ?? null,
          tamanho_fixo: 1,
          tamanho_anti: resultadoAnterior === 'ganho' ? 1.5 : 1,
          resultado_anterior: resultadoAnterior,
        });

      // Conflito de chave única significa que o sinal já existia: o cron pode
      // rodar várias vezes sem duplicar nada.
      if (!erroInsert) {
        resumo.novos += 1;
        resumo.por_timeframe[timeframe] =
          (resumo.por_timeframe[timeframe] ?? 0) + 1;
      }
    }
  });
  const duracaoMs = Date.now() - inicioMs;

  if (execucaoId) {
    await supabase
      .from('forward_test_runs')
      .update({
        finalizado_em: new Date().toISOString(),
        pares_processados: resumo.pares_processados,
        sinais_criados: resumo.novos,
        sinais_resolvidos: resumo.resolvidos,
        falhas: resumo.falhas,
        duracao_ms: duracaoMs,
        // Falha parcial ainda conta como concluída; o que importa é que as
        // falhas fiquem registradas para auditoria posterior.
        status: resumo.pares_processados === 0 ? 'falhou' : 'concluido',
      })
      .eq('id', execucaoId);
  }

  return respostaJson({
    ok: true,
    config: `${config.nome} v${config.versao}`,
    execucao_id: execucaoId,
    executado_em: new Date().toISOString(),
    duracao_ms: duracaoMs,
    ...resumo,
  });
}
