'use client';

/**
 * EMBRIÃO — Dashboard de Análise de Mercado (cripto)
 * ---------------------------------------------------------------------------
 * Módulo 1: histórico de preço (performance normalizada, comparação de ativos)
 * Módulo 2: volatilidade realizada (janela móvel) + classificação de regime
 * Módulo 3: tabela comparativa de métricas por período
 * Módulo 4: relatório via IA (POST /api/relatorio — ver route.ts)
 * Futuro  : execução com stop/alvo via ordem OCO da Binance (não incluso)
 *
 * Dados: API pública da Binance, candles de 1h, client-side.
 * Uso: app/page.tsx + app/api/relatorio/route.ts. Dependência: recharts.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid, ReferenceLine,
} from 'recharts';

// ---------------------------------------------------------------------------
// Tipos e constantes
// ---------------------------------------------------------------------------

interface Candle {
  openTime: number; open: number; high: number;
  low: number; close: number; volume: number;
}

interface AssetStats {
  symbol: string;
  returnPct: number;          // retorno no período
  maxDrawdownPct: number;
  annualVolPct: number;       // volatilidade anualizada média do período
  currentVolPct: number;      // volatilidade anualizada atual (última janela)
  regime: Regime;
  bestDayPct: number;         // melhor janela de 24h
  worstDayPct: number;        // pior janela de 24h
  lastPrice: number;
}

type Regime = 'calmo' | 'normal' | 'volátil' | 'extremo';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'nenhum'];
const VOL_WINDOW = 72;              // janela móvel: 72 candles de 1h = 3 dias
const ANNUALIZE = Math.sqrt(24 * 365); // fator de anualização p/ retornos de 1h

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
  symbol: string, months: number, onProgress: (m: string) => void,
): Promise<Candle[]> {
  const end = Date.now();
  let cursor = end - months * 30 * 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  while (cursor < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&limit=1000`;
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

/** Retornos logarítmicos entre fechamentos consecutivos. */
function logReturns(candles: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    r.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  return r;
}

/** Volatilidade realizada anualizada (%) em janela móvel. Alinhada aos candles. */
function rollingVol(returns: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(returns.length + 1).fill(null);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < returns.length; i++) {
    sum += returns[i]; sumSq += returns[i] ** 2;
    if (i >= window) { sum -= returns[i - window]; sumSq -= returns[i - window] ** 2; }
    if (i >= window - 1) {
      const mean = sum / window;
      const variance = Math.max(0, sumSq / window - mean ** 2);
      out[i + 1] = Math.sqrt(variance) * ANNUALIZE * 100;
    }
  }
  return out;
}

/** Classifica o valor atual contra os quartis do próprio histórico. */
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

function computeStats(symbol: string, candles: Candle[], vol: (number | null)[]): AssetStats {
  const first = candles[0].close, last = candles[candles.length - 1].close;
  let peak = -Infinity, maxDD = 0;
  for (const c of candles) {
    peak = Math.max(peak, c.close);
    maxDD = Math.min(maxDD, (c.close - peak) / peak);
  }
  // melhor/pior janela de 24h (24 candles de 1h)
  let best = -Infinity, worst = Infinity;
  for (let i = 24; i < candles.length; i++) {
    const r = (candles[i].close / candles[i - 24].close - 1) * 100;
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
    bestDayPct: best, worstDayPct: worst,
    lastPrice: last,
  };
}

// ---------------------------------------------------------------------------
// UI auxiliares
// ---------------------------------------------------------------------------

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{
      background: S.panel, border: `1px solid ${S.border}`,
      borderRadius: 10, padding: 16, ...style,
    }}>{children}</section>
  );
}

function RegimeBadge({ regime }: { regime: Regime }) {
  return (
    <span style={{
      background: `${S.regime[regime]}22`, color: S.regime[regime],
      border: `1px solid ${S.regime[regime]}55`, borderRadius: 20,
      padding: '2px 10px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: 0.5,
    }}>{regime}</span>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AnalisePage() {
  const [symbolA, setSymbolA] = useState('BTCUSDT');
  const [symbolB, setSymbolB] = useState('ETHUSDT');
  const [months, setMonths] = useState(6);

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const [dataA, setDataA] = useState<Candle[]>([]);
  const [dataB, setDataB] = useState<Candle[]>([]);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const run = useCallback(async () => {
    setStatus('loading'); setError(''); setReport('');
    try {
      const a = await fetchKlines(symbolA, months, setProgress);
      const b = symbolB !== 'nenhum' && symbolB !== symbolA
        ? await fetchKlines(symbolB, months, setProgress) : [];
      if (a.length < VOL_WINDOW + 10) throw new Error('Histórico insuficiente para a janela de volatilidade.');
      setDataA(a); setDataB(b);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar dados.');
      setStatus('error');
    }
  }, [symbolA, symbolB, months]);

  // Derivados ---------------------------------------------------------------
  const volA = useMemo(() => dataA.length ? rollingVol(logReturns(dataA), VOL_WINDOW) : [], [dataA]);
  const volB = useMemo(() => dataB.length ? rollingVol(logReturns(dataB), VOL_WINDOW) : [], [dataB]);
  const statsA = useMemo(() => dataA.length ? computeStats(symbolA, dataA, volA) : null, [dataA, volA, symbolA]);
  const statsB = useMemo(() => dataB.length ? computeStats(symbolB, dataB, volB) : null, [dataB, volB, symbolB]);

  /** Gráficos: performance normalizada (base 100) e volatilidade, decimados. */
  const charts = useMemo(() => {
    if (!dataA.length) return { perf: [], vol: [] };
    const step = Math.max(1, Math.floor(dataA.length / 500));
    const baseA = dataA[0].close;
    const baseB = dataB.length ? dataB[0].close : 1;
    const perf: Record<string, number | string>[] = [];
    const vol: Record<string, number | string>[] = [];
    for (let i = 0; i < dataA.length; i += step) {
      const d = new Date(dataA[i].openTime);
      const label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
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
  }, [dataA, dataB, volA, volB, symbolA, symbolB]);

  // Relatório via IA ----------------------------------------------------------
  const generateReport = useCallback(async () => {
    if (!statsA) return;
    setReportLoading(true); setReport('');
    try {
      const res = await fetch('/api/relatorio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodoMeses: months, ativos: [statsA, statsB].filter(Boolean) }),
      });
      if (!res.ok) throw new Error(`API respondeu ${res.status}`);
      const json = await res.json();
      setReport(json.relatorio ?? 'Resposta vazia da API.');
    } catch (e) {
      setReport(`Erro ao gerar relatório: ${e instanceof Error ? e.message : 'desconhecido'}. Verifique a rota /api/relatorio e a variável OPENAI_API_KEY.`);
    } finally {
      setReportLoading(false);
    }
  }, [statsA, statsB, months]);

  const select = (value: string, onChange: (v: string) => void, opts: string[]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '8px 10px', fontSize: 14 }}>
      {opts.map((s) => <option key={s}>{s}</option>)}
    </select>
  );

  const statRows: { label: string; get: (s: AssetStats) => string; color?: (s: AssetStats) => string }[] = [
    { label: 'Último preço (USDT)', get: (s) => fmt(s.lastPrice) },
    { label: 'Retorno no período', get: (s) => fmtPct(s.returnPct), color: (s) => s.returnPct >= 0 ? S.green : S.red },
    { label: 'Drawdown máximo', get: (s) => fmtPct(s.maxDrawdownPct), color: () => S.red },
    { label: 'Volatilidade média (anualizada)', get: (s) => `${fmt(s.annualVolPct, 0)}%` },
    { label: 'Volatilidade atual (anualizada)', get: (s) => `${fmt(s.currentVolPct, 0)}%` },
    { label: 'Melhor janela de 24h', get: (s) => fmtPct(s.bestDayPct), color: () => S.green },
    { label: 'Pior janela de 24h', get: (s) => fmtPct(s.worstDayPct), color: () => S.red },
  ];

  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, padding: '32px 20px', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <header>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            Análise de mercado <span style={{ color: S.dim, fontWeight: 400 }}>— histórico, volatilidade e comparação</span>
          </h1>
          <p style={{ color: S.dim, fontSize: 13, marginTop: 6, maxWidth: 760 }}>
            Candles de 1h da Binance. Volatilidade realizada em janela de {VOL_WINDOW}h, anualizada;
            regime classificado contra os quartis do próprio histórico. Ferramenta de análise —
            volatilidade mede amplitude de risco, não direção futura de preço.
          </p>
        </header>

        {/* Controles */}
        <Card style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Ativo A{select(symbolA, setSymbolA, SYMBOLS.filter((s) => s !== 'nenhum'))}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Ativo B (comparação){select(symbolB, setSymbolB, SYMBOLS)}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
            Período{select(String(months), (v) => setMonths(+v), ['1', '3', '6', '12', '18'])}
          </label>
          <button onClick={run} disabled={status === 'loading'}
            style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: status === 'loading' ? 0.6 : 1 }}>
            {status === 'loading' ? progress || 'Carregando...' : 'Analisar'}
          </button>
          {status === 'error' && <span style={{ color: S.red, fontSize: 13 }}>{error}</span>}
        </Card>

        {status === 'done' && statsA && (
          <>
            {/* Regimes atuais */}
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

            {/* Performance normalizada */}
            <Card style={{ height: 340 }}>
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8 }}>Performance (base 100 no início do período)</div>
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
              <div style={{ fontSize: 12, color: S.dim, marginBottom: 8 }}>Volatilidade realizada anualizada (%) — janela de {VOL_WINDOW}h</div>
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

            {/* Tabela comparativa */}
            <Card>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr style={{ color: S.dim, textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px' }}>Métrica ({months} meses)</th>
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