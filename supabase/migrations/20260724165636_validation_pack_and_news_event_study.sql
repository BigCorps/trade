-- VigIA Trade — Validation Pack v1 + News Event Study v1
-- JÁ APLICADA NO SUPABASE DE PRODUÇÃO em 24/07/2026.
-- O arquivo usa a versão já registrada no histórico remoto para que o repositório
-- reflita o banco. Não execute manualmente de novo no projeto de produção.

create table if not exists public.forward_test_validation_runs (
  id uuid primary key default gen_random_uuid(), config_id uuid not null references public.forward_test_config(id) on delete cascade,
  iniciado_em timestamptz not null default now(), finalizado_em timestamptz,
  status text not null default 'executando' check (status in ('executando','concluido','concluido_com_falhas','falhou')),
  operacoes_fechadas integer not null default 0, sinais_enriquecidos integer not null default 0,
  iteracoes_monte_carlo integer not null default 0, seed bigint, parametros jsonb not null default '{}'::jsonb,
  resultado jsonb not null default '{}'::jsonb, erro text
);
create unique index if not exists forward_test_validation_one_running_idx on public.forward_test_validation_runs(config_id) where status='executando';
create index if not exists forward_test_validation_runs_recent_idx on public.forward_test_validation_runs(config_id,iniciado_em desc);
create index if not exists forward_test_validation_runs_running_idx on public.forward_test_validation_runs(iniciado_em) where status='executando';

create table if not exists public.forward_test_signal_context (
  signal_id uuid primary key references public.forward_test_signals(id) on delete cascade,
  config_id uuid not null references public.forward_test_config(id) on delete cascade,
  simbolo text not null, timeframe text not null, estrategia text not null, candle_open_time timestamptz not null,
  signal_status text not null, resultado_r_base numeric, replay_r_1x numeric, replay_r_1_5x numeric,
  replay_r_2x numeric, replay_r_3x numeric, replay_r_atraso_1 numeric, replay_r_atraso_2 numeric,
  replay_status jsonb not null default '{}'::jsonb,
  tendencia_ativo text check (tendencia_ativo is null or tendencia_ativo in ('alta','baixa','lateral','indefinida')),
  volatilidade_ativo text check (volatilidade_ativo is null or volatilidade_ativo in ('baixa','normal','alta','extrema','indefinida')),
  tendencia_btc text check (tendencia_btc is null or tendencia_btc in ('alta','baixa','lateral','indefinida')),
  volatilidade_btc text check (volatilidade_btc is null or volatilidade_btc in ('baixa','normal','alta','extrema','indefinida')),
  atr_pct numeric, atr_percentil numeric, ema20 numeric, ema50 numeric, ema200 numeric, btc_retorno_24h_pct numeric,
  versao_enriquecimento text not null default 'validation-v1.0.0', enriquecido_em timestamptz not null default now()
);
create index if not exists forward_test_signal_context_group_idx on public.forward_test_signal_context(config_id,timeframe,estrategia,candle_open_time desc);
create index if not exists forward_test_signal_context_status_idx on public.forward_test_signal_context(config_id,signal_status,candle_open_time desc);

create table if not exists public.market_news_runs (
  id uuid primary key default gen_random_uuid(), tipo text not null check (tipo in ('coleta','reacoes','coleta_e_reacoes')),
  iniciado_em timestamptz not null default now(), finalizado_em timestamptz,
  status text not null default 'executando' check (status in ('executando','concluido','concluido_com_falhas','falhou')),
  artigos_recebidos integer not null default 0, eventos_novos integer not null default 0, eventos_repetidos integer not null default 0,
  reacoes_processadas integer not null default 0, falhas integer not null default 0, detalhes jsonb not null default '{}'::jsonb, erro text
);
create unique index if not exists market_news_one_running_idx on public.market_news_runs(tipo) where status='executando';
create index if not exists market_news_runs_recent_idx on public.market_news_runs(iniciado_em desc);
create index if not exists market_news_runs_running_idx on public.market_news_runs(iniciado_em) where status='executando';

create table if not exists public.market_news_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_key text not null, cluster_key text not null,
  titulo text not null check (length(btrim(titulo))>0), url text not null check (length(btrim(url))>0), dominio_fonte text,
  pais_fonte text, idioma text, publicado_em timestamptz not null, detectado_em timestamptz not null default now(),
  categoria text not null default 'outros' check (categoria in ('regulacao','macroeconomia','seguranca','exchange','stablecoin','rede','institucional','projeto','outros')),
  direcao_esperada text not null default 'incerta' check (direcao_esperada in ('positiva','negativa','incerta')),
  confianca_pct numeric not null default 0 check (confianca_pct between 0 and 100),
  novidade text not null default 'nova' check (novidade in ('nova','desdobramento','repeticao')),
  escopo text not null default 'mercado' check (escopo in ('mercado','ativo','misto')),
  motivo_classificacao text, palavras_chave jsonb not null default '[]'::jsonb, raw_payload jsonb not null default '{}'::jsonb,
  duplicado_de uuid references public.market_news_events(id) on delete set null, criado_em timestamptz not null default now(), unique(provider,provider_key)
);
create index if not exists market_news_events_published_idx on public.market_news_events(publicado_em desc);
create index if not exists market_news_events_cluster_idx on public.market_news_events(cluster_key,publicado_em desc);

create table if not exists public.market_news_asset_links (
  event_id uuid not null references public.market_news_events(id) on delete cascade, simbolo text not null,
  relevancia_pct numeric not null default 50 check (relevancia_pct between 0 and 100),
  tipo_relacao text not null default 'mencionado' check (tipo_relacao in ('mencionado','mercado_geral','benchmark')),
  motivo text, criado_em timestamptz not null default now(), primary key(event_id,simbolo)
);

create table if not exists public.market_news_reactions (
  event_id uuid not null references public.market_news_events(id) on delete cascade, simbolo text not null,
  horizonte_minutos integer not null check (horizonte_minutos in (15,60,240,720,1440,4320)), devido_em timestamptz not null,
  processado_em timestamptz, status text not null default 'pendente' check (status in ('pendente','processando','concluido','falhou')),
  preco_inicio numeric, preco_fim numeric, retorno_ativo_pct numeric, benchmark_simbolo text, benchmark_preco_inicio numeric,
  benchmark_preco_fim numeric, retorno_benchmark_pct numeric, retorno_excesso_pct numeric, volume_ratio numeric,
  volatilidade_ratio numeric, direcao_confirmada boolean, impacto text check (impacto is null or impacto in ('irrelevante','baixo','medio','alto')),
  erro text, tentativas integer not null default 0, atualizado_em timestamptz not null default now(), primary key(event_id,simbolo,horizonte_minutos)
);
create index if not exists market_news_reactions_pending_idx on public.market_news_reactions(devido_em) where status in ('pendente','falhou');
create index if not exists market_news_reactions_summary_idx on public.market_news_reactions(simbolo,horizonte_minutos,processado_em desc) where status='concluido';

alter table public.forward_test_validation_runs enable row level security;
alter table public.forward_test_signal_context enable row level security;
alter table public.market_news_runs enable row level security;
alter table public.market_news_events enable row level security;
alter table public.market_news_asset_links enable row level security;
alter table public.market_news_reactions enable row level security;

do $$ begin create policy "validacoes visiveis para autenticados" on public.forward_test_validation_runs for select to authenticated using(true); exception when duplicate_object then null; end $$;
do $$ begin create policy "contextos visiveis para autenticados" on public.forward_test_signal_context for select to authenticated using(true); exception when duplicate_object then null; end $$;
do $$ begin create policy "runs de noticias visiveis para autenticados" on public.market_news_runs for select to authenticated using(true); exception when duplicate_object then null; end $$;
do $$ begin create policy "noticias visiveis para autenticados" on public.market_news_events for select to authenticated using(true); exception when duplicate_object then null; end $$;
do $$ begin create policy "ativos de noticias visiveis para autenticados" on public.market_news_asset_links for select to authenticated using(true); exception when duplicate_object then null; end $$;
do $$ begin create policy "reacoes de noticias visiveis para autenticados" on public.market_news_reactions for select to authenticated using(true); exception when duplicate_object then null; end $$;

grant select on public.forward_test_validation_runs,public.forward_test_signal_context,public.market_news_runs,public.market_news_events,public.market_news_asset_links,public.market_news_reactions to authenticated;

create or replace function public.touch_market_news_reaction_updated_at() returns trigger language plpgsql as $$ begin new.atualizado_em:=now(); return new; end; $$;
drop trigger if exists market_news_reactions_touch_updated_at on public.market_news_reactions;
create trigger market_news_reactions_touch_updated_at before update on public.market_news_reactions for each row execute function public.touch_market_news_reaction_updated_at();

create or replace function public.abandon_stale_validation_news_runs() returns jsonb language plpgsql security definer set search_path=public as $$
declare validation_count integer; news_count integer;
begin
 update public.forward_test_validation_runs set status='falhou',finalizado_em=now(),erro=coalesce(erro,'run abandonado após 2 horas') where status='executando' and iniciado_em<now()-interval '2 hours'; get diagnostics validation_count=row_count;
 update public.market_news_runs set status='falhou',finalizado_em=now(),erro=coalesce(erro,'run abandonado após 2 horas') where status='executando' and iniciado_em<now()-interval '2 hours'; get diagnostics news_count=row_count;
 return jsonb_build_object('validation_runs',validation_count,'news_runs',news_count);
end; $$;
revoke all on function public.abandon_stale_validation_news_runs() from public,anon,authenticated;
grant execute on function public.abandon_stale_validation_news_runs() to service_role;

create or replace view public.forward_test_integrity_summary with (security_invoker=true) as
with duplicate_groups as (
 select config_id,count(*) quantidade from (select config_id,simbolo,timeframe,estrategia,candle_open_time from public.forward_test_signals group by config_id,simbolo,timeframe,estrategia,candle_open_time having count(*)>1) x group by config_id
)
select c.id config_id,count(s.id) sinais_total,
 count(*) filter(where s.entrada_em is not null and s.entrada_em<s.candle_close_time) entradas_antes_do_fechamento,
 count(*) filter(where s.saida_em is not null and s.entrada_em is not null and s.saida_em<s.entrada_em) saidas_antes_da_entrada,
 count(*) filter(where s.status='fechado' and (s.resultado_r is null or s.saida_preco is null or s.saida_em is null)) fechados_incompletos,
 count(*) filter(where s.status<>'fechado' and s.resultado_r is not null) resultados_em_status_invalido,
 count(*) filter(where s.entrada_referencia<=s.stop_referencia or s.alvo_referencia<=s.entrada_referencia) planos_invalidos,
 count(*) filter(where s.risco_efetivo is not null and s.risco_efetivo<=0) riscos_invalidos,
 coalesce(max(d.quantidade),0) grupos_duplicados,
 (count(*) filter(where s.entrada_em is not null and s.entrada_em<s.candle_close_time)+count(*) filter(where s.saida_em is not null and s.entrada_em is not null and s.saida_em<s.entrada_em)+count(*) filter(where s.status='fechado' and (s.resultado_r is null or s.saida_preco is null or s.saida_em is null))+count(*) filter(where s.status<>'fechado' and s.resultado_r is not null)+count(*) filter(where s.entrada_referencia<=s.stop_referencia or s.alvo_referencia<=s.entrada_referencia)+count(*) filter(where s.risco_efetivo is not null and s.risco_efetivo<=0)+coalesce(max(d.quantidade),0))::bigint problemas_total
from public.forward_test_config c left join public.forward_test_signals s on s.config_id=c.id left join duplicate_groups d on d.config_id=c.id group by c.id;

create or replace view public.forward_test_validation_latest with (security_invoker=true) as
select distinct on(config_id) id,config_id,iniciado_em,finalizado_em,status,operacoes_fechadas,sinais_enriquecidos,iteracoes_monte_carlo,seed,parametros,resultado,erro
from public.forward_test_validation_runs where status in('concluido','concluido_com_falhas') order by config_id,iniciado_em desc;

create or replace view public.market_news_impact_summary with (security_invoker=true) as
select e.categoria,e.direcao_esperada,r.horizonte_minutos,count(*) reacoes,round(avg(r.retorno_ativo_pct),6) retorno_medio_ativo_pct,
 round(avg(r.retorno_excesso_pct),6) retorno_medio_excesso_pct,round(avg(abs(r.retorno_excesso_pct)),6) movimento_absoluto_medio_pct,
 round(100.0*avg(case when r.direcao_confirmada then 1.0 else 0.0 end),2) direcao_confirmada_pct,
 count(*) filter(where r.impacto='alto') impactos_altos,count(*) filter(where r.impacto='medio') impactos_medios,
 count(*) filter(where r.impacto in('baixo','irrelevante')) impactos_baixos
from public.market_news_reactions r join public.market_news_events e on e.id=r.event_id where r.status='concluido'
group by e.categoria,e.direcao_esperada,r.horizonte_minutos;

grant select on public.forward_test_integrity_summary,public.forward_test_validation_latest,public.market_news_impact_summary to authenticated;
