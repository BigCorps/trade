begin;

-- ============================================================================
-- VigIA Trade — recuperação de candles, checkpoints e métricas estatísticas
-- Aplicada em 24/07/2026.
--
-- Esta migration complementa o teste prospectivo congelado sem alterar suas
-- regras de negociação. Ela apenas torna a coleta recuperável e a auditoria
-- estatística mais completa.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Auditoria de cada execução
-- ---------------------------------------------------------------------------

alter table public.forward_test_runs
  add column if not exists candles_avaliados integer not null default 0,
  add column if not exists candles_recuperados integer not null default 0,
  add column if not exists pares_bloqueados integer not null default 0,
  add column if not exists backlog_pares integer not null default 0,
  add column if not exists backlog_candles_estimados integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.forward_test_runs'::regclass
      and conname = 'forward_test_runs_recovery_counts_check'
  ) then
    alter table public.forward_test_runs
      add constraint forward_test_runs_recovery_counts_check
      check (
        candles_avaliados >= 0
        and candles_recuperados >= 0
        and pares_bloqueados >= 0
        and backlog_pares >= 0
        and backlog_candles_estimados >= 0
      );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Checkpoint por configuração, moeda e horizonte
-- ---------------------------------------------------------------------------

create table if not exists public.forward_test_checkpoints (
  config_id uuid not null
    references public.forward_test_config(id) on delete cascade,
  simbolo text not null,
  timeframe text not null,

  last_evaluated_open_time timestamptz,
  last_evaluated_close_time timestamptz,
  last_success_at timestamptz,
  last_run_id uuid
    references public.forward_test_runs(id) on delete set null,

  candles_evaluated_total bigint not null default 0,
  recovery_candles_total bigint not null default 0,
  failures_total integer not null default 0,
  backlog_estimated integer not null default 0,
  last_error text,

  lock_token uuid,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),

  primary key (config_id, simbolo, timeframe),

  constraint forward_test_checkpoints_time_order_check
    check (
      last_evaluated_open_time is null
      or last_evaluated_close_time is null
      or last_evaluated_close_time > last_evaluated_open_time
    ),

  constraint forward_test_checkpoints_counts_check
    check (
      candles_evaluated_total >= 0
      and recovery_candles_total >= 0
      and failures_total >= 0
      and backlog_estimated >= 0
    )
);

comment on table public.forward_test_checkpoints is
  'Checkpoint recuperável por configuração, símbolo e timeframe. Permite processar candles fechados durante falhas do cron sem duplicar sinais.';

create index if not exists forward_test_checkpoints_lag_idx
  on public.forward_test_checkpoints (
    config_id,
    backlog_estimated desc,
    last_success_at asc nulls first
  );

create index if not exists forward_test_checkpoints_lock_idx
  on public.forward_test_checkpoints (locked_until)
  where locked_until is not null;

alter table public.forward_test_checkpoints enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'forward_test_checkpoints'
      and policyname = 'checkpoints visiveis para autenticados'
  ) then
    create policy "checkpoints visiveis para autenticados"
      on public.forward_test_checkpoints
      for select
      to authenticated
      using (true);
  end if;
end;
$$;

grant select on public.forward_test_checkpoints to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Funções auxiliares de timeframe
-- ---------------------------------------------------------------------------

create or replace function public.forward_test_timeframe_interval(
  p_timeframe text
)
returns interval
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case p_timeframe
    when '1h' then interval '1 hour'
    when '4h' then interval '4 hours'
    when '12h' then interval '12 hours'
    when '1d' then interval '1 day'
    else null
  end;
$$;

create or replace function public.forward_test_last_closed_open(
  p_timeframe text,
  p_at timestamptz default now()
)
returns timestamptz
language sql
stable
parallel safe
set search_path = public, pg_temp
as $$
  select case p_timeframe
    when '1h' then
      date_trunc('hour', p_at) - interval '1 hour'
    when '4h' then
      date_trunc('day', p_at)
      + floor(extract(hour from p_at) / 4)::integer * interval '4 hours'
      - interval '4 hours'
    when '12h' then
      date_trunc('day', p_at)
      + floor(extract(hour from p_at) / 12)::integer * interval '12 hours'
      - interval '12 hours'
    when '1d' then
      date_trunc('day', p_at) - interval '1 day'
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Lease para impedir dois workers de processarem o mesmo par ao mesmo tempo
-- ---------------------------------------------------------------------------

create or replace function public.claim_forward_test_checkpoint(
  p_config_id uuid,
  p_simbolo text,
  p_timeframe text,
  p_run_id uuid,
  p_lock_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_row public.forward_test_checkpoints%rowtype;
  v_lock_seconds integer := greatest(60, least(coalesce(p_lock_seconds, 240), 900));
begin
  if not exists (
    select 1
    from public.forward_test_config config
    where config.id = p_config_id
      and p_simbolo = any(config.simbolos)
      and p_timeframe = any(config.timeframes)
  ) then
    return jsonb_build_object(
      'claimed', false,
      'code', 'FORWARD_TEST_PAIR_NOT_CONFIGURED'
    );
  end if;

  insert into public.forward_test_checkpoints (
    config_id,
    simbolo,
    timeframe,
    updated_at
  ) values (
    p_config_id,
    p_simbolo,
    p_timeframe,
    now()
  )
  on conflict (config_id, simbolo, timeframe) do nothing;

  update public.forward_test_checkpoints checkpoint
  set
    lock_token = v_token,
    locked_until = now() + make_interval(secs => v_lock_seconds),
    last_run_id = p_run_id,
    updated_at = now()
  where checkpoint.config_id = p_config_id
    and checkpoint.simbolo = p_simbolo
    and checkpoint.timeframe = p_timeframe
    and (
      checkpoint.locked_until is null
      or checkpoint.locked_until < now()
    )
  returning checkpoint.* into v_row;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'code', 'FORWARD_TEST_PAIR_LOCKED'
    );
  end if;

  return jsonb_build_object(
    'claimed', true,
    'code', 'FORWARD_TEST_PAIR_CLAIMED',
    'lock_token', v_token,
    'last_evaluated_open_time', v_row.last_evaluated_open_time,
    'last_evaluated_close_time', v_row.last_evaluated_close_time,
    'last_success_at', v_row.last_success_at,
    'backlog_estimated', v_row.backlog_estimated,
    'locked_until', v_row.locked_until
  );
end;
$$;

create or replace function public.complete_forward_test_checkpoint(
  p_config_id uuid,
  p_simbolo text,
  p_timeframe text,
  p_lock_token uuid,
  p_run_id uuid,
  p_last_evaluated_open_time timestamptz,
  p_last_evaluated_close_time timestamptz,
  p_candles_evaluated integer,
  p_recovery_candles integer,
  p_backlog_estimated integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.forward_test_checkpoints%rowtype;
begin
  update public.forward_test_checkpoints checkpoint
  set
    last_evaluated_open_time = case
      when p_last_evaluated_open_time is null then checkpoint.last_evaluated_open_time
      when checkpoint.last_evaluated_open_time is null then p_last_evaluated_open_time
      else greatest(checkpoint.last_evaluated_open_time, p_last_evaluated_open_time)
    end,
    last_evaluated_close_time = case
      when p_last_evaluated_open_time is null then checkpoint.last_evaluated_close_time
      when checkpoint.last_evaluated_open_time is null
        or p_last_evaluated_open_time >= checkpoint.last_evaluated_open_time
        then p_last_evaluated_close_time
      else checkpoint.last_evaluated_close_time
    end,
    last_success_at = now(),
    last_run_id = p_run_id,
    candles_evaluated_total = checkpoint.candles_evaluated_total
      + greatest(coalesce(p_candles_evaluated, 0), 0),
    recovery_candles_total = checkpoint.recovery_candles_total
      + greatest(coalesce(p_recovery_candles, 0), 0),
    backlog_estimated = greatest(coalesce(p_backlog_estimated, 0), 0),
    last_error = null,
    lock_token = null,
    locked_until = null,
    updated_at = now()
  where checkpoint.config_id = p_config_id
    and checkpoint.simbolo = p_simbolo
    and checkpoint.timeframe = p_timeframe
    and checkpoint.lock_token = p_lock_token
  returning checkpoint.* into v_row;

  if not found then
    return jsonb_build_object(
      'updated', false,
      'code', 'FORWARD_TEST_CHECKPOINT_LOCK_LOST'
    );
  end if;

  return jsonb_build_object(
    'updated', true,
    'code', 'FORWARD_TEST_CHECKPOINT_COMPLETED',
    'last_evaluated_open_time', v_row.last_evaluated_open_time,
    'backlog_estimated', v_row.backlog_estimated
  );
end;
$$;

create or replace function public.fail_forward_test_checkpoint(
  p_config_id uuid,
  p_simbolo text,
  p_timeframe text,
  p_lock_token uuid,
  p_run_id uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update public.forward_test_checkpoints checkpoint
  set
    last_run_id = p_run_id,
    failures_total = checkpoint.failures_total + 1,
    last_error = left(coalesce(p_error, 'falha não especificada'), 2000),
    lock_token = null,
    locked_until = null,
    updated_at = now()
  where checkpoint.config_id = p_config_id
    and checkpoint.simbolo = p_simbolo
    and checkpoint.timeframe = p_timeframe
    and checkpoint.lock_token = p_lock_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.claim_forward_test_checkpoint(uuid, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_forward_test_checkpoint(uuid, text, text, uuid, uuid, timestamptz, timestamptz, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.fail_forward_test_checkpoint(uuid, text, text, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.claim_forward_test_checkpoint(uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.complete_forward_test_checkpoint(uuid, text, text, uuid, uuid, timestamptz, timestamptz, integer, integer, integer)
  to service_role;
grant execute on function public.fail_forward_test_checkpoint(uuid, text, text, uuid, uuid, text)
  to service_role;

-- Semeia os checkpoints com base na execução bem-sucedida mais recente. Isso
-- evita reavaliar candles que a versão anterior da rota já processou.
with latest_run as (
  select distinct on (run.config_id)
    run.config_id,
    run.id,
    run.finalizado_em
  from public.forward_test_runs run
  where run.finalizado_em is not null
    and run.status in ('concluido', 'concluido_com_falhas')
  order by run.config_id, run.finalizado_em desc
), pairs as (
  select
    config.id as config_id,
    symbol.simbolo,
    timeframe.timeframe,
    latest_run.id as run_id,
    latest_run.finalizado_em
  from public.forward_test_config config
  join latest_run on latest_run.config_id = config.id
  cross join lateral unnest(config.simbolos) as symbol(simbolo)
  cross join lateral unnest(config.timeframes) as timeframe(timeframe)
)
insert into public.forward_test_checkpoints (
  config_id,
  simbolo,
  timeframe,
  last_evaluated_open_time,
  last_evaluated_close_time,
  last_success_at,
  last_run_id,
  updated_at
)
select
  pair.config_id,
  pair.simbolo,
  pair.timeframe,
  public.forward_test_last_closed_open(pair.timeframe, pair.finalizado_em),
  public.forward_test_last_closed_open(pair.timeframe, pair.finalizado_em)
    + public.forward_test_timeframe_interval(pair.timeframe)
    - interval '1 millisecond',
  pair.finalizado_em,
  pair.run_id,
  now()
from pairs pair
where public.forward_test_last_closed_open(pair.timeframe, pair.finalizado_em) is not null
on conflict (config_id, simbolo, timeframe) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Visão estatística auditável
-- ---------------------------------------------------------------------------

drop view if exists public.forward_test_resumo;

create view public.forward_test_resumo as
with base as (
  select
    signal.config_id,
    config.nome,
    config.versao,
    signal.timeframe,
    signal.estrategia,
    count(*) filter (
      where signal.status = 'fechado' and signal.resultado_r is not null
    )::bigint as operacoes_fechadas,
    count(*) filter (
      where signal.status in ('aguardando_entrada', 'aberto')
    )::bigint as em_andamento,
    count(*) filter (where signal.status = 'cancelado')::bigint as canceladas,
    count(*) filter (
      where signal.status = 'fechado' and signal.resultado_r > 0
    )::bigint as ganhos,
    count(*) filter (
      where signal.status = 'fechado' and signal.resultado_r < 0
    )::bigint as perdas,
    count(*) filter (
      where signal.status = 'fechado' and signal.resultado_r = 0
    )::bigint as empates,
    min(signal.candle_open_time) as primeiro_sinal,
    max(signal.candle_open_time) as ultimo_sinal
  from public.forward_test_signals signal
  join public.forward_test_config config on config.id = signal.config_id
  group by
    signal.config_id,
    config.nome,
    config.versao,
    signal.timeframe,
    signal.estrategia
), closed_curve as (
  select
    signal.config_id,
    signal.timeframe,
    signal.estrategia,
    signal.id,
    signal.candle_open_time,
    signal.resultado_r::numeric as r_fixo,
    (signal.resultado_r * signal.tamanho_anti)::numeric as r_anti,
    sum(signal.resultado_r) over curve_window as equity_fixo,
    sum(signal.resultado_r * signal.tamanho_anti) over curve_window as equity_anti
  from public.forward_test_signals signal
  where signal.status = 'fechado'
    and signal.resultado_r is not null
  window curve_window as (
    partition by signal.config_id, signal.timeframe, signal.estrategia
    order by signal.candle_open_time, signal.id
    rows between unbounded preceding and current row
  )
), closed_with_peaks as (
  select
    curve.*,
    greatest(
      0::numeric,
      max(curve.equity_fixo) over peak_window
    ) as peak_fixo,
    greatest(
      0::numeric,
      max(curve.equity_anti) over peak_window
    ) as peak_anti
  from closed_curve curve
  window peak_window as (
    partition by curve.config_id, curve.timeframe, curve.estrategia
    order by curve.candle_open_time, curve.id
    rows between unbounded preceding and current row
  )
), stats as (
  select
    curve.config_id,
    curve.timeframe,
    curve.estrategia,
    avg(curve.r_fixo) as media_r,
    stddev_samp(curve.r_fixo) as desvio_r,
    sum(curve.r_fixo) as soma_r_fixo,
    sum(curve.r_fixo * curve.r_fixo) as soma_quadrados_r_fixo,
    sum(curve.r_fixo) filter (where curve.r_fixo > 0) as ganho_bruto_r,
    sum(curve.r_fixo) filter (where curve.r_fixo < 0) as perda_bruta_r,
    avg(curve.r_anti) as media_r_anti,
    stddev_samp(curve.r_anti) as desvio_r_anti,
    sum(curve.r_anti) as soma_r_anti,
    sum(curve.r_anti * curve.r_anti) as soma_quadrados_r_anti,
    max(curve.peak_fixo - curve.equity_fixo) as max_drawdown_r_fixo,
    max(curve.peak_anti - curve.equity_anti) as max_drawdown_r_anti
  from closed_with_peaks curve
  group by curve.config_id, curve.timeframe, curve.estrategia
)
select
  base.config_id,
  base.nome,
  base.versao,
  base.timeframe,
  base.estrategia,
  base.operacoes_fechadas,
  base.em_andamento,
  base.canceladas,
  base.ganhos,
  base.perdas,
  base.empates,
  round(stats.media_r, 6) as media_r,
  round(stats.desvio_r, 6) as desvio_r,
  round(
    stats.desvio_r / nullif(sqrt(base.operacoes_fechadas::numeric), 0),
    6
  ) as erro_padrao_r,
  round(
    stats.media_r
      - 1.96 * stats.desvio_r
        / nullif(sqrt(base.operacoes_fechadas::numeric), 0),
    6
  ) as ic95_inferior_r,
  round(
    stats.media_r
      + 1.96 * stats.desvio_r
        / nullif(sqrt(base.operacoes_fechadas::numeric), 0),
    6
  ) as ic95_superior_r,
  round(
    stats.media_r
      / nullif(
          stats.desvio_r / nullif(sqrt(base.operacoes_fechadas::numeric), 0),
          0
        ),
    4
  ) as t_stat_r,
  round(stats.soma_r_fixo, 6) as soma_r_fixo,
  round(stats.soma_quadrados_r_fixo, 8) as soma_quadrados_r_fixo,
  round(coalesce(stats.ganho_bruto_r, 0), 6) as ganho_bruto_r,
  round(coalesce(stats.perda_bruta_r, 0), 6) as perda_bruta_r,
  round(
    coalesce(stats.ganho_bruto_r, 0)
      / nullif(abs(coalesce(stats.perda_bruta_r, 0)), 0),
    4
  ) as profit_factor,
  round(stats.media_r_anti, 6) as media_r_anti,
  round(stats.desvio_r_anti, 6) as desvio_r_anti,
  round(stats.soma_r_anti, 6) as soma_r_anti,
  round(stats.soma_quadrados_r_anti, 8) as soma_quadrados_r_anti,
  round(stats.soma_r_anti - stats.soma_r_fixo, 6) as delta_anti_r,
  round(stats.max_drawdown_r_fixo, 6) as max_drawdown_r_fixo,
  round(stats.max_drawdown_r_anti, 6) as max_drawdown_r_anti,
  base.primeiro_sinal,
  base.ultimo_sinal
from base
left join stats
  on stats.config_id = base.config_id
  and stats.timeframe = base.timeframe
  and stats.estrategia = base.estrategia;

comment on view public.forward_test_resumo is
  'Resumo estatístico por configuração, horizonte e estratégia, com dispersão, IC95 aproximado, profit factor e drawdown em R.';

grant select on public.forward_test_resumo to authenticated, service_role;

commit;
