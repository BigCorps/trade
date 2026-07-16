/**
 * app/api/relatorio/route.ts
 * ---------------------------------------------------------------------------
 * Gera relatório analítico em pt-BR a partir das métricas calculadas no client.
 * Padrão idêntico ao usado no minhAi: fetch direto na API da OpenAI com chave
 * em variável de ambiente (OPENAI_API_KEY na Vercel).
 *
 * DECISÃO DE PRODUTO/COMPLIANCE embutida no system prompt: o relatório é
 * DESCRITIVO. Ele nunca recomenda compra/venda, nunca prevê direção de preço
 * e nunca sugere momento de entrada. Isso protege o usuário e protege o CNPJ
 * (recomendação de investimento é atividade regulada pela CVM).
 */

import { NextResponse } from 'next/server';

interface AssetStats {
  symbol: string;
  returnPct: number;
  maxDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
  regime: string;
  bestDayPct: number;
  worstDayPct: number;
  lastPrice: number;
}

const SYSTEM_PROMPT = `Você é um analista quantitativo que escreve relatórios descritivos de mercado em português do Brasil.

REGRAS INVIOLÁVEIS:
1. NUNCA recomende comprar, vender, entrar ou sair de posição.
2. NUNCA preveja direção futura de preço. Volatilidade mede amplitude de risco, não direção.
3. NUNCA use linguagem promocional ("oportunidade", "momento ideal", "potencial de alta").
4. Baseie-se EXCLUSIVAMENTE nos números fornecidos. Não invente dados externos.
5. Sempre contextualize risco: drawdown e pior janela de 24h merecem o mesmo destaque que retornos.
6. Encerre com uma frase padrão informando que o relatório é descritivo e não constitui recomendação de investimento.

FORMATO: texto corrido em 3 a 5 parágrafos curtos, sem markdown, sem listas.
CONTEÚDO: resumo do período; leitura da volatilidade e do regime atual de cada ativo; se houver dois ativos, comparação objetiva (quem rendeu mais pagou qual preço em risco); observações sobre a relação retorno/drawdown.`;

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY não configurada.' }, { status: 500 });
    }

    const body = await req.json();
    const ativos: AssetStats[] = body?.ativos;
    const periodoMeses: number = body?.periodoMeses;

    if (!Array.isArray(ativos) || ativos.length === 0 || !periodoMeses) {
      return NextResponse.json({ error: 'Payload inválido.' }, { status: 400 });
    }

    // Sanitização: só repassa campos numéricos esperados (nada de prompt injection via payload)
    const clean = ativos.slice(0, 2).map((a) => ({
      symbol: String(a.symbol).slice(0, 12),
      retornoPeriodoPct: Number(a.returnPct),
      drawdownMaximoPct: Number(a.maxDrawdownPct),
      volatilidadeMediaAnualPct: Number(a.annualVolPct),
      volatilidadeAtualAnualPct: Number(a.currentVolPct),
      regimeAtual: String(a.regime).slice(0, 10),
      melhorJanela24hPct: Number(a.bestDayPct),
      piorJanela24hPct: Number(a.worstDayPct),
      ultimoPrecoUSDT: Number(a.lastPrice),
    }));

    const userPrompt =
      `Período analisado: ${periodoMeses} meses, candles de 1 hora.\n` +
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