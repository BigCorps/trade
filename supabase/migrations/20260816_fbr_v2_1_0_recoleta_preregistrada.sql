-- =========================================================================
-- Recoleta prospectiva da failed_breakout_reversal — versão 2.1.0-fbr
--
-- Aplicada no projeto xzqmfcxtvfffgrmqqzdz em 2026-08-16.
-- Este arquivo existe para que o histórico do repositório bata com o
-- estado real do banco.
--
-- CONTEXTO
-- Em 16/08/2026 as quatro configurações do teste prospectivo estavam com
-- ativo=false e coletar=false. O cron seguia rodando 24x/dia sem gerar
-- evidência: zero sinais novos desde 12/08.
--
-- POR QUE UMA VERSÃO NOVA, E NÃO REATIVAR A 2.0.0-fbr
-- A tentativa de reativar foi corretamente bloqueada pelo trigger
-- impedir_edicao_config_congelada. A regra está certa e não deve ser
-- contornada: a 2.0.0-fbr foi encerrada em 08/08 e só depois observou-se
-- que sua média era +0,281 R. Continuar aquele contador seria decidir
-- prosseguir DEPOIS de ver o resultado — que é exatamente a seleção que a
-- disciplina do projeto existe para impedir.
--
-- Consequência aceita: o contador recomeça em ZERO. Os 12 sinais da
-- 2.0.0-fbr ficam preservados como amostra encerrada e NÃO entram na
-- avaliação da 2.1.0. Isso torna o experimento mais caro e mais limpo.
--
-- Parâmetros idênticos ao congelamento original. Nenhuma política de
-- execução é alterada.
-- =========================================================================

-- 1. Pré-registro da hipótese, ANTES de abrir a coleta --------------------
insert into public.hipoteses_pesquisa (
  nome, pergunta, fundamento_economico,
  simbolos, timeframes, estrategias,
  amostra_minima, t_minimo_exigido, criterio_morte,
  combinacoes_testadas, status
)
select
  'FBR short 2.1.0 — coleta prospectiva até n=300',
  'O rompimento fracassado operado vendido entrega retorno médio positivo em R, fora de amostra, em cesta ampla de perpétuos?',
  'Rompimentos que falham concentram participantes comprados presos acima do preço. A liquidação dessas posições é fluxo forçado de venda, previsível em direção ainda que não em magnitude. A hipótese não exige prever tendência: exige apenas que a falha do rompimento seja informativa sobre desequilíbrio de posicionamento. É a única estratégia do repositório cujo fundamento não depende de previsão direcional pura.',
  array['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','TRXUSDT','DOTUSDT','ATOMUSDT','NEARUSDT','FILUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','ETCUSDT','XLMUSDT','UNIUSDT','AAVEUSDT','ALGOUSDT','VETUSDT','ICPUSDT','RUNEUSDT','SUIUSDT','SEIUSDT','TIAUSDT'],
  array['1h','4h'],
  array['failed_breakout_reversal'],
  300,
  3.469,
  'AMOSTRA: apenas sinais da config 2.1.0-fbr. Os 12 sinais da 2.0.0-fbr sao amostra encerrada e ficam de fora. '
  || 'MORTE POR FUTILIDADE (n=150 fechados): se a soma de R for <= 0, encerrar imediatamente. '
  || 'Esta checagem so pode matar, nunca aprovar, e por isso nao infla o erro tipo I. '
  || 'MORTE POR INSUFICIENCIA (n=300 fechados): se t < 3,469, encerrar. '
  || 'O limiar vem de requiredTStatistic(196) com a carga_de_busca atual; se a carga subir ate la, recalcular e usar o maior. '
  || 'Com o dp observado de 1,667, passar em n=300 exige media >= +0,334 R por operacao. '
  || 'PROIBIDO durante a coleta: alterar parametro da estrategia, trocar cesta de simbolos, trocar timeframe, '
  || 'filtrar simbolos por desempenho parcial, ou consultar o resultado parcial para decidir se continua. '
  || 'Qualquer alteracao encerra este experimento e exige nova versao com contador zerado. '
  || 'APROVACAO NAO AUTORIZA ORDEM: passar no criterio libera apenas a discussao de Testnet, nunca conta real. '
  || 'RITMO ESPERADO: 1,71 sinais/dia observados, logo n=300 chega por volta de fevereiro de 2027.',
  196,
  'coletando'
where not exists (
  select 1 from public.hipoteses_pesquisa
  where nome = 'FBR short 2.1.0 — coleta prospectiva até n=300'
);

-- 2. Nova configuração, parâmetros idênticos, contador zerado -------------
insert into public.forward_test_config (
  nome, versao, estrategias, simbolos, timeframes,
  fee_rate_pct, slippage_pct, max_next_open_distance_atr,
  grupo_experimento, strategy_options,
  ativo, coletar, amostra_alvo, protocolo_status, observacoes
)
select
  'Rompimento fracassado — cesta ampla (recoleta)',
  '2.1.0-fbr',
  c.estrategias, c.simbolos, c.timeframes,
  c.fee_rate_pct, c.slippage_pct, c.max_next_open_distance_atr,
  'reversal_broad_v2', c.strategy_options,
  true, true, 300, 'coletando',
  'Recoleta aberta em 2026-08-16 sob hipótese pré-registrada '
  || '"FBR short 2.1.0 — coleta prospectiva até n=300". Parâmetros byte a byte '
  || 'idênticos à 2.0.0-fbr congelada em 2026-08-06. Contador reiniciado em zero '
  || 'por decisão metodológica: a 2.0.0 foi encerrada antes de se observar sua média. '
  || 'Alvo n=300, t exigido 3,469 (Šidák, carga 196). Nenhuma ordem autorizada.'
from public.forward_test_config c
where c.versao = '2.0.0-fbr'
  and not exists (
    select 1 from public.forward_test_config x where x.versao = '2.1.0-fbr'
  );

-- 3. Trava de segurança: o portão de execução continua fechado ------------
do $$
declare habilitadas integer;
begin
  select count(*) into habilitadas
    from public.daytrade_strategy_execution_policy
   where execution_enabled;
  if habilitadas > 0 then
    raise exception 'Portao de execucao aberto em % linha(s). Migration abortada.', habilitadas;
  end if;
end $$;
