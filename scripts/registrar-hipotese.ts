/**
 * scripts/registrar-hipotese.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Registra uma hipótese ANTES da coleta de dados.
 *
 * Por que isso existe: decidir o critério de sucesso depois de ver o
 * resultado é o mecanismo mais comum de autoengano em pesquisa quantitativa.
 * Sempre existe um recorte dos dados em que a estratégia funcionou.
 *
 * O script força três definições antes de qualquer coleta:
 *   1. a pergunta, em uma frase;
 *   2. o mecanismo econômico que justifica a hipótese;
 *   3. a condição que a mata.
 *
 * Uso:
 *   npx tsx scripts/registrar-hipotese.ts
 *
 * Requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.
 * Não executa ordens e não altera nenhuma política de execução.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { createClient } from '@supabase/supabase-js';

import {
  expectedMaxTUnderNull,
  requiredSampleSize,
  requiredTStatistic,
} from '../lib/estatistica/multipleTesting';

const rl = createInterface({ input: stdin, output: stdout });

const perguntar = async (texto: string): Promise<string> => {
  const resposta = await rl.question(texto);
  return resposta.trim();
};

const perguntarObrigatorio = async (
  texto: string,
  minimo = 1,
): Promise<string> => {
  for (;;) {
    const resposta = await perguntar(texto);
    if (resposta.length >= minimo) return resposta;
    console.log(
      minimo > 1
        ? `  Precisa de ao menos ${minimo} caracteres. Vale o esforço.\n`
        : '  Campo obrigatório.\n',
    );
  }
};

const perguntarLista = async (texto: string): Promise<string[]> => {
  const bruto = await perguntarObrigatorio(texto);
  return bruto
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
};

const linha = (caractere = '─') => console.log(caractere.repeat(72));

async function main() {
  console.log('');
  linha('═');
  console.log('  REGISTRO DE HIPÓTESE — VigIA Trade');
  linha('═');
  console.log('');
  console.log('  Uma hipótese registrada antes da coleta pode ser refutada.');
  console.log('  Uma inventada depois do resultado nunca é falsa — e por isso');
  console.log('  não vale nada.');
  console.log('');

  // -------------------------------------------------------------------------
  // 1. A pergunta
  // -------------------------------------------------------------------------

  linha();
  console.log('  1. A PERGUNTA');
  linha();
  console.log('');
  console.log('  Em uma frase. Se não couber, ainda não está clara o bastante.');
  console.log('');

  const nome = await perguntarObrigatorio('  Nome curto: ');
  const pergunta = await perguntarObrigatorio('  Pergunta: ', 20);

  // -------------------------------------------------------------------------
  // 2. O fundamento
  // -------------------------------------------------------------------------

  console.log('');
  linha();
  console.log('  2. O FUNDAMENTO ECONÔMICO');
  linha();
  console.log('');
  console.log('  Por que isto DEVERIA funcionar? Que comportamento de mercado');
  console.log('  a hipótese captura? Quem está do outro lado, e por quê?');
  console.log('');
  console.log('  Fraco:  "quando a média de 9 cruza a de 21, o preço sobe"');
  console.log('          (descreve o indicador, não explica nada)');
  console.log('');
  console.log('  Forte:  "após alta forte, fundos seguidores de tendência levam');
  console.log('          dias para ajustar posição, gerando continuação"');
  console.log('          (tem agente, mecanismo e razão)');
  console.log('');
  console.log('  Se você não consegue escrever do segundo tipo, provavelmente');
  console.log('  é mineração de padrão em ruído. Esse é o filtro mais barato');
  console.log('  que existe.');
  console.log('');

  const fundamento = await perguntarObrigatorio('  Fundamento: ', 60);

  // -------------------------------------------------------------------------
  // 3. O escopo
  // -------------------------------------------------------------------------

  console.log('');
  linha();
  console.log('  3. O ESCOPO');
  linha();
  console.log('');
  console.log('  Cada combinação adicional sobe a régua de aprovação.');
  console.log('  Escopo largo não é mais chance de achar algo — é mais');
  console.log('  chance de achar ruído convincente.');
  console.log('');

  const simbolos = await perguntarLista('  Símbolos (BTCUSDT,ETHUSDT): ');
  const timeframes = await perguntarLista('  Timeframes (1h,4h): ');
  const estrategias = await perguntarLista('  Estratégias: ');

  const combinacoes =
    simbolos.length * timeframes.length * estrategias.length;

  const piso = expectedMaxTUnderNull(combinacoes);
  const limiar = requiredTStatistic(combinacoes);

  console.log('');
  console.log(`  → ${combinacoes} combinações no escopo`);
  console.log(`  → piso de ruído: t = ${piso.toFixed(2)}`);
  console.log(`  → t exigido para aprovar: ${limiar.toFixed(2)}`);
  console.log('');

  if (combinacoes > 20) {
    console.log('  ⚠  Escopo largo. Com este número de combinações, um');
    console.log('     resultado precisa ser muito forte para significar algo.');
    console.log('     Considere focar antes de começar.');
    console.log('');
  }

  // -------------------------------------------------------------------------
  // 4. Dimensionamento
  // -------------------------------------------------------------------------

  linha();
  console.log('  4. QUANTAS OPERAÇÕES SERÃO NECESSÁRIAS');
  linha();
  console.log('');

  const edgeBruto = await perguntarObrigatorio(
    '  Edge esperado em R por operação (ex.: 0.15): ',
  );
  const edge = Number(edgeBruto.replace(',', '.'));

  const desvioBruto = await perguntar(
    '  Desvio esperado em R [1.3]: ',
  );
  const desvio = Number((desvioBruto || '1.3').replace(',', '.')) || 1.3;

  const necessarias =
    Number.isFinite(edge) && edge > 0
      ? requiredSampleSize(edge, desvio, combinacoes)
      : null;

  console.log('');
  if (necessarias === null) {
    console.log('  Não foi possível estimar. Usando mínimo de 100 operações.');
  } else {
    console.log(`  → ~${necessarias} operações para uma resposta confiável`);

    const semanas = Math.ceil(necessarias / 66); // ~66/semana no ritmo atual
    console.log(`  → no ritmo atual do cron, cerca de ${semanas} semanas`);
    console.log('');
    console.log('  Se esse prazo parece longo, a alternativa não é decidir');
    console.log('  mais rápido — é decidir com menos informação.');
  }
  console.log('');

  const amostraMinima = Math.max(100, necessarias ?? 100);

  // -------------------------------------------------------------------------
  // 5. O critério de morte
  // -------------------------------------------------------------------------

  linha();
  console.log('  5. O CRITÉRIO DE MORTE');
  linha();
  console.log('');
  console.log('  O que faz você abandonar esta hipótese?');
  console.log('  Escreva agora, enquanto ainda é fácil ser objetivo.');
  console.log('');
  console.log(`  Sugestão: "Se após ${amostraMinima} operações o t corrigido`);
  console.log(`  for menor que ${limiar.toFixed(1)}, encerro e não reabro com`);
  console.log('  os mesmos dados."');
  console.log('');

  const criterioMorte = await perguntarObrigatorio('  Critério: ', 30);

  // -------------------------------------------------------------------------
  // 6. Confirmação
  // -------------------------------------------------------------------------

  console.log('');
  linha('═');
  console.log('  CONFIRMAR REGISTRO');
  linha('═');
  console.log('');
  console.log(`  Nome ................ ${nome}`);
  console.log(`  Pergunta ............ ${pergunta}`);
  console.log(`  Símbolos ............ ${simbolos.join(', ')}`);
  console.log(`  Timeframes .......... ${timeframes.join(', ')}`);
  console.log(`  Estratégias ......... ${estrategias.join(', ')}`);
  console.log(`  Combinações ......... ${combinacoes}`);
  console.log(`  Amostra mínima ...... ${amostraMinima}`);
  console.log(`  t exigido ........... ${limiar.toFixed(2)}`);
  console.log('');
  console.log('  Após o registro o escopo fica CONGELADO. Alterar símbolos,');
  console.log('  timeframes ou critérios depois exige uma hipótese nova.');
  console.log('');

  const confirmacao = await perguntar('  Registrar? (s/N): ');

  if (confirmacao.toLowerCase() !== 's') {
    console.log('\n  Cancelado. Nada foi gravado.\n');
    rl.close();
    return;
  }

  // -------------------------------------------------------------------------
  // 7. Gravação
  // -------------------------------------------------------------------------

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.log('');
    console.log('  SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes.');
    console.log('  Registro montado mas não gravado. SQL equivalente:');
    console.log('');
    console.log(montarSql({
      nome, pergunta, fundamento, simbolos, timeframes,
      estrategias, amostraMinima, limiar, criterioMorte, combinacoes,
    }));
    console.log('');
    rl.close();
    return;
  }

  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from('hipoteses_pesquisa')
    .insert({
      nome,
      pergunta,
      fundamento_economico: fundamento,
      simbolos,
      timeframes,
      estrategias,
      amostra_minima: amostraMinima,
      t_minimo_exigido: Number(limiar.toFixed(2)),
      criterio_morte: criterioMorte,
      combinacoes_testadas: combinacoes,
      status: 'coletando',
      congelada_em: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.log(`\n  Falha ao gravar: ${error.message}\n`);
    rl.close();
    process.exitCode = 1;
    return;
  }

  console.log('');
  linha('═');
  console.log(`  Registrada e congelada. id: ${data.id}`);
  linha('═');
  console.log('');
  console.log('  A partir daqui, deixe correr. Acompanhe em /validacao sem');
  console.log('  ajustar parâmetros — cada ajuste no meio da coleta reinicia');
  console.log('  a contagem de evidência do zero.');
  console.log('');

  rl.close();
}

function montarSql(input: {
  nome: string;
  pergunta: string;
  fundamento: string;
  simbolos: string[];
  timeframes: string[];
  estrategias: string[];
  amostraMinima: number;
  limiar: number;
  criterioMorte: string;
  combinacoes: number;
}): string {
  const escapar = (texto: string) => texto.replace(/'/g, "''");
  const arranjo = (itens: string[]) =>
    `array[${itens.map((i) => `'${escapar(i)}'`).join(',')}]`;

  return `insert into public.hipoteses_pesquisa (
  nome, pergunta, fundamento_economico,
  simbolos, timeframes, estrategias,
  amostra_minima, t_minimo_exigido, criterio_morte,
  combinacoes_testadas, status, congelada_em
) values (
  '${escapar(input.nome)}',
  '${escapar(input.pergunta)}',
  '${escapar(input.fundamento)}',
  ${arranjo(input.simbolos)},
  ${arranjo(input.timeframes)},
  ${arranjo(input.estrategias)},
  ${input.amostraMinima},
  ${input.limiar.toFixed(2)},
  '${escapar(input.criterioMorte)}',
  ${input.combinacoes},
  'coletando',
  now()
);`;
}

main().catch((erro) => {
  console.error('\n  Erro inesperado:', erro);
  rl.close();
  process.exitCode = 1;
});
