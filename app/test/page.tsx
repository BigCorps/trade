'use client';

/**
 * app/test/page.tsx — VigIA Trade (ferramenta interna de backtest)
 * ----------------------------------------------------------------------------
 * Executa a edge function backtest-daytrade autenticada e apresenta o resultado
 * em dois formatos copiáveis: resumo em Markdown e JSON completo.
 * Acesso só por URL, exige login (usa a sessão do navegador atual).
 * Não é linkada na navegação; é uma bancada de teste pessoal.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabaseClient';

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', green: '#3fb26f', red: '#d05555',
};

const inputStyle: React.CSSProperties = {
  background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6,
  color: S.text, padding: '8px 10px', fontSize: 14, textAlign: 'center',
};

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const TIMEFRAMES = ['5m', '15m', '30m', '1h'];

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16, ...style }}>
      {children}
    </section>
  );
}

const fmt = (n: unknown, d = 2) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—';

// Constrói o resumo Markdown a partir do result.metrics + contexto
function buildMarkdown(payload: Record<string, unknown>): string {
  const result = payload.result as Record<string, unknown> | undefined;
  if (!result) return 'Sem resultado.';
  const m = (result.metrics ?? {}) as Record<string, number>;
  const a = (result.assumptions ?? {}) as Record<string, unknown>;
  const firstMs = Number(result.firstCandleOpenTime);
  const lastMs = Number(result.lastCandleCloseTime);
  const periodo = Number.isFinite(firstMs) && Number.isFinite(lastMs)
    ? `${new Date(firstMs).toLocaleDateString('pt-BR')} a ${new Date(lastMs).toLocaleDateString('pt-BR')}`
    : '—';

  const linhas = [
    `# Backtest — ${payload.symbol} · ${payload.timeframe}`,
    ``,
    `- Período: ${periodo}`,
    `- Candles: ${result.candleCount} (aquecimento ${result.warmupCandles}, testados ${result.testedCandleCount})`,
    `- Execução: ${payload.execution_ms} ms · gerado em ${payload.generated_at}`,
    `- Premissas: sinal no ${a.signalTiming}, entrada em ${a.entryTiming}, prioridade intrabar ${a.intrabarPriority}, custos incluídos: ${a.costsIncluded}`,
    ``,
    `## Métricas`,
    ``,
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Capital inicial | ${fmt(m.initialCapitalUsdt)} USDT |`,
    `| Capital final | ${fmt(m.finalCapitalUsdt)} USDT |`,
    `| Retorno líquido | ${fmt(m.netReturnPct)}% |`,
    `| PnL líquido | ${fmt(m.netPnlUsdt)} USDT |`,
    `| Sinais | ${m.signals} |`,
    `| Operações executadas | ${m.enteredTrades} |`,
    `| Sinais ignorados | ${m.skippedSignals} |`,
    `| Vitórias / Derrotas / Empates | ${m.wins} / ${m.losses} / ${m.breakeven} |`,
    `| Taxa de acerto | ${fmt(m.winRatePct)}% |`,
    `| Profit factor | ${m.profitFactor === null ? '∞ (sem perdas)' : fmt(m.profitFactor)} |`,
    `| R médio | ${fmt(m.averageR)} |`,
    `| R mediano | ${fmt(m.medianR)} |`,
    `| Melhor / Pior R | ${fmt(m.bestR)} / ${fmt(m.worstR)} |`,
    `| Drawdown máximo | ${fmt(m.maximumDrawdownPct)}% (${fmt(m.maximumDrawdownUsdt)} USDT) |`,
    `| Máx. vitórias/derrotas seguidas | ${m.maximumConsecutiveWins} / ${m.maximumConsecutiveLosses} |`,
    `| Exposição | ${fmt(m.exposurePct)}% do tempo |`,
    `| Holding médio | ${fmt(m.averageHoldingCandles, 1)} candles |`,
    ``,
    `> ${result.educationalNotice ?? ''}`,
  ];
  return linhas.join('\n');
}

export default function TestPage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1h');
  const [candleCount, setCandleCount] = useState('3000');
  const [riskPercent, setRiskPercent] = useState('1');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [json, setJson] = useState('');
  const [copied, setCopied] = useState<'md' | 'json' | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  const run = useCallback(async () => {
    setBusy(true); setError(''); setMarkdown(''); setJson(''); setCopied(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('backtest-daytrade', {
        body: {
          symbol,
          timeframe,
          candle_count: Number(candleCount),
          backtest_options: { riskPercent: Number(riskPercent) },
        },
      });
      if (fnError) throw new Error(fnError.message);
      if (data?.error) throw new Error(data.error);
      setJson(JSON.stringify(data, null, 2));
      setMarkdown(buildMarkdown(data as Record<string, unknown>));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao executar backtest.');
    } finally {
      setBusy(false);
    }
  }, [supabase, symbol, timeframe, candleCount, riskPercent]);

  const copy = async (text: string, which: 'md' | 'json') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Não foi possível copiar automaticamente; selecione e copie manualmente.');
    }
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%', minHeight: 220, background: S.bg, border: `1px solid ${S.border}`,
    borderRadius: 8, color: S.text, padding: 12, fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre',
    overflow: 'auto',
  };

  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <header style={{ borderBottom: `1px solid ${S.border}`, background: S.panel, padding: '12px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Bancada de backtest</div>
        <div style={{ fontSize: 11, color: S.dim }}>uso interno · executa backtest-daytrade e exporta resultado</div>
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {!authReady ? null : !session ? (
          <Card style={{ textAlign: 'center', color: S.dim, fontSize: 14 }}>
            Faça login em <a href="/alertas" style={{ color: S.a }}>/alertas</a> neste navegador e recarregue esta página.
          </Card>
        ) : (
          <>
            <Card style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                Par
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle}>
                  {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                Timeframe
                <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} style={inputStyle}>
                  {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                Candles (350–3000)
                <input type="number" min="350" max="3000" value={candleCount}
                  onChange={(e) => setCandleCount(e.target.value)} style={{ ...inputStyle, width: 120 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                Risco por trade (%)
                <input type="number" min="0.01" max="2" step="0.25" value={riskPercent}
                  onChange={(e) => setRiskPercent(e.target.value)} style={{ ...inputStyle, width: 100 }} />
              </label>
              <button onClick={run} disabled={busy}
                style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Executando...' : 'Rodar backtest'}
              </button>
            </Card>

            <div style={{ fontSize: 11, color: S.dim, textAlign: 'center' }}>
              Nota: 3000 candles em 1h ≈ 125 dias. Para alcançar janeiro/2026, rode também outros pares/timeframes
              e cole cada resultado. Timeframes curtos (5m/15m) cobrem menos dias por chamada.
            </div>

            {error && <Card style={{ color: S.red, fontSize: 13, textAlign: 'center' }}>{error}</Card>}

            {markdown && (
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 14 }}>Resumo (Markdown)</strong>
                  <button onClick={() => copy(markdown, 'md')}
                    style={{ background: 'transparent', color: copied === 'md' ? S.green : S.a, border: `1px solid ${copied === 'md' ? S.green : S.a}`, borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>
                    {copied === 'md' ? 'Copiado ✓' : 'Copiar'}
                  </button>
                </div>
                <textarea readOnly value={markdown} style={textareaStyle} onFocus={(e) => e.target.select()} />
              </Card>
            )}

            {json && (
              <Card>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 14 }}>JSON completo</strong>
                  <button onClick={() => copy(json, 'json')}
                    style={{ background: 'transparent', color: copied === 'json' ? S.green : S.a, border: `1px solid ${copied === 'json' ? S.green : S.a}`, borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>
                    {copied === 'json' ? 'Copiado ✓' : 'Copiar'}
                  </button>
                </div>
                <textarea readOnly value={json} style={{ ...textareaStyle, minHeight: 320 }} onFocus={(e) => e.target.select()} />
              </Card>
            )}
          </>
        )}
      </div>
    </main>
  );
}
