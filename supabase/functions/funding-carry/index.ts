import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SYMBOLS = new Set([
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
  "DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","UNIUSDT",
]);
const ROUND_TRIP_COST_PCT = 0.60;
const HOLDING_DAYS = 30;
const MIN_ANNUALIZED_FUNDING_PCT = 15;
const MAX_ABS_BASIS_PCT = 0.75;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

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

  const collectedAt = new Date().toISOString();
  const annualizedCostPct = ROUND_TRIP_COST_PCT * (365 / HOLDING_DAYS);
  const rows = payload.flatMap((item: Record<string, unknown>) => {
    const symbol = String(item.symbol ?? "");
    if (!SYMBOLS.has(symbol)) return [];

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
    const netAnnualizedPct = annualizedFundingPct - annualizedCostPct;
    const eligible =
      annualizedFundingPct >= MIN_ANNUALIZED_FUNDING_PCT &&
      Math.abs(basisPct) <= MAX_ABS_BASIS_PCT &&
      netAnnualizedPct > 0;
    const reason = eligible
      ? "Funding positivo suficiente, basis controlado e carry líquido estimado positivo."
      : annualizedFundingPct < MIN_ANNUALIZED_FUNDING_PCT
        ? "Funding anualizado abaixo do protocolo."
        : Math.abs(basisPct) > MAX_ABS_BASIS_PCT
          ? "Basis fora do limite do protocolo."
          : "Custos estimados consomem o carry.";

    return [{
      coletado_em: collectedAt,
      simbolo: symbol,
      mark_price: markPrice,
      index_price: indexPrice,
      funding_rate: fundingRate,
      funding_rate_pct: fundingRatePct,
      funding_anualizado_pct: annualizedFundingPct,
      basis_pct: basisPct,
      custo_round_trip_pct: ROUND_TRIP_COST_PCT,
      holding_dias_assumido: HOLDING_DAYS,
      carry_liquido_anualizado_pct: netAnnualizedPct,
      elegivel: eligible,
      motivo: reason,
      raw_payload: item,
    }];
  });

  if (rows.length === 0) {
    return json({ ok: false, error: "nenhum símbolo válido retornado" }, 502);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase
    .from("funding_carry_snapshots")
    .insert(rows);
  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({
    ok: true,
    version: "funding-carry-v1.0.0",
    collected_at: collectedAt,
    snapshots: rows.length,
    eligible: rows.filter((row) => row.elegivel).length,
    fixed_assumptions: {
      round_trip_cost_pct: ROUND_TRIP_COST_PCT,
      holding_days: HOLDING_DAYS,
      min_annualized_funding_pct: MIN_ANNUALIZED_FUNDING_PCT,
      max_abs_basis_pct: MAX_ABS_BASIS_PCT,
    },
  });
});
