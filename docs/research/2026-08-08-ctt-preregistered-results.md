# CTT 2.0.0 — decisão pré-registrada de 2026-08-08

## Regra decidida antes dos resultados

- Histórico negativo: encerrar a hipótese sem ajustar parâmetros.
- Histórico positivo: manter apenas o forward test; nunca autorizar ordens.

## Baterias executadas

Cada bateria avaliou cinco símbolos e quatro regras de gestão, totalizando 20
combinações. As três baterias acrescentaram 60 à carga de busca, que passou de
108 para 168.

| Timeframe | Horizonte | Custos | Operações somadas | Soma R | Média R ponderada | Combinações positivas |
|---|---:|---|---:|---:|---:|---:|
| 1h | 360 dias | Reais | 359 | -135,18 | -0,3765 | 1 de 20 |
| 1h | 360 dias | Zero | 357 | -64,71 | -0,1813 | 6 de 20 |
| 1d | 900 dias | Reais | 16 | +16,95 | +1,0594 | 5 de 8 não vazias |

As quatro regras de gestão reutilizam os mesmos sinais; portanto, a soma de
operações serve apenas como resumo operacional e não como tamanho de amostra
independente.

## Decisão

`confirmed_trend_continuation` foi encerrada. A bateria sem custos permaneceu
negativa no agregado, mostrando que reduzir taxa não cria vantagem no sinal de
1h. O resultado diário não aprova nada: houve no máximo duas operações por
combinação preenchida.

As configurações `2.0.0-control` e `2.0.0-selective` permanecem no banco para
auditoria, com coleta encerrada. Testnet e real continuam bloqueados.
