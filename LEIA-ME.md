# Backtest de estratégias novas — ligado (parcialmente)

**Resultado: 1 das 2 estratégias v2 agora pode ser testada contra histórico.
A outra não pode, e o motivo importa.**

---

## O que mudou

`confirmed_trend_continuation` agora roda no motor de backtest. Você pode
testá-la contra 2.900 dias em minutos:

```bash
npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT,SOLUSDT confirmed_trend_continuation reais
```

Antes disso era impossível — a estratégia existia em `lib/`, mas só o motor do
teste prospectivo a conhecia. A única forma de aprender sobre ela era esperar.

---

## ⚠️ O que NÃO foi ligado, e por quê

**`failed_breakout_reversal` opera VENDIDO. O motor de backtest é
exclusivamente comprado.**

Verificação:

```
direção de cada estratégia:
  trendBreakout ................. long
  trendPullback ................. long
  squeezeBreakout ............... long
  rangeMeanReversion ............ long
  confirmedTrendContinuation .... long
  failedBreakoutReversal ........ SHORT   ← aqui

ocorrências de 'short' em multiStrategyBacktest.ts (2.612 linhas): 0
```

O contrato interno do motor declara `direction: 'long'` como literal fixo, não
como variável. Toda a matemática — stop abaixo da entrada, alvo acima,
slippage adversa para baixo na saída — assume compra.

**Registrar a estratégia vendida sem reescrever essa matemática produziria
backtests que rodam, geram tabelas com aparência normal, e estão com o sinal
invertido.** Um backtest errado é pior que backtest nenhum: o primeiro
convence, o segundo pelo menos deixa você em dúvida.

Deixei um teste que trava isso:

```ts
test('failed_breakout_reversal NÃO foi registrada — motor é apenas comprado')
```

Se um dia alguém registrar a estratégia sem antes dar suporte a venda, o teste
falha e explica o motivo.

### O que seria preciso para liberar

Suporte a venda no motor: inverter entrada/saída no cálculo de resultado,
inverter a checagem de stop e alvo (`open >= stop` em vez de `<=`), inverter a
direção do slippage, e ajustar taxa e sizing. É um trabalho de verdade no
núcleo do sistema, com risco alto de erro silencioso. Merece uma sessão
dedicada e uma bateria de testes que compare posições compradas e vendidas
espelhadas.

---

## Como usar o backtest sem repetir o erro antigo

Isto é o mais importante deste documento.

**Use o histórico para MATAR, não para APROVAR.**

A assimetria é o que torna o teste válido:

- **Resultado ruim no histórico** → evidência forte. Uma estratégia que perde
  em 8 anos de dados dificilmente vai ganhar nos próximos 50 dias. **Mate hoje
  e economize a espera.**
- **Resultado bom no histórico** → evidência fraca. Pode ser regime, pode ser
  sorte, e a estratégia foi desenhada por alguém que já viu esses dados.
  **Continua exigindo confirmação prospectiva.**

Essa assimetria é o que faz o backtest valer a pena mesmo com todas as
ressalvas: ele economiza semanas quando a resposta é "não", e não engana
quando a resposta é "talvez".

### Regra operacional

Rode **os parâmetros exatos que já estão congelados** em
`forward_test_config` (versão 2.0.0-selective/control). Não ajuste nada para
melhorar o resultado — no instante em que você ajusta, vira busca, e a régua
sobe para todas as hipóteses.

Se rodar mais de uma variação, some em `carga_de_busca`:

```sql
update configuracao_pesquisa
   set valor_inteiro = <atual + variações>, atualizado_em = now()
 where chave = 'carga_de_busca';
```

Hoje está em **108**, piso de ruído **2,39**.

---

## Arquivos alterados

```
lib/daytrade/strategies/index.ts                    +33 −1
lib/daytrade/strategies/backtestAdapter.ts         +106 −8
lib/daytrade/strategies/confirmedTrendContinuation.ts +9
scripts/walkforward-batch.ts                         +4
tests/daytrade/registro-estrategias.test.ts        (novo)
```

### O que cada alteração faz

**`index.ts`** — registra a estratégia com `executionMode: 'shadow'` e
`authorizedForAutomaticOrders: false`. Ela pode ser calculada e testada, nunca
criar ordem.

**`backtestAdapter.ts`** — três pontos de despacho (avaliação, candles de
aquecimento, distância máxima de entrada) mais quatro funções de normalização
de diagnósticos.

A normalização foi necessária porque os playbooks novos declaram `diagnostics`
como mapa aberto, enquanto o contrato do backtest exige campos tipados. **Fiz
a ponte no adaptador em vez de alterar a estratégia**, porque ela está
coletando dados prospectivos agora e mudar sua saída invalidaria o
experimento em curso.

**`confirmedTrendContinuation.ts`** — expõe o resolvedor de opções que já
existia como função privada. Nenhuma mudança de comportamento: é a mesma
função, agora exportada. Exportar em vez de duplicar os defaults evita que as
duas cópias divirjam com o tempo.

**`walkforward-batch.ts`** — libera a estratégia e estende o filtro de stop
mínimo a ela.

---

## Verificação

```
npm test        →  51/51 passando (42 anteriores + 9 novos)
npm run typecheck  →  0 erros
npm run lint    →  0 erros nos arquivos tocados
npm run build   →  compilado com sucesso
```

### O teste que mais importa

```ts
test('nenhuma estratégia ganhou autorização de ordem automática', () => {
  assert.equal(EXECUTABLE_DAYTRADE_STRATEGY_IDS.length, 0);
});
```

Se algum dia isso falhar, alguma estratégia passou a poder criar ordens sem
passar pelo portão estatístico. É a trava mais importante do arquivo.

Os outros verificam que as quatro estratégias originais continuam registradas
e avaliando igual — a alteração é aditiva, não alterou nada existente.

---

## Sugestão de primeiro uso

```bash
# 1. Cesta ampla, mesmo timeframe do experimento em curso
npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT confirmed_trend_continuation reais

# 2. O mesmo em horizonte maior — onde o custo pesa menos
npx tsx scripts/walkforward-batch.ts 1d 900 BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT confirmed_trend_continuation reais
```

Antes de olhar o resultado, decida o que fará com ele. Se a resposta for "se
der ruim eu mudo um parâmetro e rodo de novo", o teste não vale nada — e é
melhor não rodar.

Compare com o cenário `zero` para separar sinal de custo:

```bash
npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT confirmed_trend_continuation zero
```

Se o resultado bruto (custo zero) já for próximo de zero, o problema é o
sinal e nenhuma redução de taxa resolve. Foi exatamente esse teste que revelou
o diagnóstico da v1: edge bruto de +0,015 R, praticamente nada.

---

*Alteração em código de análise. Nenhuma rota de execução de ordens foi
habilitada. Não é recomendação de investimento.*
