# Validação técnica do motor short — FBR

Data: 2026-08-08

## Escopo

- Estratégia: `failed_breakout_reversal` 2.0.0
- Timeframe: 1h
- Histórico: 360 dias, encerrado em 2026-08-08
- Ativos: BTCUSDT, ETHUSDT, SOLUSDT e BNBUSDT
- Gestões: nenhuma, breakeven, parcial e trailing
- Custos: taxa de 0,10% e slippage de 0,05% por execução
- Total: 16 combinações

## Resultado

Todas as combinações tiveram soma de R e média de R negativas. A melhor foi
ETHUSDT sem gestão, com 16 operações, soma de -2,48R e média de -0,16R. A pior
foi BNBUSDT com trailing, com 12 operações, soma de -5,42R e média de -0,45R.

Este ensaio confirma que o motor consegue simular entradas e saídas short com
custos, gaps e gestão simétrica. Ele não fornece evidência de edge para a FBR.
A estratégia deve permanecer em `shadow`, sem autorização Testnet ou real.

## Disciplina estatística

As 16 combinações contam como testes realizados. A amostra por combinação é
pequena e nenhum resultado é distinguível de sorte; portanto, não há seleção
posterior de ativo ou gestão. A coleta prospectiva congelada pode continuar sem
alterar parâmetros, mas não deve ser promovida por causa deste histórico.

O relatório bruto está em `walkforward-resultados-1h-360d-reais.txt`.
