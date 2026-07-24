begin;

-- ============================================================================
-- 1. Congelamento real da configuração prospectiva.
-- IF/THEN é PL/pgSQL e, por isso, precisa ficar dentro desta função.
-- ============================================================================

create or replace function public.impedir_edicao_config_congelada()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'Configuração de teste prospectivo não pode ser excluída. Desative-a (ativo = false) para preservar o histórico.';
  end if;

  -- As regras e os timestamps do protocolo são imutáveis, inclusive quando a
  -- versão é desativada. Observações continuam editáveis por serem documentação.
  if
    old.nome is distinct from new.nome
    or old.versao is distinct from new.versao
    or old.timeframes is distinct from new.timeframes
    or old.estrategias is distinct from new.estrategias
    or old.simbolos is distinct from new.simbolos
    or old.fee_rate_pct is distinct from new.fee_rate_pct
    or old.slippage_pct is distinct from new.slippage_pct
    or old.max_next_open_distance_atr is distinct from new.max_next_open_distance_atr
    or old.congelado_em is distinct from new.congelado_em
    or old.criado_em is distinct from new.criado_em
  then
    raise exception
      'Regras congeladas não podem ser alteradas. Desative esta versão e crie outra configuração.';
  end if;

  -- Uma versão encerrada não volta a ser ativa: reativá-la misturaria períodos.
  if not old.ativo and new.ativo then
    raise exception
      'Uma versão encerrada não pode ser reativada. Crie uma nova versão.';
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 2. Política autoritativa de execução por estratégia.
-- Ausência de aprovação significa bloqueio (fail closed).
-- ============================================================================

create table if not exists public.daytrade_strategy_execution_policy (
  strategy text not null,
  strategy_version text not null default '*',
  execution_environment text not null
    check (execution_environment in ('testnet', 'real')),
  execution_enabled boolean not null default false,
  reason text not null,
  validated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (strategy, strategy_version, execution_environment)
);

comment on table public.daytrade_strategy_execution_policy is
  'Fonte autoritativa para liberar estratégias em Testnet ou conta real. Sem linha habilitada, toda execução é recusada.';

alter table public.daytrade_strategy_execution_policy enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'daytrade_strategy_execution_policy'
      and policyname = 'politica de execucao visivel para autenticados'
  ) then
    create policy "politica de execucao visivel para autenticados"
      on public.daytrade_strategy_execution_policy
      for select
      to authenticated
      using (true);
  end if;
end;
$$;

grant select on public.daytrade_strategy_execution_policy to authenticated;

insert into public.daytrade_strategy_execution_policy (
  strategy,
  strategy_version,
  execution_environment,
  execution_enabled,
  reason,
  validated_at,
  updated_at
)
select
  s.strategy,
  '*',
  e.environment,
  false,
  'Estratégia em modo shadow; aguarda aprovação estatística prospectiva.',
  null,
  now()
from (
  values
    ('trend_breakout'),
    ('trend_pullback'),
    ('squeeze_breakout'),
    ('range_mean_reversion')
) as s(strategy)
cross join (
  values ('testnet'), ('real')
) as e(environment)
on conflict (strategy, strategy_version, execution_environment)
do update set
  execution_enabled = false,
  reason = excluded.reason,
  validated_at = null,
  updated_at = now();

create or replace function public.daytrade_strategy_execution_allowed(
  p_strategy text,
  p_strategy_version text,
  p_execution_environment text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select policy.execution_enabled
    from public.daytrade_strategy_execution_policy policy
    where policy.strategy = p_strategy
      and policy.execution_environment = p_execution_environment
      and policy.strategy_version in (
        coalesce(nullif(p_strategy_version, ''), '*'),
        '*'
      )
    order by
      (policy.strategy_version = coalesce(nullif(p_strategy_version, ''), '*')) desc
    limit 1
  ), false);
$$;

create or replace function public.assert_daytrade_strategy_execution_allowed(
  p_strategy text,
  p_strategy_version text,
  p_execution_environment text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
begin
  if p_execution_environment not in ('testnet', 'real') then
    raise exception using
      errcode = 'P0001',
      message = 'STRATEGY_EXECUTION_ENVIRONMENT_INVALID',
      detail = format('Ambiente inválido: %s', coalesce(p_execution_environment, 'null'));
  end if;

  if not public.daytrade_strategy_execution_allowed(
    p_strategy,
    p_strategy_version,
    p_execution_environment
  ) then
    select policy.reason
    into v_reason
    from public.daytrade_strategy_execution_policy policy
    where policy.strategy = p_strategy
      and policy.execution_environment = p_execution_environment
      and policy.strategy_version in (
        coalesce(nullif(p_strategy_version, ''), '*'),
        '*'
      )
    order by
      (policy.strategy_version = coalesce(nullif(p_strategy_version, ''), '*')) desc
    limit 1;

    raise exception using
      errcode = 'P0001',
      message = 'STRATEGY_SHADOW_BLOCKED',
      detail = format(
        'Estratégia %s v%s bloqueada em %s. %s',
        coalesce(p_strategy, 'null'),
        coalesce(nullif(p_strategy_version, ''), '*'),
        p_execution_environment,
        coalesce(v_reason, 'Nenhuma aprovação de execução foi cadastrada.')
      );
  end if;
end;
$$;

revoke all on function public.daytrade_strategy_execution_allowed(text, text, text)
  from public, anon;
revoke all on function public.assert_daytrade_strategy_execution_allowed(text, text, text)
  from public, anon, authenticated;
grant execute on function public.daytrade_strategy_execution_allowed(text, text, text)
  to authenticated, service_role;
grant execute on function public.assert_daytrade_strategy_execution_allowed(text, text, text)
  to service_role;

-- Bloqueia criação de novas oportunidades mesmo que uma Edge Function esteja
-- com uma cópia antiga do registro de estratégias.
create or replace function public.enforce_trade_opportunity_strategy_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.opportunity_type = 'entry'
     and new.source_type = 'daytrade_setup' then
    perform public.assert_daytrade_strategy_execution_allowed(
      new.strategy,
      new.strategy_version,
      new.execution_environment
    );
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_trade_opportunity_strategy_policy()
  from public, anon, authenticated;

drop trigger if exists trade_opportunities_strategy_policy_guard
  on public.trade_opportunities;
create trigger trade_opportunities_strategy_policy_guard
before insert or update of
  source_type,
  opportunity_type,
  strategy,
  strategy_version,
  execution_environment
on public.trade_opportunities
for each row
execute function public.enforce_trade_opportunity_strategy_policy();

-- Última trava antes do dimensionamento. As rotas manuais e automáticas criam
-- esta decisão antes de chamar a Binance; uma estratégia shadow não passa daqui.
create or replace function public.enforce_position_sizing_strategy_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_strategy text;
  v_strategy_version text;
begin
  if new.daytrade_setup_id is not null then
    select setup.strategy, setup.strategy_version
    into v_strategy, v_strategy_version
    from public.daytrade_setups setup
    where setup.id = new.daytrade_setup_id;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'DAYTRADE_SETUP_NOT_FOUND_FOR_SIZING';
    end if;
  elsif new.opportunity_id is not null then
    select opportunity.strategy, opportunity.strategy_version
    into v_strategy, v_strategy_version
    from public.trade_opportunities opportunity
    where opportunity.id = new.opportunity_id;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'TRADE_OPPORTUNITY_NOT_FOUND_FOR_SIZING';
    end if;
  else
    return new;
  end if;

  perform public.assert_daytrade_strategy_execution_allowed(
    v_strategy,
    v_strategy_version,
    new.execution_environment
  );

  return new;
end;
$$;

revoke all on function public.enforce_position_sizing_strategy_policy()
  from public, anon, authenticated;

drop trigger if exists position_sizing_strategy_policy_guard
  on public.position_sizing_decisions;
create trigger position_sizing_strategy_policy_guard
before insert or update of
  daytrade_setup_id,
  opportunity_id,
  execution_environment
on public.position_sizing_decisions
for each row
execute function public.enforce_position_sizing_strategy_policy();

-- Oportunidades antigas ainda não encerradas deixam de ser candidatas.
update public.trade_opportunities
set
  lifecycle_status = 'invalidated',
  entry_decision = 'rejected',
  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'strategyExecutionBlockedAt', now(),
    'strategyExecutionBlockedReason', 'strategy_shadow'
  )
where opportunity_type = 'entry'
  and source_type = 'daytrade_setup'
  and lifecycle_status in ('pending', 'under_review', 'revalidating')
  and not public.daytrade_strategy_execution_allowed(
    strategy,
    strategy_version,
    execution_environment
  );

-- ============================================================================
-- 3. Configuração 1.1.0 reproduzível: 30 pares e quatro horizontes.
-- ============================================================================

update public.forward_test_config
set ativo = false
where ativo = true
  and versao <> '1.1.0';

insert into public.forward_test_config (
  nome,
  versao,
  timeframes,
  estrategias,
  simbolos,
  fee_rate_pct,
  slippage_pct,
  max_next_open_distance_atr,
  observacoes,
  ativo
)
select
  'Tendência diária — cesta ampla',
  '1.1.0',
  array['1d', '12h', '4h', '1h'],
  array['trend_breakout', 'trend_pullback'],
  array[
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT',
    'DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','TRXUSDT','DOTUSDT',
    'ATOMUSDT','NEARUSDT','FILUSDT','APTUSDT','ARBUSDT','OPUSDT',
    'INJUSDT','ETCUSDT','XLMUSDT','UNIUSDT','AAVEUSDT','ALGOUSDT',
    'VETUSDT','ICPUSDT','RUNEUSDT','SUIUSDT','SEIUSDT','TIAUSDT'
  ],
  0.1,
  0.05,
  0.5,
  'Regras congeladas antes do primeiro sinal. Cesta escolhida por liquidez, sem seleção por desempenho passado. Horizontes 1d, 12h e 4h são candidatos; 1h é controle negativo. Divergência relevante do controle exige investigar consistência dos motores, regime e variação amostral. Tamanho fixo é a referência; anti-martingale suave (x1,5 após ganho) é registrado em paralelo. Nenhuma ordem é executada.',
  true
where not exists (
  select 1
  from public.forward_test_config
  where versao = '1.1.0'
);

update public.forward_test_config
set observacoes =
  'Regras congeladas antes do primeiro sinal. Cesta escolhida por liquidez, sem seleção por desempenho passado. Horizontes 1d, 12h e 4h são candidatos; 1h é controle negativo. Divergência relevante do controle exige investigar consistência dos motores, regime e variação amostral. Tamanho fixo é a referência; anti-martingale suave (x1,5 após ganho) é registrado em paralelo. Nenhuma ordem é executada.'
where versao = '1.1.0';

-- Garante que a view seja reconstruível com isolamento por config_id e com as
-- métricas já calculadas no banco.
drop view if exists public.forward_test_resumo;
create view public.forward_test_resumo as
select
  c.id as config_id,
  c.nome,
  c.versao,
  s.timeframe,
  s.estrategia,
  count(*) filter (where s.status = 'fechado') as operacoes_fechadas,
  count(*) filter (where s.status in ('aguardando_entrada', 'aberto')) as em_andamento,
  count(*) filter (where s.status = 'cancelado') as canceladas,
  count(*) filter (where s.status = 'fechado' and s.resultado_r > 0) as ganhos,
  count(*) filter (where s.status = 'fechado' and s.resultado_r < 0) as perdas,
  round(avg(s.resultado_r) filter (where s.status = 'fechado'), 4) as media_r,
  round(stddev_samp(s.resultado_r) filter (where s.status = 'fechado'), 4) as desvio_r,
  round(sum(s.resultado_r) filter (where s.status = 'fechado'), 4) as soma_r_fixo,
  round(sum(s.resultado_r * s.tamanho_anti) filter (where s.status = 'fechado'), 4) as soma_r_anti,
  round(
    sum(s.resultado_r) filter (where s.status = 'fechado' and s.resultado_r > 0)
    / nullif(abs(sum(s.resultado_r) filter (where s.status = 'fechado' and s.resultado_r < 0)), 0),
    3
  ) as profit_factor,
  min(s.candle_open_time) as primeiro_sinal,
  max(s.candle_open_time) as ultimo_sinal
from public.forward_test_signals s
join public.forward_test_config c on c.id = s.config_id
group by c.id, c.nome, c.versao, s.timeframe, s.estrategia;

grant select on public.forward_test_resumo to authenticated, service_role;

-- ============================================================================
-- 4 e 5. Auditoria robusta: estados parciais, abandono e normalização no banco.
-- ============================================================================

alter table public.forward_test_runs
  drop constraint if exists forward_test_runs_status_check;
alter table public.forward_test_runs
  add constraint forward_test_runs_status_check
  check (status in (
    'executando',
    'concluido',
    'concluido_com_falhas',
    'falhou',
    'abandonado'
  ));

create or replace function public.normalizar_status_forward_test_run()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_falhas integer := 0;
begin
  if new.finalizado_em is null or new.status in ('executando', 'abandonado', 'falhou') then
    return new;
  end if;

  if jsonb_typeof(coalesce(new.falhas, '[]'::jsonb)) = 'array' then
    v_falhas := jsonb_array_length(coalesce(new.falhas, '[]'::jsonb));
  else
    v_falhas := 1;
  end if;

  if coalesce(new.pares_processados, 0) = 0 then
    new.status := 'falhou';
  elsif
    v_falhas > 0
    or coalesce(new.pares_processados, 0) < coalesce(new.pares_esperados, 0)
  then
    new.status := 'concluido_com_falhas';
  else
    new.status := 'concluido';
  end if;

  return new;
end;
$$;

drop trigger if exists forward_test_runs_normalizar_status
  on public.forward_test_runs;
create trigger forward_test_runs_normalizar_status
before update on public.forward_test_runs
for each row
execute function public.normalizar_status_forward_test_run();

create or replace function public.abandon_stale_forward_test_runs(
  p_stale_after interval default interval '20 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
  v_stale_after interval := coalesce(p_stale_after, interval '20 minutes');
begin
  if v_stale_after < interval '1 minute' then
    raise exception 'p_stale_after deve ser de pelo menos 1 minuto.';
  end if;

  update public.forward_test_runs
  set
    status = 'abandonado',
    finalizado_em = coalesce(finalizado_em, now()),
    duracao_ms = coalesce(
      duracao_ms,
      greatest(0, floor(extract(epoch from (now() - iniciado_em)) * 1000))::integer
    ),
    falhas = coalesce(falhas, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'tipo', 'execucao_abandonada',
        'mensagem', 'A execução permaneceu em andamento além do limite.',
        'detectado_em', now()
      )
    )
  where status = 'executando'
    and iniciado_em < now() - v_stale_after;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.abandon_stale_forward_test_runs(interval)
  from public, anon, authenticated;
grant execute on function public.abandon_stale_forward_test_runs(interval)
  to service_role;

commit;
