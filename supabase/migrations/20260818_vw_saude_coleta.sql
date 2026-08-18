-- =========================================================================
-- vw_saude_coleta — o motor está vivo?
--
-- Aplicada no projeto xzqmfcxtvfffgrmqqzdz em 2026-08-18.
-- Este arquivo existe para que o histórico do repositório bata com o
-- estado real do banco.
--
-- PROBLEMA QUE ISTO RESOLVE
-- O painel mostra sinais e resultados. Num experimento que produz 1 a 3
-- sinais por dia e leva meses, a tela fica vazia por semanas ESTANDO
-- PERFEITA. Em 16/08/2026 o cron `forward-test-horario` ficou desligado
-- por horas e o sintoma na tela foi idêntico ao de um dia calmo: nada
-- aparecendo. Não havia como distinguir motor parado de mercado sem setup.
--
-- Saúde do motor e chegada de sinal são coisas diferentes e precisam de
-- indicadores diferentes. Esta view responde só a primeira: o motor rodou,
-- processou o que devia, e falhou em quê.
--
-- Consumida por app/coleta/page.tsx.
-- =========================================================================

create or replace view public.vw_saude_coleta
with (security_invoker=true) as
with ultimo as (
  select r.*, c.versao
  from public.forward_test_runs r
  join public.forward_test_config c on c.id = r.config_id
  order by r.iniciado_em desc
  limit 1
),
janela as (
  select
    count(*) as runs_24h,
    count(*) filter (where jsonb_array_length(falhas) > 0) as runs_com_falha_24h,
    sum(sinais_criados) as sinais_criados_24h,
    sum(sinais_resolvidos) as sinais_resolvidos_24h,
    round(avg(duracao_ms)) as duracao_media_ms
  from public.forward_test_runs
  where iniciado_em > now() - interval '24 hours'
)
select
  u.versao as config_versao,
  u.iniciado_em as ultimo_run,
  round(extract(epoch from (now() - u.iniciado_em)) / 60.0)::integer
    as minutos_desde_ultimo_run,
  u.pares_esperados,
  u.pares_processados,
  u.duracao_ms as ultima_duracao_ms,
  jsonb_array_length(u.falhas) as falhas_no_ultimo_run,
  u.falhas as detalhe_falhas,
  j.runs_24h,
  j.runs_com_falha_24h,
  j.sinais_criados_24h,
  j.sinais_resolvidos_24h,
  j.duracao_media_ms,
  -- O cron é horário. Acima de 90 minutos sem rodar, algo está errado.
  -- Este é o alarme que faltava em 16/08.
  case
    when extract(epoch from (now() - u.iniciado_em)) / 60.0 > 90
      then 'MOTOR PARADO'
    when u.pares_processados < u.pares_esperados
      then 'PROCESSAMENTO INCOMPLETO'
    when jsonb_array_length(u.falhas) > 0
      then 'RODANDO COM FALHAS'
    else 'SAUDAVEL'
  end as situacao_motor
from ultimo u cross join janela j;

grant select on public.vw_saude_coleta to authenticated, service_role;
