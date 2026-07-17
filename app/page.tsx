'use client';

/**
 * Dashboard de Análise de Mercado — VigIA Trade v4
 * ---------------------------------------------------------------------------
 * Novidades da v4:
 * - Navegação para /alertas e /conta no header.
 * - Logado: cards de status (alertas ativos, chave Binance, últimas ordens)
 *   e histórico das últimas análises (persistido — sobrevive ao refresh).
 * - Cada análise rodada é salva em `analyses`; o relatório IA é anexado à
 *   análise quando gerado. "Reabrir" re-executa com os mesmos parâmetros
 *   sobre dados atuais.
 * - Deslogado: dashboard funciona normalmente, sem persistência.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid, ReferenceLine,
} from 'recharts';
import { getSupabase } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Timeframes e períodos (inalterado da v3)
// ---------------------------------------------------------------------------

interface PeriodOption { label: string; days: number }

const TIMEFRAMES = {
  '1h': {
    api: '1h', label: '1 hora', windowLabel: 'janela de 72h', unitLabel: 'janela de 24h',
    periodsPerYear: 24 * 365, volWindow: 72, candlesPorDia: 24,
    periods: [
      { label: '7 dias', days: 7 }, { label: '14 dias', days: 14 },
      { label: '30 dias', days: 30 }, { label: '60 dias', days: 60 }, { label: '90 dias', days: 90 },
    ] as PeriodOption[],
  },
  '4h': {
    api: '4h', label: '4 horas', windowLabel: 'janela de 7 dias', unitLabel: 'janela de 24h',
    periodsPerYear: 6 * 365, volWindow: 42, candlesPorDia: 6,
    periods: [
      { label: '14 dias', days: 14 }, { label: '30 dias', days: 30 },
      { label: '90 dias', days: 90 }, { label: '180 dias', days: 180 }, { label: '12 meses', days: 365 },
    ] as PeriodOption[],
  },
  '1d': {
    api: '1d', label: 'diário', windowLabel: 'janela de 30 dias', unitLabel: 'dia',
    periodsPerYear: 365, volWindow: 30, candlesPorDia: 1,
    periods: [
      { label: '3 meses', days: 90 }, { label: '6 meses', days: 180 },
      { label: '12 meses', days: 365 }, { label: '24 meses', days: 730 }, { label: '36 meses', days: 1095 },
    ] as PeriodOption[],
  },
  '1w': {
    api: '1w', label: 'semanal', windowLabel: 'janela de 12 semanas', unitLabel: 'semana',
    periodsPerYear: 52, volWindow: 12, candlesPorDia: 0,
    periods: [
      { label: '12 meses', days: 365 }, { label: '24 meses', days: 730 },
      { label: '36 meses', days: 1095 }, { label: '60 meses', days: 1825 },
    ] as PeriodOption[],
  },
} as const;
type Timeframe = keyof typeof TIMEFRAMES;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'nenhum'];
const MIN_CANDLES = 60;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Candle {
  openTime: number; open: number; high: number;
  low: number; close: number; volume: number;
}

type Regime = 'calmo' | 'normal' | 'volátil' | 'extremo';

interface AssetStats {
  symbol: string;
  returnPct: number;
  annualReturnPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  timeInDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
  sharpe: number;
  pctPositive: number;
  regime: Regime;
  bestUnitPct: number;
  worstUnitPct: number;
  lastPrice: number;
}

interface AnalysisRow {
  id: string;
  symbol_a: string; symbol_b: string | null;
  timeframe: Timeframe; period_label: string;
  retorno_a: number | null; retorno_b: number | null; correlacao: number | null;
  criado_em: string;
}

interface OrderRow {
  id: string; symbol: string; status: string; is_testnet: boolean;
  entry_price: number | null; exit_price: number | null; pnl_usdt: number | null;
  criado_em: string;
}

// ---------------------------------------------------------------------------
// Estilo
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', b: '#4f8fd0',
  green: '#3fb26f', red: '#d05555',
  regime: { calmo: '#4f8fd0', normal: '#3fb26f', 'volátil': '#e8a13c', extremo: '#d05555' } as Record<Regime, string>,
};

const fmt = (n: number, d = 2) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n)}%`;
const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pendente: { label: 'pendente', color: '#7d8a97' },
  entrada_executada: { label: 'entrada feita', color: '#e8a13c' },
  oco_ativa: { label: 'OCO ativa', color: '#4f8fd0' },
  alvo_executado: { label: 'alvo ✅', color: '#3fb26f' },
  stop_executado: { label: 'stop 🛑', color: '#d05555' },
  cancelada: { label: 'cancelada', color: '#7d8a97' },
  erro: { label: 'erro', color: '#d05555' },
};

// ---------------------------------------------------------------------------
// Dados / cálculos (inalterados da v3)
// ---------------------------------------------------------------------------

async function fetchKlines(
  symbol: string, interval: string, days: number, onProgress: (m: string) => void,
): Promise<Candle[]> {
  const end = Date.now();
  let cursor = end - days * 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  while (cursor < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance respondeu ${res.status} para ${symbol}`);
    const batch: (string | number)[][] = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      out.push({ openTime: Number(k[0]), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    cursor = out[out.length - 1].openTime + 1;
    onProgress(`${symbol}: ${out.length} candles...`);
    if (batch.length < 1000) break;
  }
  return out;
}

function logReturns(candles: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i].close / candles[i - 1].close));
  return r;
}

function rollingVol(returns: number[], window: number, periodsPerYear: number): (number | null)[] {
  const annualize = Math.sqrt(periodsPerYear);
  const out: (number | null)[] = new Array(returns.length + 1).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < returns.length; i++) {
    sum += returns[i]; sumSq += returns[i] ** 2;
    if (i >= window) { sum -= returns[i - window]; sumSq -= returns[i - window] ** 2; }
    if (i >= window - 1) {
      const mean = sum / window;
      const variance = Math.max(0, sumSq / window - mean ** 2);
      out[i + 1] = Math.sqrt(variance) * annualize * 100;
    }
  }
  return out;
}

function classifyRegime(volSeries: (number | null)[]): Regime {
  const vals = volSeries.filter((v): v is number => v !== null).sort((x, y) => x - y);
  const current = volSeries[volSeries.length - 1];
  if (current === null || vals.length < 4) return 'normal';
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  if (current <= q(0.25)) return 'calmo';
  if (current <= q(0.75)) return 'normal';
  if (current <= q(0.95)) return 'volátil';
  return 'extremo';
}

function correlation(a: Candle[], b: Candle[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const mapB = new Map<number, number>();
  for (let i = 1; i < b.length; i++) mapB.set(b[i].openTime, Math.log(b[i].close / b[i - 1].close));
  const xs: number[] = [], ys: number[] = [];
  for (let i = 1; i < a.length; i++) {
    const rb = mapB.get(a[i].openTime);
    if (rb !== undefined) { xs.push(Math.log(a[i].close / a[i - 1].close)); ys.push(rb); }
  }
  const n = xs.length;
  if (n < 30) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2;
  }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : null;
}

function correlationLabel(r: number): string {
  const abs = Math.abs(r);
  if (abs >= 0.7) return r > 0 ? 'alta' : 'alta inversa';
  if (abs >= 0.4) return r > 0 ? 'moderada' : 'moderada inversa';
  return 'baixa';
}

function computeStats(
  symbol: string, candles: Candle[], vol: (number | null)[], tf: (typeof TIMEFRAMES)[Timeframe],
): AssetStats {
  const first = candles[0].close, last = candles[candles.length - 1].close;
  const n = candles.length;
  let peak = -Infinity, maxDD = 0, belowPeak = 0;
  for (const c of candles) {
    peak = Math.max(peak, c.close);
    const dd = (c.close - peak) / peak;
    maxDD = Math.min(maxDD, dd);
    if (dd < 0) belowPeak++;
  }
  const currentDD = (last - peak) / peak;
  const span = tf.candlesPorDia > 0 ? tf.candlesPorDia : 1;
  let best = -Infinity, worst = Infinity;
  for (let i = span; i < n; i++) {
    const r = (candles[i].close / candles[i - span].close - 1) * 100;
    if (r > best) best = r;
    if (r < worst) worst = r;
  }
  const returns = logReturns(candles);
  const positives = returns.filter((r) => r > 0).length;
  const volVals = vol.filter((v): v is number => v !== null);
  const annualVol = volVals.reduce((s, v) => s + v, 0) / (volVals.length || 1);
  const annualReturn = (Math.pow(last / first, tf.periodsPerYear / Math.max(1, n - 1)) - 1) * 100;
  return {
    symbol,
    returnPct: (last / first - 1) * 100,
    annualReturnPct: annualReturn,
    maxDrawdownPct: maxDD * 100,
    currentDrawdownPct: currentDD * 100,
    timeInDrawdownPct: (belowPeak / n) * 100,
    annualVolPct: annualVol,
    currentVolPct: volVals[volVals.length - 1] ?? 0,
    sharpe: annualVol > 0 ? annualReturn / annualVol : 0,
    pctPositive: returns.length ? (positives / returns.length) * 100 : 0,
    regime: classifyRegime(vol),
    bestUnitPct: best, worstUnitPct: worst,
    lastPrice: last,
  };
}

// ---------------------------------------------------------------------------
// UI auxiliares
// ---------------------------------------------------------------------------

function Card({ children, style, title }: { children: React.ReactNode; style?: React.CSSProperties; title?: string }) {
  return (
    <section title={title} style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16, ...style }}>
      {children}
    </section>
  );
}

function RegimeBadge({ regime }: { regime: Regime }) {
  return (
    <span style={{
      background: `${S.regime[regime]}22`, color: S.regime[regime],
      border: `1px solid ${S.regime[regime]}55`, borderRadius: 20,
      padding: '2px 10px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
    }}>{regime}</span>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AnalisePage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);

  const [symbolA, setSymbolA] = useState('BTCUSDT');
  const [symbolB, setSymbolB] = useState('ETHUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const [periodIdx, setPeriodIdx] = useState(1);

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const [usedTf, setUsedTf] = useState<Timeframe>('1d');
  const [usedPeriodLabel, setUsedPeriodLabel] = useState('6 meses');
  const [dataA, setDataA] = useState<Candle[]>([]);
  const [dataB, setDataB] = useState<Candle[]>([]);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  // Status/histórico (logado)
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [keyInfo, setKeyInfo] = useState<{ is_testnet: boolean } | null | undefined>(undefined); // undefined = não carregado
  const [lastOrders, setLastOrders] = useState<OrderRow[]>([]);
  const [lastAnalyses, setLastAnalyses] = useState<AnalysisRow[]>([]);
  const [currentAnalysisId, setCurrentAnalysisId] = useState<string | null>(null);

  // Sessão --------------------------------------------------------------------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  const loadStatus = useCallback(async () => {
    const [alerts, keys, orders, analyses] = await Promise.all([
      supabase.from('alert_rules').select('id', { count: 'exact', head: true }).eq('ativo', true),
      supabase.from('exchange_keys').select('is_testnet').maybeSingle(),
      supabase.from('orders')
        .select('id, symbol, status, is_testnet, entry_price, exit_price, pnl_usdt, criado_em')
        .order('criado_em', { ascending: false }).limit(3),
      supabase.from('analyses')
        .select('id, symbol_a, symbol_b, timeframe, period_label, retorno_a, retorno_b, correlacao, criado_em')
        .order('criado_em', { ascending: false }).limit(5),
    ]);
    setAlertCount(alerts.count ?? 0);
    setKeyInfo((keys.data as { is_testnet: boolean } | null) ?? null);
    setLastOrders((orders.data as OrderRow[]) ?? []);
    setLastAnalyses((analyses.data as AnalysisRow[]) ?? []);
  }, [supabase]);

  useEffect(() => { if (session) loadStatus(); }, [session, loadStatus]);

  const onTimeframeChange = (v: string) => {
    const next = v as Timeframe;
    setTimeframe(next);
    setPeriodIdx(Math.min(1, TIMEFRAMES[next].periods.length - 1));
  };

  // Análise (aceita overrides para o "reabrir" do histórico) -------------------
  const run = useCallback(async (ov?: { symbolA: string; symbolB: string; timeframe: Timeframe; periodLabel: string }) => {
    const useTf = ov?.timeframe ?? timeframe;
    const cfg = TIMEFRAMES[useTf];
    const period = ov
      ? cfg.periods.find((p) => p.label === ov.periodLabel) ?? cfg.periods[1]
      : cfg.periods[Math.min(periodIdx, cfg.periods.length - 1)];
    const useA = ov?.symbolA ?? symbolA;
    const useB = ov?.symbolB ?? symbolB;

    if (ov) {
      setSymbolA(useA); setSymbolB(useB); setTimeframe(useTf);
      setPeriodIdx(Math.max(0, cfg.periods.findIndex((p) => p.label === period.label)));
    }

    setStatus('loading'); setError(''); setReport(''); setCurrentAnalysisId(null);
    try {
      const a = await fetchKlines(useA, cfg.api, period.days, setProgress);
      const b = useB !== 'nenhum' && useB !== useA ? await fetchKlines(useB, cfg.api, period.days, setProgress) : [];
      const minimo = Math.max(MIN_CANDLES, cfg.volWindow + 10);
      if (a.length < minimo) {
        throw new Error(`Amostra insuficiente (${a.length} candles; mínimo ${minimo}). Aumente o período.`);
      }
      setDataA(a); setDataB(b);
      setUsedTf(useTf); setUsedPeriodLabel(period.label);
      setStatus('done');

      // Persistência (logado): salva parâmetros + resumo
      if (session) {
        const tfc = TIMEFRAMES[useTf];
        const volSa = rollingVol(logReturns(a), tfc.volWindow, tfc.periodsPerYear);
        const sa = computeStats(useA, a, volSa, tfc);
        let sb: AssetStats | null = null;
        let corrVal: number | null = null;
        if (b.length) {
          const volSb = rollingVol(logReturns(b), tfc.volWindow, tfc.periodsPerYear);
          sb = computeStats(useB, b, volSb, tfc);
          corrVal = correlation(a, b);
        }
        const { data: row } = await supabase.from('analyses').insert({
          symbol_a: useA,
          symbol_b: b.length ? useB : null,
          timeframe: useTf,
          period_label: period.label,
          retorno_a: sa.returnPct,
          retorno_b: sb?.returnPct ?? null,
          correlacao: corrVal,
          stats: { a: sa, b: sb },
          user_id: session.user.id,
        }).select('id').single();
        if (row) setCurrentAnalysisId(row.id as string);
        loadStatus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar dados.');
      setStatus('error');
    }
  }, [symbolA, symbolB, timeframe, periodIdx, session, supabase, loadStatus]);

  // Derivados ------------------------------------------------------------------
  const tf = TIMEFRAMES[usedTf];
  const volA = useMemo(() => dataA.length ? rollingVol(logReturns(dataA), tf.volWindow, tf.periodsPerYear) : [], [dataA, tf]);
  const volB = useMemo(() => dataB.length ? rollingVol(logReturns(dataB), tf.volWindow, tf.periodsPerYear) : [], [dataB, tf]);
  const statsA = useMemo(() => dataA.length ? computeStats(symbolA, dataA, volA, tf) : null, [dataA, volA, symbolA, tf]);
  const statsB = useMemo(() => dataB.length ? computeStats(symbolB, dataB, volB, tf) : null, [dataB, volB, symbolB, tf]);
  const corr = useMemo(() => (dataA.length && dataB.length) ? correlation(dataA, dataB) : null, [dataA, dataB]);

  const charts = useMemo(() => {
    if (!dataA.length) return { perf: [], vol: [] };
    const step = Math.max(1, Math.floor(dataA.length / 500));
    const baseA = dataA[0].close;
    const baseB = dataB.length ? dataB[0].close : 1;
    const perf: Record<string, number | string>[] = [];
    const vol: Record<string, number | string>[] = [];
    const longRange = usedTf === '1d' || usedTf === '1w';
    for (let i = 0; i < dataA.length; i += step) {
      const d = new Date(dataA[i].openTime);
      const label = longRange
        ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
        : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const pPoint: Record<string, number | string> = { label, [symbolA]: +((dataA[i].close / baseA) * 100).toFixed(2) };
      const vPoint: Record<string, number | string> = { label };
      if (volA[i] !== null && volA[i] !== undefined) vPoint[symbolA] = +(volA[i] as number).toFixed(1);
      if (dataB[i]) {
        pPoint[symbolB] = +((dataB[i].close / baseB) * 100).toFixed(2);
        if (volB[i] !== null && volB[i] !== undefined) vPoint[symbolB] = +(volB[i] as number).toFixed(1);
      }
      perf.push(pPoint); vol.push(vPoint);
    }
    return { perf, vol };
  }, [dataA, dataB, volA, volB, symbolA, symbolB, usedTf]);

  // Relatório -------------------------------------------------------------------
  const generateReport = useCallback(async () => {
    if (!statsA) return;
    setReportLoading(true); setReport('');
    try {
      const res = await fetch('/api/relatorio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodoLabel: usedPeriodLabel,
          timeframeLabel: tf.label,
          unidadeExtremos: tf.unitLabel,
          correlacao: corr,
          ativos: [statsA, statsB].filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error(`API respondeu ${res.status}`);
      const json = await res.json();
      const texto = json.relatorio ?? 'Resposta vazia da API.';
      setReport(texto);
      // Anexa o relatório à análise salva
      if (session && currentAnalysisId) {
        await supabase.from('analyses').update({ report: texto }).eq('id', currentAnalysisId);
      }
    } catch (e) {
      setReport(`Erro ao gerar relatório: ${e instanceof Error ? e.message : 'desconhecido'}.`);
    } finally {
      setReportLoading(false);
    }
  }, [statsA, statsB, usedPeriodLabel, tf, corr, session, currentAnalysisId, supabase]);

  const select = (value: string, onChange: (v: string) => void, opts: { value: string; label: string }[]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '8px 10px', fontSize: 14, textAlign: 'center' }}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  const currentPeriods = TIMEFRAMES[timeframe].periods;

  const statRows: { label: string; tip: string; get: (s: AssetStats) => string; color?: (s: AssetStats) => string }[] = [
    { label: 'Último preço (USDT)', tip: 'Preço de fechamento do candle mais recente.', get: (s) => fmt(s.lastPrice) },
    { label: 'Retorno no período', tip: 'Variação do preço do início ao fim do período analisado.', get: (s) => fmtPct(s.returnPct), color: (s) => s.returnPct >= 0 ? S.green : S.red },
    { label: 'Drawdown máximo', tip: 'Maior queda registrada de um topo até o fundo seguinte dentro do período.', get: (s) => fmtPct(s.maxDrawdownPct), color: () => S.red },
    { label: 'Drawdown atual', tip: 'Quanto o preço está abaixo do maior topo do período neste momento.', get: (s) => fmtPct(s.currentDrawdownPct), color: (s) => s.currentDrawdownPct < -0.5 ? S.red : S.dim },
    { label: 'Tempo em drawdown', tip: 'Fração do período em que o preço esteve abaixo do topo anterior.', get: (s) => `${fmt(s.timeInDrawdownPct, 0)}%` },
    { label: 'Volatilidade média (anualizada)', tip: 'O quanto o preço costuma oscilar, projetado em escala anual. Mede risco, não direção.', get: (s) => `${fmt(s.annualVolPct, 0)}%` },
    { label: 'Volatilidade atual (anualizada)', tip: 'Oscilação recente do preço, projetada em escala anual.', get: (s) => `${fmt(s.currentVolPct, 0)}%` },
    { label: 'Retorno/risco (Sharpe simpl.)', tip: 'Retorno anualizado dividido pela volatilidade anualizada. Maior = mais retorno por unidade de risco.', get: (s) => fmt(s.sharpe), color: (s) => s.sharpe >= 0 ? S.green : S.red },
    { label: 'Períodos positivos', tip: 'Percentual de candles que fecharam em alta em relação ao anterior.', get: (s) => `${fmt(s.pctPositive, 0)}%` },
    { label: `Melhor ${tf.unitLabel}`, tip: 'Maior alta registrada nessa unidade de tempo dentro do período.', get: (s) => fmtPct(s.bestUnitPct), color: () => S.green },
    { label: `Pior ${tf.unitLabel}`, tip: 'Maior queda registrada nessa unidade de tempo dentro do período.', get: (s) => fmtPct(s.worstUnitPct), color: () => S.red },
  ];

  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>

      {/* Header + navegação */}
      <header style={{ borderBottom: `1px solid ${S.border}`, background: S.panel, padding: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="VigIA Trade" style={{ height: 32, width: 'auto', display: 'block' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>Análise de mercado</div>
            <div style={{ fontSize: 11, color: S.dim }}>monitoramento · risco definido · decisão sua</div>
          </div>
        </div>
        <nav style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 8, fontSize: 13 }}>
          <span style={{ color: S.a, fontWeight: 600 }}>Análise</span>
          <a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>Alertas</a>
          <a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>Conta Binance</a>
          {!session && <a href="/alertas" style={{ color: S.green, textDecoration: 'none' }}>Entrar</a>}
        </nav>
      </header>

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Cards de status (logado) */}
        {session && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
            <a href="/alertas" style={{ textDecoration: 'none', color: S.text }}>
              <Card style={{ padding: '10px 16px', textAlign: 'center', minWidth: 140, cursor: 'pointer' }}>
                <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase', letterSpacing: 0.6 }}>Alertas ativos</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: S.a }}>{alertCount ?? '—'}</div>
              </Card>
            </a>
            <a href="/conta" style={{ textDecoration: 'none', color: S.text }}>
              <Card style={{ padding: '10px 16px', textAlign: 'center', minWidth: 140, cursor: 'pointer' }}>
                <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase', letterSpacing: 0.6 }}>Binance</div>
                <div style={{
                  fontSize: 14, fontWeight: 700, marginTop: 4,
                  color: keyInfo === null ? S.dim : keyInfo?.is_testnet ? S.green : S.red,
                }}>
                  {keyInfo === undefined ? '—' : keyInfo === null ? 'não conectada' : keyInfo.is_testnet ? 'TESTNET' : 'CONTA REAL'}
                </div>
              </Card>
            </a>
            <a href="/conta" style={{ textDecoration: 'none', color: S.text }}>
              <Card style={{ padding: '10px 16px', textAlign: 'center', minWidth: 200, cursor: 'pointer' }}>
                <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase', letterSpacing: 0.6 }}>Últimas ordens</div>
                {lastOrders.length === 0 ? (
                  <div style={{ fontSize: 13, color: S.dim, marginTop: 4 }}>nenhuma</div>
                ) : lastOrders.map((o) => (
                  <div key={o.id} style={{ fontSize: 12, marginTop: 4 }}>
                    {o.symbol} · <span style={{ color: STATUS_LABEL[o.status]?.color ?? S.dim }}>{STATUS_LABEL[o.status]?.label ?? o.status}</span>
                    {o.pnl_usdt !== null && (
                      <span style={{ color: o.pnl_usdt >= 0 ? S.green : S.red }}> · {o.pnl_usdt >= 0 ? '+' : ''}{fmt(o.pnl_usdt)} USDT</span>
                    )}
                  </div>
                ))}
              </Card>
            </a>
          </div>
        )}

        <p style={{ color: S.dim, fontSize: 13, margin: '0 auto', maxWidth: 780, textAlign: 'center' }}>
          Dados da Binance. Volatilidade realizada em {tf.windowLabel}, anualizada; regime
          classificado contra os quartis do próprio histórico. Ferramenta de análise —
          volatilidade mede amplitude de risco, não direção futura de preço.
        </p>

        {/* Controles */}
        <Card style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', justifyContent: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Ativo A{select(symbolA, setSymbolA, SYMBOLS.filter((s) => s !== 'nenhum').map((s) => ({ value: s, label: s })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Ativo B (comparação){select(symbolB, setSymbolB, SYMBOLS.map((s) => ({ value: s, label: s })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Timeframe{select(timeframe, onTimeframeChange,
              (Object.keys(TIMEFRAMES) as Timeframe[]).map((k) => ({ value: k, label: TIMEFRAMES[k].label })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Período{select(String(Math.min(periodIdx, currentPeriods.length - 1)), (v) => setPeriodIdx(+v),
              currentPeriods.map((p, i) => ({ value: String(i), label: p.label })))}
          </label>
          <button onClick={() => run()} disabled={status === 'loading'}
            style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: status === 'loading' ? 0.6 : 1 }}>
            {status === 'loading' ? progress || 'Carregando...' : 'Analisar'}
          </button>
          {status === 'error' && <span style={{ color: S.red, fontSize: 13, flexBasis: '100%', textAlign: 'center' }}>{error}</span>}
        </Card>

        {/* Histórico de análises (logado) */}
        {session && lastAnalyses.length > 0 && (
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'center', marginBottom: 8 }}>Últimas análises</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {lastAnalyses.map((an) => (
                <button key={an.id}
                  onClick={() => run({
                    symbolA: an.symbol_a,
                    symbolB: an.symbol_b ?? 'nenhum',
                    timeframe: an.timeframe,
                    periodLabel: an.period_label,
                  })}
                  style={{
                    background: 'transparent', border: `1px solid ${S.border}`, borderRadius: 8,
                    padding: '8px 12px', color: S.text, fontSize: 12, cursor: 'pointer', textAlign: 'center',
                  }}>
                  {an.symbol_a}{an.symbol_b ? ` × ${an.symbol_b}` : ''} · {TIMEFRAMES[an.timeframe]?.label ?? an.timeframe} · {an.period_label}
                  {an.retorno_a !== null && (
                    <span style={{ color: an.retorno_a >= 0 ? S.green : S.red }}> · {fmtPct(an.retorno_a)}</span>
                  )}
                  {an.correlacao !== null && <span style={{ color: S.dim }}> · corr {fmt(an.correlacao)}</span>}
                  <span style={{ color: S.dim }}> · {fmtData(an.criado_em)}</span>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', marginTop: 8 }}>
              Tocar reabre a análise com os mesmos parâmetros sobre dados atuais.
            </div>
          </Card>
        )}

        {status === 'done' && statsA && (
          <>
            {/* Regimes + correlação */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              {[statsA, statsB].filter((s): s is AssetStats => !!s).map((s) => (
                <Card key={s.symbol} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 16px' }}>
                  <strong style={{ fontSize: 15 }}>{s.symbol}</strong>
                  <RegimeBadge regime={s.regime} />
                  <span style={{ color: S.dim, fontSize: 13 }}>
                    vol. atual {fmt(s.currentVolPct, 0)}% a.a. · média {fmt(s.annualVolPct, 0)}%
                  </span>
                </Card>
              ))}
              {corr !== null && statsB && (
                <Card
                  title="Correlação de Pearson entre os retornos dos dois ativos. Perto de 1 = movem juntos (diversificar entre eles adianta pouco); perto de 0 = independentes; negativa = movem em direções opostas."
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '12px 16px', cursor: 'help' }}
                >
                  <strong style={{ fontSize: 14 }}>Correlação {statsA.symbol} × {statsB.symbol}</strong>
                  <span style={{ fontSize: 15, fontWeight: 700, color: Math.abs(corr) >= 0.7 ? S.a : S.text }}>{fmt(corr)}</span>
                  <span style={{ color: S.dim, fontSize: 13 }}>({correlationLabel(corr)})</span>
                </Card>
              )}
            </div>

            {/* Performance */}
            <Card style={{ height: 340 }}>
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8, textAlign: 'center' }}>
                Performance (base 100 no início) — candles {tf.label} · {usedPeriodLabel}
              </div>
              <ResponsiveContainer width="100%" height="90%">
                <LineChart data={charts.perf}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} fontSize={11} minTickGap={40} />
                  <YAxis stroke={S.dim} fontSize={11} domain={['auto', 'auto']} width={60} />
                  <Tooltip contentStyle={{ background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: S.dim }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={100} stroke={S.dim} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey={symbolA} stroke={S.a} dot={false} strokeWidth={2} />
                  {statsB && <Line type="monotone" dataKey={symbolB} stroke={S.b} dot={false} strokeWidth={2} />}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Volatilidade */}
            <Card style={{ height: 300 }}>
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8, textAlign: 'center' }}>
                Volatilidade realizada anualizada (%) — {tf.windowLabel}
              </div>
              <ResponsiveContainer width="100%" height="88%">
                <LineChart data={charts.vol}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} fontSize={11} minTickGap={40} />
                  <YAxis stroke={S.dim} fontSize={11} width={50} />
                  <Tooltip contentStyle={{ background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: S.dim }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey={symbolA} stroke={S.a} dot={false} strokeWidth={2} connectNulls />
                  {statsB && <Line type="monotone" dataKey={symbolB} stroke={S.b} dot={false} strokeWidth={2} connectNulls />}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Tabela */}
            <Card>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr style={{ color: S.dim, textAlign: 'center' }}>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>Métrica ({usedPeriodLabel} · {tf.label})</th>
                    <th style={{ padding: '6px 8px', color: S.a, textAlign: 'center' }}>{statsA.symbol}</th>
                    {statsB && <th style={{ padding: '6px 8px', color: S.b, textAlign: 'center' }}>{statsB.symbol}</th>}
                  </tr>
                </thead>
                <tbody>
                  {statRows.map((row) => (
                    <tr key={row.label} style={{ borderTop: `1px solid ${S.border}`, textAlign: 'center' }}>
                      <td title={row.tip} style={{ padding: '8px', color: S.dim, cursor: 'help', textAlign: 'center' }}>{row.label}</td>
                      <td style={{ padding: '8px', color: row.color?.(statsA) }}>{row.get(statsA)}</td>
                      {statsB && <td style={{ padding: '8px', color: row.color?.(statsB) }}>{row.get(statsB)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {/* Relatório IA */}
            <Card>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>Relatório analítico</div>
                  <div style={{ fontSize: 12, color: S.dim }}>Gerado por IA a partir das métricas acima. Descritivo, não recomendação.</div>
                </div>
                <button onClick={generateReport} disabled={reportLoading}
                  style={{ background: 'transparent', color: S.a, border: `1px solid ${S.a}`, borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: reportLoading ? 0.6 : 1 }}>
                  {reportLoading ? 'Gerando...' : 'Gerar relatório'}
                </button>
              </div>
              {report && (
                <div style={{ marginTop: 14, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', borderTop: `1px solid ${S.border}`, paddingTop: 14, textAlign: 'left' }}>
                  {report}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
