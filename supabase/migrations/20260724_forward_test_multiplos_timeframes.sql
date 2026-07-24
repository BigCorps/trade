-- ============================================================================
-- Teste prospectivo: passa a medir vários timeframes em paralelo.
--
-- JÁ APLICADA NA PRODUÇÃO em 24/07/2026 via MCP, junto com a atualização da
-- configuração para a versão 1.1.0 e a troca do cron diário por horário.
--
-- Motivo: comparar horizontes é informação genuinamente nova, ao contrário de
-- adicionar mais moedas. Criptos são muito correlacionadas entre si — sair de
-- 19 para 300 moedas multiplicaria os sinais por 16 e a informação efetiva por
-- 1,01. Já 4h, 12h e 1d são horizontes distintos.
--
-- O timeframe de 1h entra como CONTROLE NEGATIVO, não como candidato: a
-- validação já o mediu em -0,142R por operação, com nenhum dos 9 símbolos
-- positivo. Se ele aparecer positivo no teste limpo, é sinal de que há erro na
-- análise anterior — e é justamente para isso que serve um controle.
-- ============================================================================

drop view if exists public.forward_test_resumo;

alter table public.forward_test_config add column timeframes text[];

update public.forward_test_config
set timeframes = array['1d', '12h', '4h', '1h'] where ativo;

update public.forward_test_config
set timeframes = array[timeframe] where timeframes is null;

alter table public.forward_test_config alter column timeframes set not null;
alter table public.forward_test_config drop column timeframe;

alter table public.forward_test_signals add column timeframe text;
update public.forward_test_signals set timeframe = '1d' where timeframe is null;
alter table public.forward_test_signals alter column timeframe set not null;

-- Candles de horizontes diferentes podem abrir no mesmo instante (o candle
-- diário e o de 12h das 00:00), então o timeframe entra na chave.
alter table public.forward_test_signals
  drop constraint forward_test_signals_config_id_simbolo_estrategia_candle_op_key;

alter table public.forward_test_signals
  add constraint forward_test_signals_unico
  unique (config_id, timeframe, simbolo, estrategia, candle_open_time);

drop index if exists forward_test_signals_abertos_idx;
drop index if exists forward_test_signals_fechados_idx;

create index forward_test_signals_abertos_idx
  on public.forward_test_signals (config_id, timeframe, simbolo, estrategia)
  where status in ('aguardando_entrada', 'aberto');

create index forward_test_signals_fechados_idx
  on public.forward_test_signals (config_id, timeframe, simbolo, estrategia, candle_open_time desc)
  where status = 'fechado';

create view public.forward_test_resumo as
select
  c.nome, c.versao, s.timeframe, s.estrategia,
  count(*) filter (where s.status = 'fechado') as operacoes_fechadas,
  count(*) filter (where s.status in ('aguardando_entrada', 'aberto')) as em_andamento,
  count(*) filter (where s.status = 'fechado' and s.resultado_r > 0) as ganhos,
  count(*) filter (where s.status = 'fechado' and s.resultado_r < 0) as perdas,
  round(avg(s.resultado_r) filter (where s.status = 'fechado'), 4) as media_r,
  round(sum(s.resultado_r) filter (where s.status = 'fechado'), 4) as soma_r_fixo,
  round(sum(s.resultado_r * s.tamanho_anti) filter (where s.status = 'fechado'), 4) as soma_r_anti,
  min(s.candle_open_time) as primeiro_sinal,
  max(s.candle_open_time) as ultimo_sinal
from public.forward_test_signals s
join public.forward_test_config c on c.id = s.config_id
group by c.nome, c.versao, s.timeframe, s.estrategia;

comment on view public.forward_test_resumo is
  'Acompanhamento do teste prospectivo por horizonte. O timeframe de 1h é controle negativo, não candidato.';

-- Cron passa a rodar de hora em hora para não perder fechamentos de 4h.
-- A rota é idempotente, então execuções extras não duplicam nada.
-- select cron.unschedule('forward-test-diario');
-- select cron.schedule('forward-test-horario', '10 * * * *', $$ ... $$);
