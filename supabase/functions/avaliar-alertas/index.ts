// ============================================================================
// VigIA Trade — Edge Function: avaliar-alertas
// supabase/functions/avaliar-alertas/index.ts
// ============================================================================
// Chamada pelo pg_cron a cada 5 min (ver migração 001, seção 5).
// Fluxo: busca regras ativas → agrupa por symbol+timeframe (1 chamada Binance
// por grupo) → recalcula indicadores server-side → dispara APENAS na travessia
// do nível → registra em alert_events → envia email via Resend (se configurado).
//
// Secrets necessários (supabase secrets set):
//   CRON_SECRET      — valida que a chamada veio do cron, não do público
//   RESEND_API_KEY   — opcional; sem ela, eventos são registrados sem email
//   FROM_EMAIL       — ex.: alertas@vigiatrade.com (domínio verificado no Resend)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Config por timeframe (espelha o page.tsx — mantenha os dois em sincronia)
// ---------------------------------------------------------------------------
const TIMEFRAMES: Record<string, { periodsPerYear: number; volWindow: number }> = {
  '1h': { periodsPerYear: 24 * 365, volWindow: 72 },
  '4h': { periodsPerYear: 6 * 365, volWindow: 42 },
  '1d': { periodsPerYear: 365, volWindow: 30 },
  '1w': { periodsPerYear: 52, volWindow: 12 },
};

const COOLDOWN_MIN = 60; // não redispara a mesma regra em menos de 60 min

// ---------------------------------------------------------------------------
// Funções puras portadas do page.tsx (idênticas — não alterar sem espelhar lá)
// ---------------------------------------------------------------------------
interface Candle { openTime: number; close: number }

function logReturns(candles: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    r.push(Math.log(candles[i].close / candles[i - 1].close));
  }
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

function classifyRegime(volSeries: (number | null)[]): string {
  const vals = volSeries.filter((v): v is number => v !== null).sort((x, y) => x - y);
  const current = volSeries[volSeries.length - 1];
  if (current === null || vals.length < 4) return 'normal';
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  if (current <= q(0.25)) return 'calmo';
  if (current <= q(0.75)) return 'normal';
  if (current <= q(0.95)) return 'volátil';
  return 'extremo';
}

// ---------------------------------------------------------------------------
// Binance (server-side; sem CORS, mas com rate limit por IP — daí o agrupamento)
// ---------------------------------------------------------------------------
async function fetchCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status} para ${symbol}/${interval}`);
  const batch: (string | number)[][] = await res.json();
  return batch.map((k) => ({ openTime: Number(k[0]), close: +k[4] }));
}

// ---------------------------------------------------------------------------
// Email via Resend
// ---------------------------------------------------------------------------
async function sendEmail(to: string, subject: string, text: string): Promise<string | null> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('FROM_EMAIL');
  if (!key || !from) return 'RESEND_API_KEY/FROM_EMAIL não configurados';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: `VigIA Trade <${from}>`, to: [to], subject, text }),
  });
  if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Tipos da regra
// ---------------------------------------------------------------------------
interface Rule {
  id: string;
  user_id: string;
  symbol: string;
  timeframe: string;
  indicador: 'preco' | 'volatilidade' | 'regime';
  operador: 'acima' | 'abaixo' | null;
  nivel: number | null;
  nivel_regime: string | null;
  ultimo_lado: 'acima' | 'abaixo' | null;
  ultimo_regime: string | null;
  last_triggered_at: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  // Proteção: só o cron (com o secret) pode invocar
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Link de execução no email (só para quem tem chave Binance configurada)
  const siteUrl = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');
  const keysCache = new Map<string, boolean>(); // user_id → tem chave?

  const { data: rules, error } = await supabase
    .from('alert_rules')
    .select('*')
    .eq('ativo', true);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!rules?.length) {
    return new Response(JSON.stringify({ avaliadas: 0, disparos: 0 }), { status: 200 });
  }

  // Agrupa por symbol+timeframe: uma chamada à Binance por grupo
  const groups = new Map<string, Rule[]>();
  for (const r of rules as Rule[]) {
    const key = `${r.symbol}|${r.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  let disparos = 0;
  const erros: string[] = [];
  const emailCache = new Map<string, string | null>(); // user_id → email

  for (const [key, groupRules] of groups) {
    const [symbol, timeframe] = key.split('|');
    const tf = TIMEFRAMES[timeframe];
    if (!tf) continue;

    let preco: number, vol: number | null, regime: string;
    try {
      // volWindow*3 candles: suficiente para a janela + quartis de regime estáveis
      const candles = await fetchCandles(symbol, timeframe, Math.min(500, tf.volWindow * 3 + 10));
      const volSeries = rollingVol(logReturns(candles), tf.volWindow, tf.periodsPerYear);
      preco = candles[candles.length - 1].close;
      vol = volSeries[volSeries.length - 1];
      regime = classifyRegime(volSeries);
    } catch (e) {
      erros.push(`${key}: ${e instanceof Error ? e.message : 'fetch falhou'}`);
      continue; // não derruba os outros grupos
    }

    for (const rule of groupRules) {
      try {
        // Cooldown
        if (rule.last_triggered_at) {
          const mins = (Date.now() - new Date(rule.last_triggered_at).getTime()) / 60000;
          if (mins < COOLDOWN_MIN) continue;
        }

        let disparou = false;
        let valorAtual: number | null = null;
        let mensagem = '';
        const updates: Record<string, unknown> = {};

        if (rule.indicador === 'regime') {
          // Dispara quando o regime PASSA A SER o alvo (transição, não estado)
          if (regime === rule.nivel_regime && rule.ultimo_regime !== rule.nivel_regime) {
            disparou = true;
            mensagem = `${symbol} (${timeframe}) entrou em regime ${regime.toUpperCase()}. Volatilidade anualizada atual: ${vol?.toFixed(0) ?? '—'}%.`;
          }
          updates.ultimo_regime = regime;
        } else {
          valorAtual = rule.indicador === 'preco' ? preco : vol;
          if (valorAtual === null || rule.nivel === null) continue;
          const ladoAtual: 'acima' | 'abaixo' = valorAtual > rule.nivel ? 'acima' : 'abaixo';
          // Travessia: só dispara se o lado MUDOU para o lado monitorado
          if (ladoAtual === rule.operador && rule.ultimo_lado !== null && rule.ultimo_lado !== ladoAtual) {
            disparou = true;
            const nome = rule.indicador === 'preco' ? 'Preço' : 'Volatilidade anualizada';
            const unidade = rule.indicador === 'preco' ? ' USDT' : '%';
            mensagem = `${nome} de ${symbol} (${timeframe}) cruzou para ${ladoAtual.toUpperCase()} de ${rule.nivel}${unidade}. Valor atual: ${valorAtual.toFixed(2)}${unidade}. Regime: ${regime}.`;
          }
          updates.ultimo_lado = ladoAtual;
        }

        if (disparou) {
          disparos++;
          updates.last_triggered_at = new Date().toISOString();

          // Email do usuário (cacheado por execução)
          if (!emailCache.has(rule.user_id)) {
            const { data: u } = await supabase.auth.admin.getUserById(rule.user_id);
            emailCache.set(rule.user_id, u?.user?.email ?? null);
          }
          const email = emailCache.get(rule.user_id);

          if (!keysCache.has(rule.user_id)) {
            const { data: k } = await supabase.from('exchange_keys')
              .select('user_id').eq('user_id', rule.user_id).maybeSingle();
            keysCache.set(rule.user_id, !!k);
          }
          const linkExec = keysCache.get(rule.user_id) && siteUrl
            ? `\n\nExecutar ordem com stop e alvo (decisão sua): ${siteUrl}/executar?symbol=${symbol}`
            : '';

          let erroEnvio: string | null = 'usuário sem email';
          if (email) {
            erroEnvio = await sendEmail(
              email,
              `VigIA · Alerta ${symbol}`,
              `${mensagem}${linkExec}\n\nEste é um aviso automático de monitoramento. Não constitui recomendação de investimento.\n\n— VigIA Trade`,
            );
          }

          await supabase.from('alert_events').insert({
            rule_id: rule.id,
            user_id: rule.user_id,
            valor: valorAtual ?? vol,
            regime,
            mensagem,
            notificado: erroEnvio === null,
            erro_envio: erroEnvio,
          });
        }

        // Atualiza o estado da regra SEMPRE (mesmo sem disparo) — é o que
        // permite detectar a travessia na próxima execução
        await supabase.from('alert_rules').update(updates).eq('id', rule.id);
      } catch (e) {
        erros.push(`regra ${rule.id}: ${e instanceof Error ? e.message : 'erro'}`);
      }
    }
  }

  return new Response(
    JSON.stringify({ avaliadas: rules.length, grupos: groups.size, disparos, erros }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});