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

import {
  evaluationWindow,
  resolveForwardLongSignal,
  selectRecoveryCandles,
} from '@/lib/forward-test/engine';

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
const MAX_CANDLES_RECUPERADOS = 24;

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
  const agora = Date.now();

  let ultimoErro: unknown = null;

  for (const base of BINANCE_BASE_URLS) {
    try {
      const url = new URL('/api/v3/klines', base);
      url.searchParams.set('symbol', simbolo);
      url.searchParams.set('interval', timeframe);
      // Inclui aquecimento, recuperação e margem para posições abertas.
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
    candles_avaliados: 0,
    candles_recuperados: 0,
    pares_bloqueados: 0,
    backlog_pares: 0,
    backlog_candles_estimados: 0,
  };

  /** Cada combinação de moeda e horizonte é uma unidade independente. */
  const combinacoes = config.simbolos.flatMap((simbolo) =>
    timeframes.map((timeframe) => ({ simbolo, timeframe })),
  );

  await emLotes(combinacoes, CONCORRENCIA, async ({ simbolo, timeframe }) => {
    let lockToken: string | null = null;
    try {
      const { data: claimData, error: claimError } = await supabase.rpc('claim_forward_test_checkpoint', {
        p_config_id: config.id,
        p_simbolo: simbolo,
        p_timeframe: timeframe,
        p_run_id: execucaoId,
        p_lock_seconds: 240,
      });
      if (claimError) throw new Error('checkpoint: ' + claimError.message);
      const claim = (claimData ?? {}) as Record<string, unknown>;
      if (claim.claimed !== true) {
        if (claim.code === 'FORWARD_TEST_PAIR_LOCKED') {
          resumo.pares_bloqueados += 1;
          return;
        }
        throw new Error(String(claim.code ?? 'checkpoint não reservado'));
      }
      lockToken = typeof claim.lock_token === 'string' ? claim.lock_token : null;
      if (!lockToken) throw new Error('checkpoint sem lock_token');

      const candles = await buscarCandles(simbolo, timeframe);
      const fechados = candles.filter((candle) => candle.isClosed).sort((a, b) => a.openTime - b.openTime);
      if (fechados.length < 250) throw new Error('histórico curto (' + fechados.length + ')');

      const { data: pendingData, error: pendingError } = await supabase
        .from('forward_test_signals')
        .select('id, simbolo, estrategia, timeframe, candle_open_time, entrada_referencia, stop_referencia, alvo_referencia, atr, status, entrada_preco, entrada_em')
        .eq('config_id', config.id)
        .eq('simbolo', simbolo)
        .eq('timeframe', timeframe)
        .in('status', ['aguardando_entrada', 'aberto']);
      if (pendingError) throw new Error('sinais pendentes: ' + pendingError.message);
      const active = new Map<string, SignalRow>();
      for (const signal of (pendingData ?? []) as SignalRow[]) active.set(signal.estrategia, signal);

      const { data: closedData, error: closedError } = await supabase
        .from('forward_test_signals')
        .select('estrategia, resultado_r, candle_open_time')
        .eq('config_id', config.id)
        .eq('simbolo', simbolo)
        .eq('timeframe', timeframe)
        .eq('status', 'fechado')
        .order('candle_open_time', { ascending: false })
        .limit(30);
      if (closedError) throw new Error('histórico fechado: ' + closedError.message);
      const previous = new Map<string, number>();
      for (const row of (closedData ?? []) as Array<{ estrategia: string; resultado_r: number | null }>) {
        if (!previous.has(row.estrategia) && row.resultado_r !== null) previous.set(row.estrategia, Number(row.resultado_r));
      }

      const selection = selectRecoveryCandles(
        fechados,
        typeof claim.last_evaluated_open_time === 'string' ? claim.last_evaluated_open_time : null,
        MAX_CANDLES_RECUPERADOS,
      );
      let lastEvaluated: DayTradeCandle | null = null;

      for (const candleIndex of selection.indexes) {
        const untilNow = fechados.slice(0, candleIndex + 1);
        const current = fechados[candleIndex];
        lastEvaluated = current;

        for (const [strategy, signal] of [...active.entries()]) {
          const resolution = resolveForwardLongSignal(signal, untilNow, config);
          if (resolution.status !== signal.status || ['aberto', 'fechado', 'cancelado'].includes(resolution.status)) {
            const { error } = await supabase
              .from('forward_test_signals')
              .update({ ...resolution, atualizado_em: new Date().toISOString() })
              .eq('id', signal.id);
            if (error) throw new Error('atualização ' + signal.id + ': ' + error.message);
            resumo.resolvidos += 1;
          }
          if (resolution.status === 'fechado') {
            resumo.fechados += 1;
            if (resolution.resultado_r !== undefined) previous.set(strategy, resolution.resultado_r);
            active.delete(strategy);
          } else if (resolution.status === 'cancelado') {
            resumo.cancelados += 1;
            active.delete(strategy);
          } else {
            active.set(strategy, {
              ...signal,
              ...resolution,
              entrada_preco: resolution.entrada_preco ?? signal.entrada_preco,
              entrada_em: resolution.entrada_em ?? signal.entrada_em,
            });
          }
        }

        const window = evaluationWindow(fechados, candleIndex, CANDLES_NECESSARIOS);
        if (window.length < 250) throw new Error('aquecimento insuficiente em ' + current.openTime);
        const evaluation = evaluateAllDayTradeStrategies({
          candles: window,
          indicatorOptions: DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
          enabledStrategies: config.estrategias as DayTradeStrategyId[],
        });

        for (const strategy of config.estrategias) {
          if (active.has(strategy)) continue;
          const result = (evaluation.evaluations as Record<string, unknown>)[strategy] as undefined | {
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
          };
          if (!result || result.status !== 'condicoes_atendidas' || !result.allConditionsMet || !result.plan) continue;
          const plan = result.plan;
          const prior = previous.get(strategy);
          const priorLabel = prior === undefined ? 'nenhum' : prior > 0 ? 'ganho' : 'perda';
          const row = {
            config_id: config.id,
            simbolo,
            timeframe,
            estrategia: strategy,
            estrategia_versao: result.strategyVersion ?? null,
            candle_open_time: new Date(result.candleOpenTime ?? current.openTime).toISOString(),
            candle_close_time: new Date(result.candleCloseTime ?? current.closeTime).toISOString(),
            entrada_referencia: plan.entryReference,
            stop_referencia: plan.stopReference,
            alvo_referencia: plan.targetReference,
            atr: plan.stopDistanceAtr > 0 ? plan.riskPerUnit / plan.stopDistanceAtr : null,
            score_pct: result.scorePct ?? null,
            condicoes_atendidas: result.passedConditions ?? null,
            condicoes_totais: result.totalConditions ?? null,
            tamanho_fixo: 1,
            tamanho_anti: priorLabel === 'ganho' ? 1.5 : 1,
            resultado_anterior: priorLabel,
          };
          const { data: inserted, error: insertError } = await supabase
            .from('forward_test_signals')
            .insert(row)
            .select('id, simbolo, estrategia, timeframe, candle_open_time, entrada_referencia, stop_referencia, alvo_referencia, atr, status, entrada_preco, entrada_em')
            .maybeSingle();
          if (insertError && insertError.code !== '23505') throw new Error('novo sinal ' + strategy + ': ' + insertError.message);
          let signal = inserted as SignalRow | null;
          if (!signal && insertError?.code === '23505') {
            const { data: existing } = await supabase
              .from('forward_test_signals')
              .select('id, simbolo, estrategia, timeframe, candle_open_time, entrada_referencia, stop_referencia, alvo_referencia, atr, status, entrada_preco, entrada_em')
              .eq('config_id', config.id)
              .eq('simbolo', simbolo)
              .eq('timeframe', timeframe)
              .eq('estrategia', strategy)
              .eq('candle_open_time', row.candle_open_time)
              .maybeSingle();
            signal = existing as SignalRow | null;
          }
          if (signal && ['aguardando_entrada', 'aberto'].includes(signal.status)) active.set(strategy, signal);
          if (!insertError) {
            resumo.novos += 1;
            resumo.por_timeframe[timeframe] = (resumo.por_timeframe[timeframe] ?? 0) + 1;
          }
        }
      }

      const { data: completionData, error: completionError } = await supabase.rpc('complete_forward_test_checkpoint', {
        p_config_id: config.id,
        p_simbolo: simbolo,
        p_timeframe: timeframe,
        p_lock_token: lockToken,
        p_run_id: execucaoId,
        p_last_evaluated_open_time: lastEvaluated ? new Date(lastEvaluated.openTime).toISOString() : null,
        p_last_evaluated_close_time: lastEvaluated ? new Date(lastEvaluated.closeTime).toISOString() : null,
        p_candles_evaluated: selection.indexes.length,
        p_recovery_candles: selection.recoveredCount,
        p_backlog_estimated: selection.backlog,
      });
      if (completionError) throw new Error('conclusão: ' + completionError.message);
      if (((completionData ?? {}) as Record<string, unknown>).updated !== true) throw new Error('checkpoint não concluído');

      resumo.pares_processados += 1;
      resumo.candles_avaliados += selection.indexes.length;
      resumo.candles_recuperados += selection.recoveredCount;
      resumo.backlog_candles_estimados += selection.backlog;
      if (selection.backlog > 0) resumo.backlog_pares += 1;
    } catch (error) {
      const message = simbolo + ' ' + timeframe + ': ' + (error instanceof Error ? error.message : String(error));
      resumo.falhas.push(message);
      if (lockToken) {
        await supabase.rpc('fail_forward_test_checkpoint', {
          p_config_id: config.id,
          p_simbolo: simbolo,
          p_timeframe: timeframe,
          p_lock_token: lockToken,
          p_run_id: execucaoId,
          p_error: message,
        });
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
        candles_avaliados: resumo.candles_avaliados,
        candles_recuperados: resumo.candles_recuperados,
        pares_bloqueados: resumo.pares_bloqueados,
        backlog_pares: resumo.backlog_pares,
        backlog_candles_estimados: resumo.backlog_candles_estimados,
        status:
          resumo.pares_processados === 0 && resumo.pares_bloqueados === 0
            ? 'falhou'
            : resumo.falhas.length > 0
              ? 'concluido_com_falhas'
              : 'concluido',
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
