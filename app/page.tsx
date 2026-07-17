'use client';

/**
 * Dashboard de Análise de Mercado (cripto) — v2 com timeframes
 * ---------------------------------------------------------------------------
 * Timeframes: 1h, 4h, diário, semanal — anualização e janelas ajustadas por escala.
 * Módulos: performance normalizada, volatilidade realizada + regime,
 * comparação de ativos, relatório via IA (/api/relatorio).
 * Header básico com /public/logo.png.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid, ReferenceLine,
} from 'recharts';

// ---------------------------------------------------------------------------
// Timeframes
// ---------------------------------------------------------------------------
// periodsPerYear: quantos candles cabem em 1 ano — define a anualização da vol.
// volWindow: janela móvel da volatilidade, escolhida para fazer sentido na escala
//            (72h no 1h; ~7 dias no 4h; 30 dias no diário; 12 semanas no semanal).
// candlesPorDia: usado na métrica "melhor/pior dia"; 0 = não se aplica (semanal).
// minMonths: período mínimo para a janela ter amostra suficiente.

const TIMEFRAMES = {
  '1h': { api: '1h', label: '1 hora',  windowLabel: 'janela de 72h',        dayLabel: 'janela de 24h', periodsPerYear: 24 * 365, volWindow: 72, candlesPorDia: 24, minMonths: 1 },
  '4h': { api: '4h', label: '4 horas', windowLabel: 'janela de 7 dias',     dayLabel: 'janela de 24h', periodsPerYear: 6 * 365,  volWindow: 42, candlesPorDia: 6,  minMonths: 1 },
  '1d': { api: '1d', label: 'diário',  windowLabel: 'janela de 30 dias',    dayLabel: 'dia',           periodsPerYear: 365,      volWindow: 30, candlesPorDia: 1,  minMonths: 3 },
  '1w': { api: '1w', label: 'semanal', windowLabel: 'janela de 12 semanas', dayLabel: 'semana',        periodsPerYear: 52,       volWindow: 12, candlesPorDia: 0,  minMonths: 12 },
} as const;
type Timeframe = keyof typeof TIMEFRAMES;

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'nenhum'];
const PERIOD_OPTIONS = [1, 3, 6, 12, 18, 24, 36];

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
  maxDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
  regime: Regime;
  bestUnitPct: number;   // melhor dia (ou semana, no 1w)
  worstUnitPct: number;  // pior dia (ou semana, no 1w)
  lastPrice: number;
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

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

async function fetchKlines(
  symbol: string, interval: string, months: number, onProgress: (m: string) => void,
): Promise<Candle[]> {
  const end = Date.now();
  let cursor = end - months * 30 * 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  while (cursor < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance respondeu ${res.status} para ${symbol}`);
    const batch: (string | number)[][] = await res.json();
    if (!batch.length) break;
    for (const k of batch) {
      out.push({
        openTime: Number(k[0]),
        open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
      });
    }
    cursor = out[out.length - 1].openTime + 1;
    onProgress(`${symbol}: ${out.length} candles...`);
    if (batch.length < 1000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cálculos
// ---------------------------------------------------------------------------

function logReturns(candles: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    r.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  return r;
}

/** Volatilidade realizada anualizada (%) em janela móvel, alinhada aos candles. */
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

function computeStats(
  symbol: string, candles: Candle[], vol: (number | null)[], tf: (typeof TIMEFRAMES)[Timeframe],
): AssetStats {
  const first = candles[0].close, last = candles[candles.length - 1].close;
  let peak = -Infinity, maxDD = 0;
  for (const c of candles) {
    peak = Math.max(peak, c.close);
    maxDD = Math.min(maxDD, (c.close - peak) / peak);
  }
  // melhor/pior unidade: 1 dia (candlesPorDia candles) ou 1 candle no semanal
  const span = tf.candlesPorDia > 0 ? tf.candlesPorDia : 1;
  let best = -Infinity, worst = Infinity;
  for (let i = span; i < candles.length; i++) {
    const r = (candles[i].close / candles[i - span].close - 1) * 100;
    if (r > best) best = r;
    if (r < worst) worst = r;
  }
  const volVals = vol.filter((v): v is number => v !== null);
  return {
    symbol,
    returnPct: (last / first - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    annualVolPct: volVals.reduce((s, v) => s + v, 0) / (volVals.length || 1),
    currentVolPct: volVals[volVals.length - 1] ?? 0,
    regime: classifyRegime(vol),
    bestUnitPct: best, worstUnitPct: worst,
    lastPrice: last,
  };
}

// ---------------------------------------------------------------------------
// UI auxiliares
// ---------------------------------------------------------------------------

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16, ...style }}>
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
  const [symbolA, setSymbolA] = useState('BTCUSDT');
  const [symbolB, setSymbolB] = useState('ETHUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const [months, setMonths] = useState(6);

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  // Timeframe congelado no momento da análise (labels não trocam sem re-analisar)
  const [usedTf, setUsedTf] = useState<Timeframe>('1d');
  const [dataA, setDataA] = useState<Candle[]>([]);
  const [dataB, setDataB] = useState<Candle[]>([]);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const run = useCallback(async () => {
    const cfg = TIMEFRAMES[timeframe];
    if (months < cfg.minMonths) {
      setError(`Timeframe ${cfg.label} exige período mínimo de ${cfg.minMonths} meses para amostra suficiente.`);
      setStatus('error');
      return;
    }
    setStatus('loading'); setError(''); setReport('');
    try {
      const a = await fetchKlines(symbolA, cfg.api, months, setProgress);
      const b = symbolB !== 'nenhum' && symbolB !== symbolA
        ? await fetchKlines(symbolB, cfg.api, months, setProgress) : [];
      if (a.length < cfg.volWindow + 10) {
        throw new Error(`Candles insuficientes (${a.length}) para a janela de volatilidade neste timeframe. Aumente o período.`);
      }
      setDataA(a); setDataB(b); setUsedTf(timeframe);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar dados.');
      setStatus('error');
    }
  }, [symbolA, symbolB, timeframe, months]);

  // Derivados ----------------------------------------------------------------
  const tf = TIMEFRAMES[usedTf];
  const volA = useMemo(() => dataA.length ? rollingVol(logReturns(dataA), tf.volWindow, tf.periodsPerYear) : [], [dataA, tf]);
  const volB = useMemo(() => dataB.length ? rollingVol(logReturns(dataB), tf.volWindow, tf.periodsPerYear) : [], [dataB, tf]);
  const statsA = useMemo(() => dataA.length ? computeStats(symbolA, dataA, volA, tf) : null, [dataA, volA, symbolA, tf]);
  const statsB = useMemo(() => dataB.length ? computeStats(symbolB, dataB, volB, tf) : null, [dataB, volB, symbolB, tf]);

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
      const pPoint: Record<string, number | string> = {
        label, [symbolA]: +((dataA[i].close / baseA) * 100).toFixed(2),
      };
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

  // Relatório via IA -----------------------------------------------------------
  const generateReport = useCallback(async () => {
    if (!statsA) return;
    setReportLoading(true); setReport('');
    try {
      const res = await fetch('/api/relatorio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodoMeses: months,
          timeframeLabel: tf.label,
          unidadeExtremos: tf.dayLabel,
          ativos: [statsA, statsB].filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error(`API respondeu ${res.status}`);
      const json = await res.json();
      setReport(json.relatorio ?? 'Resposta vazia da API.');
    } catch (e) {
      setReport(`Erro ao gerar relatório: ${e instanceof Error ? e.message : 'desconhecido'}. Verifique /api/relatorio e a OPENAI_API_KEY.`);
    } finally {
      setReportLoading(false);
    }
  }, [statsA, statsB, months, tf]);

  const select = (value: string, onChange: (v: string) => void, opts: { value: string; label: string }[]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '8px 10px', fontSize: 14 }}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  const statRows: { label: string; get: (s: AssetStats) => string; color?: (s: AssetStats) => string }[] = [
    { label: 'Último preço (USDT)', get: (s) => fmt(s.lastPrice) },
    { label: 'Retorno no período', get: (s) => fmtPct(s.returnPct), color: (s) => s.returnPct >= 0 ? S.green : S.red },
    { label: 'Drawdown máximo', get: (s) => fmtPct(s.maxDrawdownPct), color: () => S.red },
    { label: 'Volatilidade média (anualizada)', get: (s) => `${fmt(s.annualVolPct, 0)}%` },
    { label: 'Volatilidade atual (anualizada)', get: (s) => `${fmt(s.currentVolPct, 0)}%` },
    { label: `Melhor ${tf.dayLabel}`, get: (s) => fmtPct(s.bestUnitPct), color: () => S.green },
    { label: `Pior ${tf.dayLabel}`, get: (s) => fmtPct(s.worstUnitPct), color: () => S.red },
  ];

  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>

      {/* Header */}
      <header style={{
        borderBottom: `1px solid ${S.border}`, background: S.panel,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Logo" style={{ height: 32, width: 'auto', display: 'block' }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>Análise de mercado</div>
          <div style={{ fontSize: 11, color: S.dim }}>histórico · volatilidade · comparação</div>
        </div>
      </header>

      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <p style={{ color: S.dim, fontSize: 13, margin: 0, maxWidth: 780 }}>
          Dados da Binance. Volatilidade realizada em {tf.windowLabel}, anualizada; regime
          classificado contra os quartis do próprio histórico. Ferramenta de análise —
          volatilidade mede amplitude de risco, não direção futura de preço.
        </p>

        {/* Controles */}
        <Card style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Ativo A{select(symbolA, setSymbolA, SYMBOLS.filter((s) => s !== 'nenhum').map((s) => ({ value: s, label: s })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Ativo B (comparação){select(symbolB, setSymbolB, SYMBOLS.map((s) => ({ value: s, label: s })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Timeframe{select(timeframe, (v) => setTimeframe(v as Timeframe),
              (Object.keys(TIMEFRAMES) as Timeframe[]).map((k) => ({ value: k, label: TIMEFRAMES[k].label })))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Período (meses){select(String(months), (v) => setMonths(+v), PERIOD_OPTIONS.map((m) => ({ value: String(m), label: String(m) })))}
          </label>
          <button onClick={run} disabled={status === 'loading'}
            style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: status === 'loading' ? 0.6 : 1 }}>
            {status === 'loading' ? progress || 'Carregando...' : 'Analisar'}
          </button>
          {status === 'error' && <span style={{ color: S.red, fontSize: 13, flexBasis: '100%' }}>{error}</span>}
        </Card>

        {status === 'done' && statsA && (
          <>
            {/* Regimes */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[statsA, statsB].filter((s): s is AssetStats => !!s).map((s) => (
                <Card key={s.symbol} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
                  <strong style={{ fontSize: 15 }}>{s.symbol}</strong>
                  <RegimeBadge regime={s.regime} />
                  <span style={{ color: S.dim, fontSize: 13 }}>
                    vol. atual {fmt(s.currentVolPct, 0)}% a.a. · média do período {fmt(s.annualVolPct, 0)}%
                  </span>
                </Card>
              ))}
            </div>

            {/* Performance */}
            <Card style={{ height: 340 }}>
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8 }}>
                Performance (base 100 no início) — candles {tf.label}
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
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8 }}>
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
                  <tr style={{ color: S.dim, textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Métrica ({months} {months === 1 ? 'mês' : 'meses'} · {tf.label})</th>
                    <th style={{ padding: '6px 8px', color: S.a }}>{statsA.symbol}</th>
                    {statsB && <th style={{ padding: '6px 8px', color: S.b }}>{statsB.symbol}</th>}
                  </tr>
                </thead>
                <tbody>
                  {statRows.map((row) => (
                    <tr key={row.label} style={{ borderTop: `1px solid ${S.border}`, textAlign: 'right' }}>
                      <td style={{ textAlign: 'left', padding: '8px', color: S.dim }}>{row.label}</td>
                      <td style={{ padding: '8px', color: row.color?.(statsA) }}>{row.get(statsA)}</td>
                      {statsB && <td style={{ padding: '8px', color: row.color?.(statsB) }}>{row.get(statsB)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {/* Relatório IA */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
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
                <div style={{ marginTop: 14, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', borderTop: `1px solid ${S.border}`, paddingTop: 14 }}>
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
