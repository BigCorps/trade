# VigIA — Auditoria Quantitativa
### Análise independente de viabilidade para operação com capital próprio
**Data:** 07/08/2026 · **Escopo:** repositório `BigCorps/trade`, projeto Supabase `VigIA` (xzqmfcxtvfffgrmqqzdz)

---

## Veredito

**O sistema não está pronto para receber capital real. As evidências não são ambíguas.**

A engenharia é de alto nível. O problema não é o código — é que **o sinal de entrada não tem poder preditivo**, e isso está medido em dados prospectivos, fora de amostra, com significância estatística.

Este relatório mostra exatamente onde está a perda, quanto dela é sinal e quanto é fricção, e o que os dados dizem sobre os caminhos que sobram.

---

## 1. O que os testes prospectivos mostram (a evidência mais forte)

A tabela `forward_test_signals` é o ativo mais valioso do projeto: um experimento congelado, out-of-sample, sem possibilidade de ajuste retroativo. É a evidência de maior qualidade que existe no sistema.

**132 sinais fechados · 24/07/2026 a 07/08/2026**

| Métrica | Valor |
|---|---|
| Resultado médio | **−0,530 R por operação** |
| Resultado acumulado | **−69,94 R** |
| Taxa de acerto | 23,5% (31 de 132) |
| R:R planejado | 2,01 : 1 |

### Por estratégia

| Estratégia | TF | n | Média R | Soma R | Acerto | **t** |
|---|---|---|---|---|---|---|
| trend_pullback | 1h | 39 | −0,694 | −27,06 | 20,5% | **−3,38** |
| trend_breakout | 1h | 64 | −0,391 | −25,06 | 28,1% | **−2,29** |
| trend_breakout | 4h | 12 | −0,600 | −7,20 | 16,7% | −1,74 |
| trend_breakout | 12h | 4 | −1,088 | −4,35 | 0,0% | — |
| trend_pullback | 4h | 7 | −0,316 | −2,21 | 28,6% | −0,56 |

**Nenhuma combinação positiva.** E as duas com amostra relevante têm t **estatisticamente significativo no negativo**.

> Um t de −3,38 corresponde a p < 0,001. Isso não é má sorte, é um resultado replicável. O sistema não é aleatório — ele perde de forma consistente e previsível.

### Tradução para dinheiro

Com risco de 1% do saldo por operação, essas duas semanas custariam algo próximo de **−50% da conta**. Com 2% — o máximo que o `risk.ts` permite — a conta seria destruída.

---

## 2. Onde exatamente está a perda

Decomposição dos −0,530 R:

| Saída | n | Resultado médio | MFE médio | MAE médio |
|---|---|---|---|---|
| Stop | 101 | **−1,241 R** | +0,44 R | −1,32 R |
| Alvo | 31 | **+1,789 R** | +2,46 R | −0,44 R |

Dois problemas independentes, ambos precisam ser resolvidos:

### Problema A — O sinal (55% da perda)

Com o payoff observado (+1,789 / −1,241), o **acerto de equilíbrio é 40,96%**. O sistema entrega **23,5%**.

Mesmo em execução perfeita (alvo entregando 2,01 R, stop custando exatamente 1,00 R), o acerto de equilíbrio seria 33,2% — e ainda faltariam **9,7 pontos percentuais**.

```
EV com execução perfeita = 0,235 × 2,01 − 0,765 × 1,00 = −0,293 R
```

**Nenhum ajuste de custo, alavancagem, sizing ou gestão de saída resolve isso.** O sinal precisaria ser trocado, não afinado.

### O detalhe mais revelador do relatório

**MFE médio das operações stopadas: +0,44 R. Máximo: 1,99 R.**

Operações que perdem quase não andam a favor antes de morrer. Elas vão direto ao stop.

Isso elimina toda uma classe de "soluções" que parecem óbvias:
- Mover para breakeven → não há excursão suficiente para acionar
- Parciais em 1 R → 101 perdedoras nunca chegam lá
- Trailing stop → não há tendência para acompanhar

E os dados de walk-forward confirmam: as quatro gestões (`nenhuma`, `parcial`, `breakeven`, `trailing`) produzem resultados praticamente idênticos. **Gestão de saída não salva entrada ruim.** Isso já foi testado exaustivamente.

### Problema B — A fricção (45% da perda)

```
Fricção = −0,530 − (−0,293) = −0,236 R por operação
```

Duas fontes:

1. **Stop custa 1,241 R em vez de 1,000 R** — derrapagem de **+0,241 R**, ou 24% pior que o modelado.
2. **Alvo entrega 1,789 R em vez de 2,01 R** — déficit de 0,221 R.

O stop médio é **1,647% do preço**. Com taxa 0,1% + slippage 0,05% por perna, o custo de ida e volta é 0,3% do preço = **0,182 R de imposto fixo por operação**.

> Operar em 1h com stop de 1,6% significa entregar ~18% de cada unidade de risco à corretora antes de qualquer decisão de mercado. É uma matemática que exige um edge bruto excepcional só para empatar.

---

## 3. Bug de modelagem identificado

`multiStrategyBacktest.ts` aplica slippage como percentual fixo sobre o preço do stop (`applyBacktestSellSlippage`). Não há modelagem de **gap** — o caso em que o candle abre além do stop.

**Consequência:** o backtest assume stop custando ~1,05 R. A realidade prospectiva é 1,241 R.

Isso explica a degradação backtest → produção:

| Fonte | Média R |
|---|---|
| Backtest 1h/360d (custos reais) | −0,189 |
| Forward test ao vivo | −0,530 |
| **Gap** | **−0,341** |

Parte é regime de mercado, mas **parte é otimismo estrutural do simulador**. Qualquer backtest futuro herda esse viés enquanto o gap não for modelado.

**Correção:** quando `candle.open` ultrapassar o stop, preencher na abertura, não no preço do stop.

---

## 4. O backtest histórico já dizia a mesma coisa

### 4.1 Custo zero vs custo real — 1h/360d, 72 combinações

Esta comparação isola sinal de fricção. É o diagnóstico mais elegante do repositório.

| Cenário | Média R/trade | Combinações positivas |
|---|---|---|
| **Bruto** (custo zero) | **+0,015** | 32 / 72 (44%) |
| Custo médio | −0,199 | — |
| **Líquido** (custos reais) | **−0,189** | **1 / 72** |

**+0,015 R bruto é zero.** E apenas 44% das combinações são positivas mesmo sem pagar nada — pior que cara-ou-coroa.

A leitura correta não é "bom sinal comido pelos custos". É: **não há sinal, e ainda por cima há custo**.

### 4.2 Correção por múltiplos testes

Testar 72 combinações e escolher a melhor **garante** um resultado bonito, mesmo em dados puramente aleatórios. É preciso comparar o melhor t observado com o que o ruído produziria.

| Bateria | N | Melhor t | t esperado do ruído | p (Šidák) | Conclusão |
|---|---|---|---|---|---|
| 1d / 2900d | 64 | +2,04 | **+2,20** | 0,737 | Não significativo |
| 4h / 1100d | 72 | +1,75 | **+2,24** | 0,947 | Não significativo |
| 1d / 900d (até 2023) | 72 | +1,64 | **+2,24** | 0,976 | Não significativo |

**Em todas as três baterias, o melhor resultado está abaixo do que o acaso produziria.**

Isso é mais forte do que "não conseguimos provar edge". O melhor resultado é *menos impressionante que ruído puro* — consistente com um sistema cujo edge verdadeiro é ligeiramente negativo.

O TRXUSDT com +17,18 R e t = +2,04 parece o vencedor da tabela. Ele não é. Em 64 sorteios, o máximo esperado por acaso é 2,20.

> **Nota de crédito:** o próprio sistema já marca essas linhas como *"indistinguível de sorte"*. Quem escreveu isso entendeu o problema. A disciplina estatística está no código — falta apenas aceitar o que ela está dizendo.

---

## 5. Funding carry — o único módulo com base econômica real

Diferente de análise técnica, funding carry não tenta prever preço. Captura um fluxo de pagamento estrutural entre comprados e vendidos em perpétuos, com posição delta-neutra.

**385 snapshots · 11 símbolos · 06–08/08/2026**

| Símbolo | Funding anual. | **Carry líquido anual.** | Elegível |
|---|---|---|---|
| UNIUSDT | 8,33% | **+1,03%** | 0 |
| LINKUSDT | 5,76% | −1,54% | 0 |
| BTCUSDT | 4,92% | −2,38% | 0 |
| SOLUSDT | 3,62% | −3,68% | 0 |
| ETHUSDT | 2,44% | −4,86% | 0 |
| XRPUSDT | −1,59% | −8,89% | 0 |
| AVAXUSDT | −2,81% | −10,11% | 0 |

**0 de 385 snapshots elegíveis. 10 de 11 símbolos com carry líquido negativo.**

O módulo está funcionando corretamente e dando a resposta certa: **o regime atual de funding não paga o custo de montar a operação.**

Mas a lógica é sólida e a conclusão é condicional, não permanente. Funding carry vira atrativo quando o funding anualizado passa de ~15% — o que acontece em picos de euforia alavancada, tipicamente algumas janelas por ano.

**Este é o único componente do stack que merece continuar rodando.** Custo marginal ≈ zero, e ele avisa quando a janela abrir.

⚠️ Ressalva: 2 dias de dados. Antes de qualquer decisão, é preciso um histórico de vários meses para mapear com que frequência o regime elegível realmente aparece.

---

## 6. Módulo de notícias — sem sinal detectável

**5.130 eventos · 1.707 reações concluídas · GDELT**

Retorno excedente por direção esperada e horizonte (buckets com n ≥ 25):

| Direção | Horizonte | n | Excesso médio | t |
|---|---|---|---|---|
| positiva | 60 min | 34 | −0,052% | −1,52 |
| incerta | 240 min | 105 | +0,071% | +1,46 |
| negativa | 4320 min | 110 | −0,107% | −1,04 |
| negativa | 60 min | 142 | −0,013% | −0,78 |

Maior |t| entre 15 buckets: **1,52**. O esperado por ruído puro com 15 testes é ~2,13.

Dois problemas independentes:

1. **Sem significância estatística** — nada acima do acaso.
2. **Magnitude abaixo do custo** — mesmo se o sinal de +0,071% fosse real, o custo de ida e volta é 0,3%. **O efeito é 4× menor que o custo de capturá-lo.**

Detalhe notável: eventos classificados como "positiva" têm excesso *negativo* em 60 min. O classificador pode estar invertido, ou pode ser ruído. Com n = 34, não dá para distinguir.

---

## 7. O que a engenharia acertou

Isto merece registro explícito, porque é raro e é o que torna o projeto recuperável.

**Este código foi construído para descobrir a verdade, não para confirmar uma esperança.** A maioria dos sistemas de trading é o contrário.

| Prática | Onde |
|---|---|
| Experimento congelado, imutável | `forward_test_config` — "para mudar, crie versão nova" |
| Auditoria de execuções do cron | `forward_test_runs` (419 registros) — impede lacunas silenciosas |
| Checkpoints recuperáveis | `forward_test_checkpoints` — sem duplicar sinais |
| Registro de recusadas e expiradas | `opportunity_outcomes` — evita viés de sobrevivência |
| Portão de execução explícito | `daytrade_strategy_execution_policy` — **12/12 desabilitadas** |
| Custo zero como diagnóstico | `walkforward-batch.ts` — "NÃO é cenário operável" |
| Rotulagem honesta | "indistinguível de sorte" na própria saída |
| Sizing conservador | `risk.ts` — máx. 2%, arredonda sempre para baixo |
| Entrada na abertura seguinte | Elimina look-ahead bias |

Poucos sistemas retail registram os resultados das oportunidades **recusadas**. Esse detalhe sozinho indica maturidade metodológica.

**O portão está fechado e deve continuar fechado.** Ele funcionou exatamente como projetado: impediu que 132 operações perdedoras virassem dinheiro real.

---

## 8. Recomendações

### Imediato

**1. Não habilitar execução real.** As 12 linhas de política permanecem `false`. O forward test já custou 69,94 R — em papel. Habilitar agora converte perda medida em perda realizada.

**2. Manter o forward test rodando.** Custo marginal zero, e é o único gerador de evidência confiável. Deixe chegar a 300+ sinais.

**3. Corrigir o gap no simulador.** Sem isso, todo backtest futuro nasce otimista em ~0,2 R.

**4. Manter o funding carry coletando.** É o único módulo com base econômica e o custo é desprezível.

### Se quiser continuar buscando edge direcional

O erro metodológico a evitar é o que já aconteceu: testar 72 combinações e escolher a melhor.

- **Pré-registre uma hipótese** antes de olhar os dados. Uma.
- **Corrija por múltiplos testes** (Šidák/Bonferroni, ou Deflated Sharpe Ratio de López de Prado).
- **Exija significância no prospectivo**, nunca no histórico.
- **Defina o critério de morte antes de começar**: "se após N sinais o t < 2,0 corrigido, a estratégia morre."

Um limiar honesto: para um edge de +0,1 R/trade com desvio de 1,3 R, detectar t = 2 exige **~680 operações**. Esse é o custo real de provar um edge pequeno.

### O ponto que um consultor honesto precisa fazer

Análise técnica direcional em majors de cripto é o espaço mais eficientemente arbitrado que existe para o investidor individual. Você compete com firmas que têm colocação, dados de fluxo de ordens e custos de execução uma ordem de grandeza menores. O edge bruto medido — +0,015 R — é consistente com essa realidade estrutural, não com um erro de implementação.

Isso não significa que operar seja impossível. Significa que **os caminhos com base estrutural são diferentes dos que este sistema persegue hoje**:

- **Carry / basis** (já implementado) — captura fluxo estrutural, não previsão. Delta-neutro. Limitado por capacidade e janela de regime.
- **Provisão de liquidez / market making** — ganha o spread, não a direção. Exige a infraestrutura que você já tem.
- **Diferencial de funding entre exchanges** — exige múltiplos venues e gestão de risco de contraparte.

O que estes têm em comum: **nenhum depende de prever para onde o preço vai.**

E vale considerar seriamente: dado que a infraestrutura é excelente e o alpha é ausente, o maior valor deste ativo pode não estar em operar com ele.

---

## Apêndice — Números centrais

```
FORWARD TEST (out-of-sample, 132 operações, 15 dias)
  Média                        −0,530 R
  Acumulado                    −69,94 R
  Acerto                        23,5%
  Acerto de equilíbrio          40,96%
  Déficit                      −17,5 p.p.
  t (trend_pullback 1h)         −3,38   ← significativo
  t (trend_breakout 1h)         −2,29   ← significativo

DECOMPOSIÇÃO
  Sinal (execução perfeita)    −0,293 R   (55%)
  Fricção                      −0,236 R   (45%)
    · derrapagem no stop       +0,241 R além de 1 R
    · déficit no alvo           0,221 R
  MFE médio das perdedoras     +0,44 R    ← sem seguimento

BACKTEST 1h/360d (72 combinações)
  Bruto                        +0,015 R/trade   32/72 positivas
  Custo                        −0,199 R/trade
  Líquido                      −0,189 R/trade    1/72 positivas

MÚLTIPLOS TESTES
  1d/2900d   melhor t +2,04  vs ruído +2,20   p=0,737
  4h/1100d   melhor t +1,75  vs ruído +2,24   p=0,947
  1d/900d    melhor t +1,64  vs ruído +2,24   p=0,976

FUNDING CARRY      0/385 elegíveis · 10/11 símbolos negativos
NOTÍCIAS           maior |t| 1,52 de 15 buckets (ruído ~2,13)
                   efeito 4× menor que o custo de execução
```

---

*Auditoria baseada em 11 arquivos de walk-forward (556 combinações), 132 sinais prospectivos fechados, 385 snapshots de funding, 1.707 reações a notícias e ~72.000 linhas de código.*

*Este documento é análise técnica e estatística de um sistema de software. Não é recomendação de investimento. Decisões sobre alocação de capital próprio dependem de fatores — tolerância a risco, situação patrimonial, objetivos, tributação — que estão fora do escopo desta auditoria.*
