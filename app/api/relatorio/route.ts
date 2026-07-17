/**
 * app/api/relatorio/route.ts — v2 com timeframe dinâmico
 * ---------------------------------------------------------------------------
 * Gera relatório analítico em pt-BR a partir das métricas calculadas no client.
 * Recebe também o timeframe (1 hora / 4 horas / diário / semanal) e a unidade
 * das métricas de extremos (janela de 24h / dia / semana), interpolados no prompt.
 *
 * DECISÃO DE PRODUTO/COMPLIANCE: relatório DESCRITIVO — nunca recomenda
 * compra/venda, nunca prevê direção. Protege o usuário e o CNPJ (recomendação
 * de investimento é atividade regulada pela CVM).
 */

import { NextResponse } from 'next/server';

interface AssetStats {
  symbol: string;
  returnPct: number;
  maxDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
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
6. Encerre com uma frase padrão informando que o relatório é descritivo e não constitui recomendação de investimento.

FORMATO: texto corrido em 3 a 5 parágrafos curtos, sem markdown, sem listas.
CONTEÚDO: a primeira frase DEVE declarar explicitamente o período analisado e o timeframe dos candles (ex.: "No período de 6 meses, em candles diários..."); leitura da volatilidade e do regime atual de cada ativo — ao mencionar o regime, explique em meia frase que ele compara a volatilidade atual com o histórico do próprio ativo no período analisado; se houver dois ativos, comparação objetiva (quem rendeu mais pagou qual preço em risco); observações sobre a relação retorno/drawdown. Ao citar volatilidade, sempre qualifique como "anualizada". Ao citar os melhores/piores extremos, use exatamente a unidade informada nos dados (ex.: "melhor dia", "pior semana", "janela de 24 horas").`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });
    }

    const body = await req.json();
    const ativos: AssetStats[] = body?.ativos;
    const periodoMeses: number = body?.periodoMeses;
    // Whitelist dos campos textuais vindos do client (evita prompt injection)
    const TF_PERMITIDOS = ['1 hora', '4 horas', 'diário', 'semanal'];
    const UNIDADES_PERMITIDAS = ['janela de 24h', 'dia', 'semana'];
    const timeframeLabel = TF_PERMITIDOS.includes(body?.timeframeLabel) ? body.timeframeLabel : 'diário';
    const unidadeExtremos = UNIDADES_PERMITIDAS.includes(body?.unidadeExtremos) ? body.unidadeExtremos : 'dia';

    if (!Array.isArray(ativos) || ativos.length === 0 || !periodoMeses) {
      return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 });
    }

    // Sanitização: só números e strings curtas chegam ao modelo
    const clean = ativos.slice(0, 2).map((a) => ({
      symbol: String(a.symbol).slice(0, 12),
      retornoPeriodoPct: Number(a.returnPct.toFixed(2)),
      drawdownMaximoPct: Number(a.maxDrawdownPct.toFixed(2)),
      volatilidadeMediaAnualPct: Math.round(Number(a.annualVolPct)),
      volatilidadeAtualAnualPct: Math.round(Number(a.currentVolPct)),
      regimeAtual: String(a.regime).slice(0, 10),
      [`melhor_${unidadeExtremos.replace(/\s/g, '_')}_pct`]: Number(a.bestUnitPct.toFixed(2)),
      [`pior_${unidadeExtremos.replace(/\s/g, '_')}_pct`]: Number(a.worstUnitPct.toFixed(2)),
      ultimoPrecoUSDT: Number(a.lastPrice),
    }));

    const periodoTexto = periodoMeses === 1 ? '1 mês' : `${periodoMeses} meses`;
    const userPrompt =
      `Período analisado: ${periodoTexto}. Timeframe dos candles: ${timeframeLabel}. ` +
      `Unidade das métricas de extremos: ${unidadeExtremos}.\n` +
      `Dados:\n${JSON.stringify(clean, null, 2)}`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 700,
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
