-- VigIA Strategy Validation v2.0.0
-- Ordem segura: publicar o código Next.js e a Edge Function antes de aplicar.
begin;

-- ---------------------------------------------------------------------------
-- 1. Suporte a vários protocolos prospectivos simultâneos.
-- ---------------------------------------------------------------------------
alter table public.forward_test_config
  add column if not exists grupo_experimento text,
  add column if not exists coletar boolean not null default false,
  add column if not exists strategy_options jsonb not null default '{}'::jsonb,
  add column if not exists amostra_alvo integer not null default 100,
  add column if not exists protocolo_status text not null default 'coletando';

alter table public.forward_test_config
  drop constraint if exists forward_test_config_amostra_alvo_check;
alter table public.forward_test_config
  add constraint forward_test_config_amostra_alvo_check
  check (amostra_alvo >= 30);

alter table public.forward_test_config
  drop constraint if exists forward_test_config_protocolo_status_check;
alter table public.forward_test_config
  add constraint forward_test_config_protocolo_status_check
  check (protocolo_status in ('preparado','coletando','encerrado','aprovado','reprovado'));

create index if not exists forward_test_config_collecting_group_idx
  on public.forward_test_config (grupo_experimento, congelado_em)
  where coletar;

alter table public.forward_test_signals
  add column if not exists direcao text not null default 'long',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.forward_test_signals
  drop constraint if exists forward_test_signals_direcao_check;
alter table public.forward_test_signals
  add constraint forward_test_signals_direcao_check
  check (direcao in ('long','short'));

comment on column public.forward_test_signals.direcao is
  'Direção congelada no momento do sinal. Permite validar estratégias long e short sem inferência posterior.';
comment on column public.forward_test_signals.metadata is
  'Diagnósticos congelados do sinal, grupo experimental e versão do protocolo.';

-- Congelamento inclui os novos campos.
create or replace function public.impedir_edicao_config_congelada()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'Configuração prospectiva não pode ser excluída; desative-a para preservar o histórico.';
  end if;

  if not old.ativo and new.ativo then
    raise exception
      'Uma configuração encerrada não pode ser reativada. Crie nova versão.';
  end if;

  if not old.coletar and new.coletar then
    raise exception
      'Uma coleta encerrada não pode ser reativada. Crie nova versão.';
  end if;

  if
    old.nome is distinct from new.nome
    or old.versao is distinct from new.versao
    or old.timeframes is distinct from new.timeframes
    or old.estrategias is distinct from new.estrategias
    or old.simbolos is distinct from new.simbolos
    or old.fee_rate_pct is distinct from new.fee_rate_pct
    or old.slippage_pct is distinct from new.slippage_pct
    or old.max_next_open_distance_atr is distinct from new.max_next_open_distance_atr
    or old.grupo_experimento is distinct from new.grupo_experimento
    or old.strategy_options is distinct from new.strategy_options
    or old.amostra_alvo is distinct from new.amostra_alvo
    or old.congelado_em is distinct from new.congelado_em
    or old.criado_em is distinct from new.criado_em
  then
    raise exception
      'Regras congeladas não podem ser alteradas. Desative e crie nova versão.';
  end if;

  return new;
end;
$$;

drop trigger if exists forward_test_config_congelada
  on public.forward_test_config;
create trigger forward_test_config_congelada
before update or delete on public.forward_test_config
for each row execute function public.impedir_edicao_config_congelada();

-- ---------------------------------------------------------------------------
-- 2. Encerra a v1.1.0 e congela três amostras independentes.
-- ---------------------------------------------------------------------------
update public.forward_test_config
set
  ativo = false,
  coletar = false,
  protocolo_status = case
    when versao = '1.1.0' then 'reprovado'
    else protocolo_status
  end,
  observacoes = case
    when versao = '1.1.0'
      then coalesce(observacoes,'') ||
        E'\nEncerrada em 05/08/2026 após 125 operações: -61,38R, PF 0,47 e Monte Carlo 100% negativo.'
    else observacoes
  end
where ativo = true;

insert into public.forward_test_config (
  nome, versao, grupo_experimento, timeframes, estrategias, simbolos,
  fee_rate_pct, slippage_pct, max_next_open_distance_atr,
  strategy_options, amostra_alvo, protocolo_status, observacoes, ativo, coletar
)
select
  'Rompimento fracassado — cesta ampla',
  '2.0.0-fbr',
  'reversal_broad',
  array['1h','4h'],
  array['failed_breakout_reversal'],
  array[
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT',
    'DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','TRXUSDT','DOTUSDT',
    'ATOMUSDT','NEARUSDT','FILUSDT','APTUSDT','ARBUSDT','OPUSDT',
    'INJUSDT','ETCUSDT','XLMUSDT','UNIUSDT','AAVEUSDT','ALGOUSDT',
    'VETUSDT','ICPUSDT','RUNEUSDT','SUIUSDT','SEIUSDT','TIAUSDT'
  ],
  0.1, 0.05, 0.35,
  jsonb_build_object(
    'failed_breakout_reversal', jsonb_build_object(
      'minimumPierceAtr',0.10,
      'minimumReentryAtr',0.05,
      'minimumRelativeVolume',1.10,
      'minimumUpperWickFraction',0.35,
      'maximumCloseLocation',0.45,
      'maximumBullishExtensionAtr',0.50,
      'atrStopBuffer',0.20,
      'minimumRiskRewardRatio',2.20,
      'minimumStopDistanceAtr',0.60,
      'maximumStopDistanceAtr',2.20,
      'blockedVolatilityRegimes',jsonb_build_array('indisponível')
    )
  ),
  100,
  'coletando',
  'Hipótese congelada antes da nova amostra. Short somente após perfuração, retorno à faixa, rejeição e volume. Tamanho fixo 1R; sem martingale e sem ordens.',
  false, true
where not exists (
  select 1 from public.forward_test_config where versao='2.0.0-fbr'
);

insert into public.forward_test_config (
  nome, versao, grupo_experimento, timeframes, estrategias, simbolos,
  fee_rate_pct, slippage_pct, max_next_open_distance_atr,
  strategy_options, amostra_alvo, protocolo_status, observacoes, ativo, coletar
)
select
  'Continuação confirmada — ativos selecionados',
  '2.0.0-selective',
  'continuation_selective',
  array['1h','4h'],
  array['confirmed_trend_continuation'],
  array['UNIUSDT','ADAUSDT','DOTUSDT','ALGOUSDT'],
  0.1, 0.05, 0.35,
  jsonb_build_object(
    'confirmed_trend_continuation', jsonb_build_object(
      'minimumBreakoutDistanceAtr',0.25,
      'minimumRelativeVolume',1.25,
      'minimumBodyFraction',0.55,
      'minimumCloseLocation',0.75,
      'atrStopMultiple',1.40,
      'breakoutRetestBufferAtr',0.20,
      'minimumRiskRewardRatio',2.50,
      'minimumStopDistanceAtr',0.75,
      'maximumStopDistanceAtr',2.00,
      'maximumLateEntryDistanceAtr',0.35,
      'blockedVolatilityRegimes',jsonb_build_array('calmo','extremo','indisponível')
    )
  ),
  100,
  'coletando',
  'Cesta derivada da v1 apenas como hipótese. Resultado anterior não entra na validação. Requer nova amostra prospectiva independente e tamanho fixo.',
  true, true
where not exists (
  select 1 from public.forward_test_config where versao='2.0.0-selective'
);

insert into public.forward_test_config (
  nome, versao, grupo_experimento, timeframes, estrategias, simbolos,
  fee_rate_pct, slippage_pct, max_next_open_distance_atr,
  strategy_options, amostra_alvo, protocolo_status, observacoes, ativo, coletar
)
select
  'Continuação confirmada — controle amplo',
  '2.0.0-control',
  'continuation_control',
  array['1h','4h'],
  array['confirmed_trend_continuation'],
  array[
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT',
    'DOGEUSDT','AVAXUSDT','LINKUSDT','LTCUSDT','TRXUSDT','DOTUSDT',
    'ATOMUSDT','NEARUSDT','FILUSDT','APTUSDT','ARBUSDT','OPUSDT',
    'INJUSDT','ETCUSDT','XLMUSDT','UNIUSDT','AAVEUSDT','ALGOUSDT',
    'VETUSDT','ICPUSDT','RUNEUSDT','SUIUSDT','SEIUSDT','TIAUSDT'
  ],
  0.1, 0.05, 0.35,
  jsonb_build_object(
    'confirmed_trend_continuation', jsonb_build_object(
      'minimumBreakoutDistanceAtr',0.25,
      'minimumRelativeVolume',1.25,
      'minimumBodyFraction',0.55,
      'minimumCloseLocation',0.75,
      'atrStopMultiple',1.40,
      'breakoutRetestBufferAtr',0.20,
      'minimumRiskRewardRatio',2.50,
      'minimumStopDistanceAtr',0.75,
      'maximumStopDistanceAtr',2.00,
      'maximumLateEntryDistanceAtr',0.35,
      'blockedVolatilityRegimes',jsonb_build_array('calmo','extremo','indisponível')
    )
  ),
  100,
  'coletando',
  'Controle da mesma regra na cesta ampla. Serve para separar efeito da regra do efeito da seleção UNI/ADA/DOT/ALGO.',
  false, true
where not exists (
  select 1 from public.forward_test_config where versao='2.0.0-control'
);

-- Novas estratégias continuam bloqueadas para Testnet e conta real.
insert into public.daytrade_strategy_execution_policy (
  strategy, strategy_version, execution_environment,
  execution_enabled, reason, validated_at, updated_at
)
select strategy, version, environment, false,
  'Estratégia v2 em shadow; aguarda amostra prospectiva mínima e robustez.',
  null, now()
from (
  values
    ('failed_breakout_reversal','2.0.0'),
    ('confirmed_trend_continuation','2.0.0')
) s(strategy,version)
cross join (values ('testnet'),('real')) e(environment)
on conflict (strategy,strategy_version,execution_environment)
do update set
  execution_enabled=false,
  reason=excluded.reason,
  validated_at=null,
  updated_at=now();

-- ---------------------------------------------------------------------------
-- 3. Dashboard próprio da v2; a view legada permanece intacta.
-- ---------------------------------------------------------------------------
create or replace view public.forward_test_v2_dashboard
with (security_invoker=true) as
with rows as (
  select
    c.id config_id,
    c.nome,
    c.versao,
    c.grupo_experimento,
    c.amostra_alvo,
    c.protocolo_status,
    c.coletar,
    c.congelado_em,
    count(s.id) filter (where s.status='fechado') operacoes,
    count(s.id) filter (where s.status in ('aguardando_entrada','aberto')) abertas,
    coalesce(sum(s.resultado_r) filter (where s.status='fechado'),0) resultado_r,
    avg(s.resultado_r) filter (where s.status='fechado') media_r,
    sum(s.resultado_r) filter (where s.status='fechado' and s.resultado_r>0) lucro_bruto,
    abs(sum(s.resultado_r) filter (where s.status='fechado' and s.resultado_r<0)) perda_bruta,
    avg(case when s.resultado_r>0 then 1.0 else 0.0 end)
      filter (where s.status='fechado') acerto
  from public.forward_test_config c
  left join public.forward_test_signals s on s.config_id=c.id
  where c.versao like '2.0.0-%'
  group by c.id
)
select
  *,
  round(resultado_r,4) resultado_r_liquido,
  round(media_r,4) media_r_operacao,
  round(100.0*acerto,2) acerto_pct,
  round(lucro_bruto/nullif(perda_bruta,0),3) profit_factor,
  least(100.0,round(100.0*operacoes/nullif(amostra_alvo,0),2)) progresso_pct,
  case
    when operacoes < 50 then 'insuficiente'
    when operacoes < amostra_alvo then 'preliminar'
    when resultado_r > 0 and lucro_bruto/nullif(perda_bruta,0) > 1 then 'avaliar_robustez'
    else 'reprovada'
  end situacao_amostra
from rows;

grant select on public.forward_test_v2_dashboard
to authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 4. Funding carry delta-neutro, observacional.
-- ---------------------------------------------------------------------------
create table if not exists public.funding_carry_snapshots (
  id bigint generated by default as identity primary key,
  coletado_em timestamptz not null default now(),
  simbolo text not null,
  mark_price numeric not null,
  index_price numeric not null,
  funding_rate numeric not null,
  funding_rate_pct numeric not null,
  funding_anualizado_pct numeric not null,
  basis_pct numeric not null,
  custo_round_trip_pct numeric not null,
  holding_dias_assumido integer not null,
  carry_liquido_anualizado_pct numeric not null,
  elegivel boolean not null,
  motivo text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  unique (simbolo,coletado_em)
);

create index if not exists funding_carry_snapshots_recent_idx
  on public.funding_carry_snapshots (simbolo,coletado_em desc);

alter table public.funding_carry_snapshots enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='funding_carry_snapshots'
      and policyname='funding carry visivel para autenticados'
  ) then
    create policy "funding carry visivel para autenticados"
      on public.funding_carry_snapshots
      for select to authenticated using (true);
  end if;
end $$;

create table if not exists public.funding_carry_protocol (
  id uuid primary key default gen_random_uuid(),
  versao text not null unique,
  nome text not null,
  congelado_em timestamptz not null default now(),
  simbolos text[] not null,
  funding_anualizado_min_pct numeric not null,
  basis_abs_max_pct numeric not null,
  custo_round_trip_pct numeric not null,
  holding_dias_assumido integer not null,
  amostra_horas_alvo integer not null,
  status text not null check(status in ('coletando','encerrado','aprovado','reprovado')),
  observacoes text
);

insert into public.funding_carry_protocol (
  versao,nome,simbolos,funding_anualizado_min_pct,basis_abs_max_pct,
  custo_round_trip_pct,holding_dias_assumido,amostra_horas_alvo,status,observacoes
)
values (
  '1.0.0',
  'Funding carry delta-neutro — observacional',
  array['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','UNIUSDT'],
  15.0,0.75,0.60,30,720,'coletando',
  'Long spot + short perp apenas como hipótese. Nenhuma ordem. Elegibilidade exige funding positivo, basis controlado e carry anualizado líquido positivo.'
)
on conflict (versao) do nothing;

alter table public.funding_carry_protocol enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='funding_carry_protocol'
      and policyname='protocolo funding visivel para autenticados'
  ) then
    create policy "protocolo funding visivel para autenticados"
      on public.funding_carry_protocol
      for select to authenticated using (true);
  end if;
end $$;

create or replace view public.funding_carry_latest
with (security_invoker=true) as
select distinct on (simbolo)
  simbolo,coletado_em,mark_price,index_price,funding_rate_pct,
  funding_anualizado_pct,basis_pct,custo_round_trip_pct,
  carry_liquido_anualizado_pct,elegivel,motivo
from public.funding_carry_snapshots
order by simbolo,coletado_em desc;

grant select on public.funding_carry_snapshots,public.funding_carry_protocol,
  public.funding_carry_latest
to authenticated,service_role;
grant insert on public.funding_carry_snapshots to service_role;

-- O coletor deve estar publicado antes deste cron.
do $$
declare job_record record;
begin
  for job_record in
    select jobid from cron.job where jobname='vigia-funding-carry-hourly'
  loop
    perform cron.unschedule(job_record.jobid);
  end loop;
end $$;

select cron.schedule(
  'vigia-funding-carry-hourly',
  '11 * * * *',
  $cron$
    select net.http_post(
      url := 'https://xzqmfcxtvfffgrmqqzdz.supabase.co/functions/v1/funding-carry',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-cron-secret',(
          select decrypted_secret
          from vault.decrypted_secrets
          where name='vigia_cron_secret_20260720'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cron$
);

commit;
