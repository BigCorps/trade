# VigIA — Revalidação com dados ao vivo

**Data:** 16/08/2026 · **Fonte:** repo `BigCorps/trade` + Supabase `xzqmfcxtvfffgrmqqzdz` (MCP)
**Escopo:** revalidar a `AUDITORIA.md` de 07/08 contra os dados coletados desde então, e definir o que fazer com o sistema.

---

## Resumo em uma página

Nove dias novos de dados. Nada do que a auditoria concluiu foi revertido — o direcional
ficou **mais** negativo, e o módulo de notícias continuou sem sinal em dados
limpos de fora da amostra.

Mas encontrei três coisas que a auditoria não podia ver:

1. **O motor de evidência está desligado.** As 4 configurações do teste prospectivo
   estão com `ativo = false`, `coletar = false`, `protocolo_status = 'encerrado'`. O
   cron continua rodando 24×/dia (664 execuções, todas `concluido`, a última às
   17:10 de hoje) e não coleta nada. O sistema está queimando execução sem gerar
   evidência há 4 dias.

2. **A janela de funding carry abriu pela primeira vez** — 09/08, BNBUSDT, 6 horas,
   pico de 18,53% anualizado. Era o evento que a auditoria disse para esperar.

3. **E a regra de elegibilidade que capturou essa janela está estruturalmente errada.**
   Ela assume 30 dias de retenção na taxa instantânea. Medi a persistência com os
   seus 2.706 snapshots: o funding reverte para ~6% em 72h independentemente de onde
   começa. Detalhe na seção 3 — é o achado mais acionável deste relatório.

---

## 1. Direcional — o veredito endureceu

| Métrica | Auditoria 07/08 | Agora 16/08 |
|---|---|---|
| Sinais fechados | 132 | **143** |
| Média R | −0,530 | **−0,475** |
| Acumulado | −69,94 R | **−67,92 R** |
| Acerto | 23,5% | 25,2% |
| Desvio-padrão | — | 1,3385 |
| **t agregado** | ≈ −4,5 | **−4,24** |

A média melhorou marginalmente, e isso não é uma boa notícia — é o efeito de 11 sinais
novos vindos de estratégias diferentes (FBR e CTT), não de recuperação. As duas
combinações com amostra relevante **não se mexeram um sinal sequer**:

| Estratégia | TF | n | Média R | t |
|---|---|---:|---:|---:|
| trend_breakout | 1h | 64 | −0,391 | **−2,29** |
| trend_pullback | 1h | 39 | −0,694 | **−3,38** |
| trend_breakout | 4h | 12 | −0,600 | −1,74 |
| failed_breakout_reversal | 1h | 8 | +0,281 | 0,46 |
| trend_pullback | 4h | 7 | −0,316 | −0,56 |
| trend_breakout | 12h | 4 | −1,088 | — |
| confirmed_trend_continuation | 1h | 3 | −1,302 | — |

`failed_breakout_reversal` é a única com média positiva. **n = 8, t = 0,46.** Com
`carga_de_busca = 196`, o piso de ruído Šidák está em torno de t ≈ 3,6. Essa linha
não é evidência de nada — é o tamanho de amostra em que tudo parece possível. Ela
precisa de ~300 sinais antes de significar qualquer coisa, e no ritmo atual isso
não vai acontecer nunca (ver seção 2).

A decomposição não mudou nada:

```
stop   n=107   média −1,242 R   MFE médio +0,456 R
alvo   n= 36   média +1,806 R   MFE médio +2,499 R
```

MFE das perdedoras continua em +0,46 R. As operações que morrem não andam a favor
antes de morrer. Isso mata breakeven, parcial e trailing pela mesma razão de antes —
não há excursão para acionar. Já testado à exaustão, resultado idêntico nas quatro gestões.

**O que foi corrigido desde a auditoria (crédito devido):** o bug de gap no simulador
foi resolvido — `multiStrategyBacktest.ts:1173` agora preenche em `candle.open` quando
o candle abre além do stop. E o motor ganhou suporte a venda, validado pelo ensaio FBR
de 08/08. Ambos eram recomendações da auditoria. Foram feitos direito.

---

## 2. O achado operacional — o motor de evidência está parado

Este é o problema mais urgente, e é invisível olhando o dashboard.

```
forward_test_config
  1.1.0            Tendência diária        ativo=false  coletar=false  encerrado  último sinal 06/08
  2.0.0-fbr        Rompimento fracassado   ativo=false  coletar=false  encerrado  último sinal 12/08
  2.0.0-selective  Continuação seletiva    ativo=false  coletar=false  encerrado  0 sinais
  2.0.0-control    Continuação controle    ativo=false  coletar=false  encerrado  último sinal 08/08
```

**Nenhuma configuração ativa. Zero sinais novos há 4 dias.** A curva de coleta:

```
02/08  17 sinais      09/08   1
03/08  20             10/08   2
04/08  14             11/08   1
05/08   8             12/08   1
06/08   5             13/08   0
07/08   5             14/08   0
08/08   3             15/08   0
                      16/08   0
```

O encerramento da CTT em 08/08 foi uma decisão correta e pré-registrada. Mas as
outras configurações foram encerradas junto, e o resultado é que o único gerador de
evidência confiável do projeto está desligado enquanto o cron gasta 24 execuções por
dia sem fazer nada.

A auditoria recomendou explicitamente "manter o forward test rodando, deixe chegar a
300+ sinais". Está em 143 e congelado. **Se você quer que o VigIA continue aprendendo
qualquer coisa, esta é a primeira correção — e é uma linha de SQL.**

---

## 3. Funding carry — a janela abriu, e a régua está errada

Aqui está a parte que muda o que dá para fazer com o sistema.

### A janela abriu

2.706 snapshots · 11 símbolos · 06–16/08. Contra 0/385 elegíveis na auditoria,
agora há **7 elegíveis** — todos BNBUSDT:

| Momento | Funding anual. | Basis | Carry líq. est. |
|---|---:|---:|---:|
| 09/08 18:11 | 15,73% | 0,0752 | +8,43% |
| 09/08 19:11 | 17,28% | 0,0712 | +9,98% |
| 09/08 20:11 | 18,38% | 0,0719 | +11,08% |
| 09/08 21:11 | **18,53%** | 0,0643 | **+11,23%** |
| 09/08 22:11 | 18,05% | 0,0670 | +10,75% |
| 09/08 23:11 | 15,69% | 0,0659 | +8,39% |
| 10/08 20:11 | 15,00% | 0,0576 | +7,70% |

Seis horas contíguas, mais uma hora isolada no dia seguinte. **A janela dura horas.**

### E aqui está o problema

O protocolo v1.0.0 tem `holding_dias_assumido = 30`. Ele lê 18,53% anualizado no
instante *t* e reporta "+11,23% de carry líquido" — um número que só se realiza se a
taxa se mantiver por 30 dias.

Testei essa premissa com os seus próprios dados. Para cada snapshot, comparei o funding
atual com a média das 24h e 72h seguintes:

| Faixa atual | n | Funding agora | Média próx. 24h | Média próx. 72h |
|---|---:|---:|---:|---:|
| ≥ 15% | 7 | 16,95% | **8,86%** | **6,30%** |
| 10,9–15% | 570 | 10,99% | 8,01% | 6,17% |
| 5–10,9% | 595 | 7,67% | 6,15% | 5,67% |
| 0–5% | 384 | 2,84% | 4,85% | 5,41% |
| ≤ 0% | 358 | −4,83% | 1,46% | 3,61% |

**Tudo converge para ~6% em 72 horas, independentemente de onde começou.** O funding
não persiste — ele reverte à média, e a média está em torno de 6% anualizado.

O elegível de 09/08, que o sistema marcou com "+11,23% de carry líquido anualizado",
teria rendido na prática uma média de **6,30%** nas 72h seguintes. Com 0,60% de custo
de ida e volta, isso é prejuízo em qualquer horizonte curto.

Detalhe técnico que confirma a leitura: 10,95% anualizado aparece como *máximo* em 10
dos 11 símbolos. É exatamente 0,01% × 3 × 365 — a taxa de funding padrão da Binance.
Na maior parte do tempo, o funding não está sendo precificado pelo mercado; está no
piso institucional. Buscar 15% nesse regime é buscar o outlier de um processo que
passa 90% do tempo travado no default.

### O número que decide

Ganho bruto ao longo dos 10 dias observados, contra o custo de 0,60%:

| Símbolo | Funding médio anual. | Dias para pagar o custo | Líquido em 30 dias |
|---|---:|---:|---:|
| LINKUSDT | 8,92% | **24,5** | +0,13% |
| DOGEUSDT | 6,76% | 32,4 | −0,04% |
| BTCUSDT | 6,39% | 34,3 | −0,07% |
| UNIUSDT | 6,15% | 35,6 | −0,10% |
| ETHUSDT | 4,58% | 47,8 | −0,22% |
| BNBUSDT | 3,79% | 57,7 | −0,29% |
| SOLUSDT | 3,18% | 69,0 | −0,34% |
| DOTUSDT | 1,13% | 194,4 | −0,51% |

Note que **BNBUSDT — o único que disparou elegibilidade — tem o terceiro pior funding
médio do conjunto.** A regra atual está selecionando picos de volatilidade de funding,
não fontes persistentes de carry. É seleção de outlier, exatamente o erro que a
disciplina estatística do resto do projeto foi construída para evitar.

### O lever real: custo, não sinal

E é aqui que o quadro muda. O custo de 0,60% no protocolo é conservador. Long spot +
short perp na Binance, com ordens maker nas duas pernas:

```
entrada:  spot maker 0,10%  +  perp maker 0,02%  =  0,12%
saída:    spot maker 0,10%  +  perp maker 0,02%  =  0,12%
round trip                                       =  0,24%
```

Refazendo a conta com 0,24%:

| Símbolo | Dias p/ pagar custo (0,60%) | Dias p/ pagar custo (0,24%) | Líquido 30d @0,24% |
|---|---:|---:|---:|
| LINKUSDT | 24,5 | **9,8** | **+0,49%** (≈6,0% a.a.) |
| DOGEUSDT | 32,4 | 13,0 | +0,32% |
| BTCUSDT | 34,3 | 13,7 | +0,29% |
| UNIUSDT | 35,6 | 14,2 | +0,27% |

**Este é o único caminho no sistema inteiro onde a matemática fecha positiva com dados
reais.** Não é espetacular — algo como 4% a 6% ao ano líquido, delta-neutro, com capital
imobilizado nas duas pernas e risco de execução/liquidação real. Mas é positivo, tem
base econômica (você é pago para prover a perna vendida a alavancados comprados), e
não depende de prever preço.

E note qual variável fez a diferença: **não foi o sinal, foi o custo de execução.**
Nenhum ajuste de estratégia produziu isso. Reduzir de 0,60% para 0,24% produziu.

### Ressalvas honestas

- 10 dias de dados. A conclusão sobre persistência tem ~33 blocos independentes de 72h,
  não 2.706. A correlação entre funding atual e futuro (0,273) **não é significativa**
  nesse tamanho efetivo de amostra. Direção sim, magnitude não.
- Carry positivo em regime de funding baixo é fino. Um único evento de liquidação,
  desbalanceamento das pernas ou funding negativo prolongado apaga meses.
- Precisa de 3 a 6 meses de coleta antes de qualquer decisão de capital.

---

## 4. Notícias — nada, agora fora da amostra

A auditoria testou 1.707 reações. Agora há 3.702, com 2.601 concluídas. Testei
**apenas as processadas depois de 08/08** — dados que não existiam quando a hipótese
foi avaliada. É o teste mais limpo possível.

| Direção esperada | Horizonte | n | Excesso médio | t |
|---|---:|---:|---:|---:|
| negativa | 720 min | 51 | +0,117% | 1,71 |
| incerta | 720 min | 86 | +0,111% | 1,57 |
| negativa | 4320 min | 63 | −0,271% | −1,25 |
| incerta | 15 min | 79 | −0,012% | −1,07 |
| negativa | 60 min | 49 | +0,028% | 0,87 |

Maior |t| = **1,71** entre 12 buckets. O esperado por acaso puro com 12 testes é ~2,1.
**Abaixo do ruído, de novo, em dados novos.**

E repete-se o detalhe estranho da auditoria com o sinal ainda invertido: notícia
classificada como "negativa" produz excesso **positivo** de +0,117% em 12h. Duas
leituras possíveis — classificador invertido, ou ruído. Com esse n, não dá para separar,
e mesmo se fosse real, +0,117% contra 0,30% de custo de execução é metade do necessário
só para empatar.

---

## 5. O que fazer — três frentes

Você pediu para transformar o VigIA num sistema que ajude em trades vencedores.
A resposta honesta, tirada dos seus próprios dados: **o maior trade vencedor que o
VigIA já produziu foi não ter operado.** As 143 operações que ele barrou custariam
algo próximo de metade da conta a 1% de risco. O portão fechado é o P&L positivo
do projeto.

Mas isso não é o mesmo que "não há nada a fazer". Há três frentes, em ordem de retorno
esperado sobre esforço.

### Frente 1 — Religar o motor de evidência (hoje, 10 minutos)

Sem isso, nada mais importa: o sistema não aprende mais nada.

```sql
-- Reabrir a coleta prospectiva da FBR (única com média positiva, n=8, precisa de amostra)
update forward_test_config
   set ativo = true, coletar = true, protocolo_status = 'coletando'
 where versao = '2.0.0-fbr';
```

Regra pré-registrada, escrita **antes** de olhar o próximo resultado:

> A FBR coleta até n = 300 sinais fechados sem qualquer alteração de parâmetro.
> Critério de morte: se em n = 300 o t estiver abaixo de 3,6 (Šidák para carga 196),
> a hipótese é encerrada. Nenhuma autorização de ordem em nenhum cenário.

Registre isso em `hipoteses_pesquisa` com `criterio_morte` preenchido antes de religar.
Se você não estiver disposto a matar a FBR em n=300 com t=3,0, não religue — porque aí
não é experimento, é esperança com infraestrutura.

Mantenha as configs 1.1.0, selective e control encerradas. Elas já responderam.

### Frente 2 — Funding carry v2, com a régua certa (esta semana)

É o único módulo com base econômica e o único onde a conta fecha. Três correções:

**a) Elegibilidade por nível persistente, não por pico.** Trocar `funding_anualizado_pct`
instantâneo por média móvel de 72h, e baixar o limiar de 15% para algo compatível com
o regime real (~7%, que é o break-even a custo de 0,24%). A regra atual selecionou o
pior símbolo do conjunto.

**b) Custo realista.** `custo_round_trip_pct` de 0,60% → 0,24% *se e somente se* você
confirmar que consegue executar as duas pernas como maker. Se for taker, mantenha 0,60%
e aceite que o módulo não paga neste regime.

**c) Horizonte honesto.** `holding_dias_assumido = 30` só é defensável se a saída também
for por regra (ex.: sair quando a média de 72h cai abaixo do break-even), não por
expectativa de que a taxa fique parada.

Isso é um protocolo v2.0.0 novo, congelado, com o v1.0.0 preservado para auditoria —
mesmo padrão que você já usa no forward test. Posso escrever a migration.

**Antes disso:** confirme empiricamente o custo real de execução. É o parâmetro que
decide o módulo inteiro, e hoje ele é uma suposição. Duas ordens maker de tamanho
mínimo nas duas pernas respondem isso em 10 minutos e valem mais que qualquer backtest.

### Frente 3 — Aceitar o que o direcional já respondeu

`trend_breakout` e `trend_pullback` estão mortos com significância estatística em dados
prospectivos. Não são "ajustáveis". O edge bruto medido a custo zero foi +0,015 R —
que é zero — em 72 combinações, com apenas 44% delas positivas *sem pagar nada*.

O que resta de valor ali não é a estratégia, é a máquina de matar hipóteses: pré-registro,
correção por múltiplos testes, critério de morte, registro de recusadas, portão de
execução. Cinco hipóteses encerradas em três semanas com rigor que a maioria dos fundos
não tem. **Esse é o ativo.** A questão é para onde apontá-lo.

Direções com base estrutural, em ordem de viabilidade para você:

1. **Funding carry** — implementado, corrigível, matemática fecha a custo maker.
2. **Diferencial de funding entre exchanges** — mesma lógica, spread maior, exige
   segundo venue e gestão de contraparte.
3. **Provisão de liquidez / spread** — ganha o spread, não a direção. Sua infra
   suporta, mas exige latência que Edge Functions não entregam.

O que os três têm em comum: **nenhum depende de prever para onde o preço vai.** Foi
exatamente a premissa que os seus 143 sinais refutaram.

---

## Apêndice — números centrais desta revalidação

```
DIRECIONAL (prospectivo, 143 fechados, 24/07–12/08)
  Média                     −0,475 R      Acumulado  −67,92 R
  Acerto                     25,2%        DP          1,3385
  t agregado                −4,24
  trend_pullback 1h   n=39   −0,694 R     t −3,38   (inalterado)
  trend_breakout 1h   n=64   −0,391 R     t −2,29   (inalterado)
  MFE médio das stopadas    +0,456 R      → gestão de saída não resolve

COLETA
  Configs ativas             0 de 4
  Sinais novos em 4 dias     0
  Execuções do cron          664, todas 'concluido', última hoje 17:10
  carga_de_busca             196  →  piso Šidák t ≈ 3,6

FUNDING CARRY (2.706 snapshots, 11 símbolos, 06–16/08)
  Elegíveis                  7 (0,26%) — todos BNBUSDT, janela de 6h em 09/08
  Pico                       18,53% anual.
  Persistência: ≥15% agora → 8,86% em 24h → 6,30% em 72h
  Melhor funding médio       LINKUSDT 8,92% a.a.
  Break-even @0,60% custo    24,5 dias   (líquido 30d: +0,13%)
  Break-even @0,24% custo     9,8 dias   (líquido 30d: +0,49% ≈ 6,0% a.a.)

NOTÍCIAS (fora da amostra, processadas > 08/08)
  Maior |t|                  1,71 de 12 buckets   (ruído esperado ~2,1)
  Sinal permanece invertido: "negativa" → +0,117% em 12h

CORRIGIDO DESDE A AUDITORIA
  Gap no simulador           ✓  multiStrategyBacktest.ts:1173
  Suporte a venda no motor   ✓  validado no ensaio FBR de 08/08
  Portão de execução         ✓  12/12 permanecem false
```

---

*Análise técnica e estatística de um sistema de software, baseada nos dados que o
próprio sistema coletou. Não é recomendação de investimento e não constitui garantia
de resultado — a evidência aqui é justamente de que resultados passados deste sistema
foram negativos com significância. Decisões sobre capital próprio dependem de fatores
fora do escopo desta análise.*

---

## Apêndice B — correções aplicadas em 16/08/2026

Registro do que foi efetivamente executado depois deste relatório, para que
a leitura futura não confunda diagnóstico com estado atual.

### B.1 Coleta prospectiva religada — config `2.1.0-fbr`

A primeira tentativa foi reativar a `2.0.0-fbr`. O trigger
`impedir_edicao_config_congelada` bloqueou, com a mensagem correta:

```
Uma configuração encerrada não pode ser reativada. Crie nova versão.
```

A regra não foi contornada. A `2.0.0-fbr` foi encerrada em 08/08 e só depois
se observou que sua média era +0,281 R; continuar aquele contador seria
decidir prosseguir **depois** de ver o resultado. Foi criada a `2.1.0-fbr`,
com parâmetros byte a byte idênticos e **contador zerado**. Os 12 sinais
antigos permanecem como amostra encerrada e ficam fora da avaliação.

Hipótese pré-registrada antes da abertura, em `hipoteses_pesquisa`:

| Campo | Valor |
|---|---|
| Amostra mínima | 300 fechados |
| t exigido | 3,469 — de `requiredTStatistic(196)`, não escolhido a dedo |
| Média necessária | ≥ +0,334 R (com dp observado de 1,667) |
| Morte por futilidade | n=150 com soma R ≤ 0 |
| Ritmo observado | 1,71 sinais/dia → n=300 por volta de fev/2027 |

A checagem de futilidade em n=150 só pode matar, nunca aprovar, e por isso
não infla o erro tipo I.

As configs `1.1.0`, `2.0.0-selective` e `2.0.0-control` permanecem
encerradas. Elas já responderam.

### B.2 Funding carry — protocolo 2.0.0

Elegibilidade passou a usar a média móvel de 72h do funding anualizado no
lugar da taxa instantânea. Colunas novas em `funding_carry_snapshots`:
`funding_ma_72h_pct`, `horas_na_media`, `ganho_periodo_pct`,
`carry_liquido_periodo_pct`, `protocolo_versao`. Os 2.706 snapshots
existentes foram preenchidos retroativamente. O protocolo 1.0.0 foi
encerrado com o motivo registrado no próprio campo `observacoes`.

O piso de 9,13% não foi escolhido — é derivado de
`(custo + margem) × 365 / holding`. O custo permanece em **0,60%**, porque
os 0,24% de execução maker ainda são suposição e não medição.

O retro-fill expôs dois casos que ilustram o problema da régua antiga:

| Símbolo | Taxa instantânea | Média 72h |
|---|---:|---:|
| SOLUSDT | +5,27% | **−2,29%** |
| UNIUSDT | −2,86% | **+3,83%** |

A v1 teria lido os dois ao contrário.

### B.3 Edge function `funding-carry` v2.0.0

Publicada, versão 2, ACTIVE. Todos os parâmetros passam a vir do banco; na
v1 eram constantes no código, o que permitia divergência silenciosa entre
`funding_carry_protocol` e o comportamento real. Se não houver protocolo com
status `coletando`, a função retorna 409 em vez de adivinhar.

A função também compara o piso gravado na tabela com o derivado do custo e
aplica o **mais exigente**, sinalizando divergência na resposta. Isso impede
que alguém altere o custo sem recalcular o piso.

`verify_jwt` permanece `false`, como na v1: o cron `vigia-funding-carry-hourly`
autentica por `x-cron-secret` vindo do vault, sem bearer token.

### B.4 Verificação

```
npm run typecheck   →  0 erros
npm run lint        →  0 erros (25 warnings pré-existentes)
npm test            →  55/55 passando
npm run build       →  não verificado neste ambiente: next/font não
                       consegue baixar Geist do Google Fonts. Confirmar
                       localmente antes de publicar.
```

Um bug real apareceu na verificação: quebrar o argumento de `.select()` em
concatenação de strings faz o supabase-js perder a inferência de tipo e cair
para `GenericStringError`, quebrando o cast da linha. Corrigido com string
literal única em `app/page.tsx`.

### B.5 O que NÃO foi alterado

- `daytrade_strategy_execution_policy` — 12/12 continuam `false`. Ambas as
  migrations abortam se alguma linha estiver `true`.
- Nenhum parâmetro de estratégia.
- Nenhuma rota de execução de ordem, em Testnet ou conta real.
- O custo de execução do funding carry, que segue como suposição.

### B.6 Pendência que decide o módulo de carry

Medir o custo real de ida e volta com duas ordens maker de tamanho mínimo
nas duas pernas. É o parâmetro que decide se o carry paga:

| Custo | Piso derivado | Horas elegíveis nas 1.936 medidas |
|---|---:|---:|
| 0,60% (atual, suposto) | 9,13% | 214 — seletivo |
| 0,24% (maker, a confirmar) | 3,65% | 1.196 — deixa de discriminar |

A 0,24% o fator limitante deixa de ser seleção de símbolo e passa a ser
capacidade e risco de execução. São regimes qualitativamente diferentes, e
dez minutos de medição separam um do outro.
