/**
 * app/api/relatorio/route.ts — v3
 * ---------------------------------------------------------------------------
 * Novidades: correlação A×B, Sharpe simplificado, % de períodos positivos,
 * drawdown atual/tempo em drawdown no payload; seção final "Em palavras
 * simples" com definições entre parênteses na primeira ocorrência de cada
 * termo técnico (glossário progressivo para iniciantes).
 *
 * COMPLIANCE: relatório DESCRITIVO — nunca recomenda compra/venda, nunca
 * prevê direção (atividade de recomendação é regulada pela CVM).
 */

import { NextResponse } from 'next/server';

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
  regime: string;
  bestUnitPct: number;
  worstUnitPct: number;
  lastPrice: number;
}

const SYSTEM_PROMPT = `Você é um analista quantitativo que escreve relatórios descritivos de mercado em português do Brasil.

REGRAS INVIOLÁVEIS:
1. NUNCA recomende comprar, vender, entrar ou sair de posição.
2. NUNCA preveja direção futura de preço. Volatilidade mede amplitude de risco, não direção.
3. NUNCA use linguagem promocional ("oportunidade", "momento ideal", "potencial de alta").
4. Baseie-se EXCLUSIVAMENTE nos números fornecidos. Não invente dados externos.
5. Sempre contextualize risco: drawdown e piores extremos merecem o mesmo destaque que retornos.
6. Encerre com a frase padrão informando que o relatório é descritivo e não constitui recomendação de investimento.

FORMATO: texto corrido, sem markdown e sem listas, em duas partes:

PARTE 1 — ANÁLISE (3 a 4 parágrafos curtos):
- A primeira frase DEVE declarar explicitamente o período analisado e o timeframe dos candles (ex.: "No período de 6 meses, em candles diários...").
- Leitura da volatilidade e do regime atual de cada ativo — ao mencionar o regime, explique em meia frase que ele compara a volatilidade atual com o histórico do próprio ativo no período analisado.
- Se houver dois ativos: comparação objetiva (quem rendeu mais pagou qual preço em risco), usando o Sharpe simplificado como medida de retorno por unidade de risco. Se a correlação for informada, comente o que ela indica sobre os ativos se moverem juntos ou não (correlação alta significa que diversificar entre eles reduz pouco o risco).
- Relação retorno/drawdown, drawdown atual e tempo em drawdown; percentual de períodos positivos.
- Ao citar volatilidade, sempre qualifique como "anualizada". Ao citar extremos, use exatamente a unidade informada nos dados.

PARTE 2 — "EM PALAVRAS SIMPLES" (1 a 2 parágrafos):
- Comece exatamente com "Em palavras simples: ".
- Reexplique as mesmas conclusões sem jargão, para quem nunca investiu.
- Na PRIMEIRA ocorrência de cada termo técnico nesta seção, inclua a explicação entre parênteses. Exemplos do padrão: "volatilidade (o quanto o preço balança para cima e para baixo)", "drawdown (a maior queda desde o topo até o fundo)", "correlação (o quanto os dois ativos sobem e descem juntos)", "anualizada (projetada para a escala de um ano, para facilitar comparação)".
- Use analogias do cotidiano quando ajudarem, sem infantilizar.`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });
    }

    const body = await req.json();
    const ativos: AssetStats[] = body?.ativos;

    // Whitelist dos campos textuais vindos do client (evita prompt injection)
    const TF_PERMITIDOS = ['1 hora', '4 horas', 'diário', 'semanal'];
    const UNIDADES_PERMITIDAS = ['janela de 24h', 'dia', 'semana'];
    const timeframeLabel = TF_PERMITIDOS.includes(body?.timeframeLabel) ? body.timeframeLabel : 'diário';
    const unidadeExtremos = UNIDADES_PERMITIDAS.includes(body?.unidadeExtremos) ? body.unidadeExtremos : 'dia';
    // Período: aceita apenas o formato "<número> dias|meses"
    const periodoLabel = /^\d{1,4} (dias|meses)$/.test(body?.periodoLabel) ? body.periodoLabel : 'período informado';
    // Correlação: número entre -1 e 1, ou ausente
    const correlacao =
      typeof body?.correlacao === 'number' && body.correlacao >= -1 && body.correlacao <= 1
        ? Number(body.correlacao.toFixed(2))
        : null;

    if (!Array.isArray(ativos) || ativos.length === 0) {
      return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 });
    }

    const unidadeKey = unidadeExtremos.replace(/\s/g, '_');
    const clean = ativos.slice(0, 2).map((a) => ({
      symbol: String(a.symbol).slice(0, 12),
      retornoPeriodoPct: Number(Number(a.returnPct).toFixed(2)),
      retornoAnualizadoPct: Number(Number(a.annualReturnPct).toFixed(2)),
      drawdownMaximoPct: Number(Number(a.maxDrawdownPct).toFixed(2)),
      drawdownAtualPct: Number(Number(a.currentDrawdownPct).toFixed(2)),
      tempoEmDrawdownPct: Math.round(Number(a.timeInDrawdownPct)),
      volatilidadeMediaAnualPct: Math.round(Number(a.annualVolPct)),
      volatilidadeAtualAnualPct: Math.round(Number(a.currentVolPct)),
      sharpeSimplificado: Number(Number(a.sharpe).toFixed(2)),
      periodosPositivosPct: Math.round(Number(a.pctPositive)),
      regimeAtual: String(a.regime).slice(0, 10),
      [`melhor_${unidadeKey}_pct`]: Number(Number(a.bestUnitPct).toFixed(2)),
      [`pior_${unidadeKey}_pct`]: Number(Number(a.worstUnitPct).toFixed(2)),
      ultimoPrecoUSDT: Number(a.lastPrice),
    }));

    const userPrompt =
      `Período analisado: ${periodoLabel}. Timeframe dos candles: ${timeframeLabel}. ` +
      `Unidade das métricas de extremos: ${unidadeExtremos}.` +
      (correlacao !== null ? ` Correlação entre os dois ativos no período: ${correlacao}.` : '') +
      `\nDados:\n${JSON.stringify(clean, null, 2)}`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: `OpenAI ${res.status}: ${detail.slice(0, 200)}` }, { status: 502 });
    }

    const json = await res.json();
    const relatorio: string = json?.choices?.[0]?.message?.content ?? '';

    return NextResponse.json({ relatorio });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Erro interno.' },
      { status: 500 },
    );
  }
}
