/**
 * funding-carry — coletor observacional de carry delta-neutro
 * ---------------------------------------------------------------------------
 * VERSÃO 2.0.0 — elegibilidade por persistência medida
 *
 * O QUE MUDOU EM RELAÇÃO À v1
 *
 * A v1 lia o funding instantâneo e projetava-o sobre 30 dias de retenção.
 * Em 09/08/2026 isso marcou BNBUSDT com "+11,23% de carry líquido anualizado"
 * a partir de um pico que durou seis horas.
 *
 * A premissa foi medida nos 2.706 snapshots já coletados:
 *
 *   funding >= 15% agora  ->  8,86% em 24h  ->  6,30% em 72h
 *   funding 10,9-15%      ->  8,01% em 24h  ->  6,17% em 72h
 *   funding 5-10,9%       ->  6,15% em 24h  ->  5,67% em 72h
 *   funding <= 0%         ->  1,46% em 24h  ->  3,61% em 72h
 *
 * O funding reverte para ~6% anualizado em 72h independentemente de onde
 * começa. A taxa instantânea não é o que se recebe.
 *
 * A v2 usa a média móvel de 72h como estimador do que será efetivamente
 * pago, e exige que o ganho projetado sobre o horizonte de retenção supere
 * o custo de ida e volta mais uma margem de segurança.
 *
 * Validação retrospectiva (1.936 horas com janela completa, custo 0,60%):
 * a regra nova rejeita BNBUSDT — o único símbolo que a v1 aceitou — e
 * seleciona LINK (113h), SOL (42h) e UNI (39h), que têm funding
 * persistentemente alto.
 *
 * TODOS OS PARÂMETROS AGORA VÊM DO BANCO. A v1 tinha as constantes
 * hardcoded, o que permitia que o código e a tabela funding_carry_protocol
 * divergissem silenciosamente. O protocolo congelado é a única fonte de
 * verdade; se ele não existir, a função falha em vez de adivinhar.
 *
 * Este módulo NÃO EXECUTA ORDENS e não altera nenhuma política de execução.
 * Ele apenas observa e registra.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const FUNCTION_VERSION = "funding-carry-v2.0.0";

interface Protocolo {
  versao: string;
  simbolos: string[];
  funding_anualizado_min_pct: number;
  basis_abs_max_pct: number;
  custo_round_trip_pct: number;
  holding_dias_assumido: number;
  funding_ma_horas: number;
  margem_seguranca_pct: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * Piso de funding derivado do custo, não escolhido a dedo.
 *
 * Para que a operação pague, o ganho ao longo do período de retenção
 * precisa superar o custo de ida e volta mais a margem:
 *
 *   funding_medio * holding / 365 > custo + margem
 *
 * Manter isto como fórmula, e não como número, impede que o piso fique
 * desatualizado quando o custo for revisado.
 */
const pisoDerivado = (p: Protocolo): number =>
  ((p.custo_round_trip_pct + p.margem_seguranca_pct) * 365) /
  p.holding_dias_assumido;

Deno.serve(async (request: Request) => {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || request.headers.get("x-cron-secret") !== expected) {
    return json({ ok: false, error: "não autorizado" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return json({ ok: false, error: "Supabase não configurado" }, 500);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -------------------------------------------------------------------------
  // 1. Protocolo congelado — única fonte de verdade dos parâmetros
  // -------------------------------------------------------------------------

  const { data: protocoloRow, error: protocoloError } = await supabase
    .from("funding_carry_protocol")
    .select(
      "versao,simbolos,funding_anualizado_min_pct,basis_abs_max_pct," +
        "custo_round_trip_pct,holding_dias_assumido,funding_ma_horas," +
        "margem_seguranca_pct",
    )
    .eq("status", "coletando")
    .order("congelado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (protocoloError) {
    return json({ ok: false, error: protocoloError.message }, 500);
  }
  if (!protocoloRow) {
    // Falhar é o comportamento correto. Coletar sem protocolo ativo produz
    // dados que ninguém sabe interpretar depois.
    return json(
      { ok: false, error: "nenhum protocolo com status 'coletando'" },
      409,
    );
  }

  const protocolo = protocoloRow as unknown as Protocolo;
  const simbolos = new Set(protocolo.simbolos);
  const janelaHoras = Math.max(1, protocolo.funding_ma_horas);

  // Se o piso guardado na tabela divergir do derivado, usa o mais exigente.
  // Divergência significa que alguém mexeu no custo sem recalcular o piso.
  const pisoTabela = protocolo.funding_anualizado_min_pct;
  const pisoCalculado = pisoDerivado(protocolo);
  const piso = Math.max(pisoTabela, pisoCalculado);
  const pisoDivergente = Math.abs(pisoTabela - pisoCalculado) > 0.01;

  // -------------------------------------------------------------------------
  // 2. Histórico recente para a média móvel
  // -------------------------------------------------------------------------

  const desde = new Date(Date.now() - janelaHoras * 3_600_000).toISOString();
  const { data: historico, error: historicoError } = await supabase
    .from("funding_carry_snapshots")
    .select("simbolo,funding_anualizado_pct,coletado_em")
    .gte("coletado_em", desde)
    .order("coletado_em", { ascending: false })
    .limit(janelaHoras * simbolos.size + 200);

  if (historicoError) {
    return json({ ok: false, error: historicoError.message }, 500);
  }

  const anteriores = new Map<string, number[]>();
  for (const linha of historico ?? []) {
    const simbolo = String(linha.simbolo);
    const valor = Number(linha.funding_anualizado_pct);
    if (!Number.isFinite(valor)) continue;
    const lista = anteriores.get(simbolo) ?? [];
    // A leitura atual entra depois; por isso guardamos janela - 1.
    if (lista.length < janelaHoras - 1) {
      lista.push(valor);
      anteriores.set(simbolo, lista);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Leitura da Binance
  // -------------------------------------------------------------------------

  let response: Response | null = null;
  let lastError = "Binance indisponível";
  for (const base of ["https://fapi.binance.com", "https://fapi.binance.vision"]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const attempt = await fetch(`${base}/fapi/v1/premiumIndex`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (attempt.ok) {
        response = attempt;
        break;
      }
      lastError = `Binance HTTP ${attempt.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response) {
    return json({ ok: false, error: lastError }, 502);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return json({ ok: false, error: "resposta inesperada da Binance" }, 502);
  }

  // -------------------------------------------------------------------------
  // 4. Avaliação
  // -------------------------------------------------------------------------

  const collectedAt = new Date().toISOString();
  const custoAnualizado =
    (protocolo.custo_round_trip_pct * 365) / protocolo.holding_dias_assumido;

  const rows = payload.flatMap((item: Record<string, unknown>) => {
    const symbol = String(item.symbol ?? "");
    if (!simbolos.has(symbol)) return [];

    const markPrice = Number(item.markPrice);
    const indexPrice = Number(item.indexPrice);
    const fundingRate = Number(item.lastFundingRate);
    if (
      !Number.isFinite(markPrice) || markPrice <= 0 ||
      !Number.isFinite(indexPrice) || indexPrice <= 0 ||
      !Number.isFinite(fundingRate)
    ) {
      return [];
    }

    const fundingRatePct = fundingRate * 100;
    const annualizedFundingPct = fundingRate * 3 * 365 * 100;
    const basisPct = (markPrice / indexPrice - 1) * 100;

    // Média móvel incluindo a leitura atual.
    const janela = [annualizedFundingPct, ...(anteriores.get(symbol) ?? [])];
    const horasNaMedia = janela.length;
    const mediaMovel = janela.reduce((soma, v) => soma + v, 0) / horasNaMedia;

    // Projeção sobre o horizonte de retenção — NÃO anualizada.
    const ganhoPeriodoPct =
      (mediaMovel * protocolo.holding_dias_assumido) / 365;
    const liquidoPeriodoPct = ganhoPeriodoPct - protocolo.custo_round_trip_pct;

    // Mantido por compatibilidade com o histórico e com a tela atual.
    const netAnnualizedPct = mediaMovel - custoAnualizado;

    const janelaCompleta = horasNaMedia >= janelaHoras;
    const basisOk = Math.abs(basisPct) <= protocolo.basis_abs_max_pct;
    const pagaCusto = liquidoPeriodoPct > protocolo.margem_seguranca_pct;
    const acimaDoPiso = mediaMovel >= piso;

    const eligible = janelaCompleta && basisOk && pagaCusto && acimaDoPiso;

    const reason = eligible
      ? `Funding médio de ${mediaMovel.toFixed(2)}% a.a. sustentado por ` +
        `${horasNaMedia}h. Projetado sobre ${protocolo.holding_dias_assumido} ` +
        `dias sobra ${liquidoPeriodoPct.toFixed(3)}% líquido do notional.`
      : !janelaCompleta
      ? `Janela de persistência incompleta: ${horasNaMedia} de ${janelaHoras}h. ` +
        `Sem histórico suficiente não há como estimar o que será recebido.`
      : !basisOk
      ? `Basis de ${basisPct.toFixed(3)}% fora do limite de ` +
        `${protocolo.basis_abs_max_pct}%.`
      : !acimaDoPiso
      ? `Funding médio de ${mediaMovel.toFixed(2)}% a.a. abaixo do piso de ` +
        `${piso.toFixed(2)}% derivado do custo.`
      : `Carry projetado de ${liquidoPeriodoPct.toFixed(3)}% em ` +
        `${protocolo.holding_dias_assumido} dias não cobre a margem de ` +
        `${protocolo.margem_seguranca_pct}%.`;

    return [{
      coletado_em: collectedAt,
      simbolo: symbol,
      mark_price: markPrice,
      index_price: indexPrice,
      funding_rate: fundingRate,
      funding_rate_pct: fundingRatePct,
      funding_anualizado_pct: annualizedFundingPct,
      funding_ma_72h_pct: mediaMovel,
      horas_na_media: horasNaMedia,
      basis_pct: basisPct,
      custo_round_trip_pct: protocolo.custo_round_trip_pct,
      holding_dias_assumido: protocolo.holding_dias_assumido,
      ganho_periodo_pct: ganhoPeriodoPct,
      carry_liquido_periodo_pct: liquidoPeriodoPct,
      carry_liquido_anualizado_pct: netAnnualizedPct,
      elegivel: eligible,
      motivo: reason,
      protocolo_versao: protocolo.versao,
      raw_payload: item,
    }];
  });

  if (rows.length === 0) {
    return json({ ok: false, error: "nenhum símbolo válido retornado" }, 502);
  }

  const { error } = await supabase
    .from("funding_carry_snapshots")
    .insert(rows);
  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({
    ok: true,
    version: FUNCTION_VERSION,
    protocolo: protocolo.versao,
    collected_at: collectedAt,
    snapshots: rows.length,
    eligible: rows.filter((row) => row.elegivel).length,
    incomplete_window: rows.filter((row) => row.horas_na_media < janelaHoras)
      .length,
    parametros_do_protocolo: {
      funding_ma_horas: janelaHoras,
      piso_aplicado_pct: piso,
      piso_na_tabela_pct: pisoTabela,
      piso_derivado_do_custo_pct: pisoCalculado,
      piso_divergente: pisoDivergente,
      custo_round_trip_pct: protocolo.custo_round_trip_pct,
      holding_dias_assumido: protocolo.holding_dias_assumido,
      margem_seguranca_pct: protocolo.margem_seguranca_pct,
      basis_abs_max_pct: protocolo.basis_abs_max_pct,
    },
    aviso: pisoDivergente
      ? "O piso gravado no protocolo diverge do derivado do custo. Aplicado o " +
        "mais exigente. Recalcule funding_anualizado_min_pct = " +
        "(custo + margem) * 365 / holding_dias."
      : null,
  });
});
