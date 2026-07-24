-- VigIA Market News v2
-- Relevância, hipótese confirmatória congelada, unidade independente por evento,
-- FDR para análises exploratórias e fluxo de validação manual do classificador.

alter table public.market_news_events
  add column if not exists resumo text,
  add column if not exists relevancia text not null default 'nao_avaliada',
  add column if not exists relevancia_pct numeric not null default 0,
  add column if not exists motivo_relevancia text,
  add column if not exists classificador_versao text not null default 'legacy-v1',
  add column if not exists ativo_principal text,
  add column if not exists elegivel_reacao boolean not null default false,
  add column if not exists hipotese_principal_id uuid,
  add column if not exists hipotese_principal_elegivel boolean not null default false;

alter table public.market_news_events
  drop constraint if exists market_news_events_relevancia_check,
  add constraint market_news_events_relevancia_check
    check (relevancia = any (array['nao_avaliada','relevante','ambigua','irrelevante'])),
  drop constraint if exists market_news_events_relevancia_pct_check,
  add constraint market_news_events_relevancia_pct_check
    check (relevancia_pct >= 0 and relevancia_pct <= 100),
  drop constraint if exists market_news_events_categoria_check,
  add constraint market_news_events_categoria_check
    check (categoria = any (array[
      'regulacao','macroeconomia','seguranca','exchange','stablecoin','rede',
      'institucional','projeto','mercado','mineracao','pagamentos','outros'
    ]));

create table if not exists public.market_news_hypotheses (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  versao text not null unique,
  descricao text not null,
  status text not null default 'ativa'
    check (status = any (array['ativa','encerrada'])),
  congelada_em timestamptz not null default now(),
  inicio_amostra_em timestamptz not null,
  fim_amostra_em timestamptz,
  categoria text,
  direcao_esperada text not null
    check (direcao_esperada = any (array['positiva','negativa'])),
  horizonte_minutos integer not null
    check (horizonte_minutos = any (array[15,60,240,720,1440,4320])),
  confianca_min_pct numeric not null default 70
    check (confianca_min_pct >= 0 and confianca_min_pct <= 100),
  exige_ativo_explicito boolean not null default true,
  relevancia_exigida text not null default 'relevante'
    check (relevancia_exigida = any (array['relevante','ambigua'])),
  metrica_principal text not null default 'retorno_excesso_pct',
  alvo_eventos integer not null default 100 check (alvo_eventos > 0),
  criado_em timestamptz not null default now()
);

create unique index if not exists market_news_one_active_hypothesis_idx
  on public.market_news_hypotheses ((status))
  where status = 'ativa';

insert into public.market_news_hypotheses (
  nome, versao, descricao, status, inicio_amostra_em, categoria,
  direcao_esperada, horizonte_minutos, confianca_min_pct,
  exige_ativo_explicito, relevancia_exigida, metrica_principal, alvo_eventos
)
select
  'Notícias negativas com ativo explícito — 60 minutos',
  'market-negative-explicit-v1',
  'Hipótese congelada antes da nova amostra: eventos relevantes e negativos, com confiança mínima de 70% e ativo principal explicitamente mencionado, produzem retorno em excesso negativo no horizonte de 60 minutos. Uma observação confirmatória por evento.',
  'ativa',
  now(),
  null,
  'negativa',
  60,
  70,
  true,
  'relevante',
  'retorno_excesso_pct',
  100
where not exists (
  select 1 from public.market_news_hypotheses where status = 'ativa'
);

alter table public.market_news_events
  drop constraint if exists market_news_events_hipotese_principal_id_fkey,
  add constraint market_news_events_hipotese_principal_id_fkey
    foreign key (hipotese_principal_id)
    references public.market_news_hypotheses(id)
    on delete set null;

alter table public.market_news_reactions
  add column if not exists papel_analise text not null default 'exploratoria',
  add column if not exists hipotese_id uuid,
  add column if not exists observacao_independente boolean not null default false;

alter table public.market_news_reactions
  drop constraint if exists market_news_reactions_papel_analise_check,
  add constraint market_news_reactions_papel_analise_check
    check (papel_analise = any (array['confirmatoria','exploratoria'])),
  drop constraint if exists market_news_reactions_hipotese_id_fkey,
  add constraint market_news_reactions_hipotese_id_fkey
    foreign key (hipotese_id)
    references public.market_news_hypotheses(id)
    on delete set null,
  drop constraint if exists market_news_reactions_status_check,
  add constraint market_news_reactions_status_check
    check (status = any (array['pendente','processando','concluido','falhou','descartado']));

create index if not exists market_news_events_relevance_idx
  on public.market_news_events (relevancia, elegivel_reacao, publicado_em desc);
create index if not exists market_news_events_hypothesis_idx
  on public.market_news_events (hipotese_principal_id, hipotese_principal_elegivel, publicado_em desc);
create index if not exists market_news_reactions_role_idx
  on public.market_news_reactions (papel_analise, horizonte_minutos, status, processado_em desc);

-- Todo o histórico anterior ao congelamento continua somente exploratório.
update public.market_news_events
set classificador_versao = case
      when classificador_versao is null or classificador_versao = '' then 'legacy-v1'
      else classificador_versao
    end,
    hipotese_principal_id = null,
    hipotese_principal_elegivel = false
where publicado_em < (
  select inicio_amostra_em from public.market_news_hypotheses where status = 'ativa' limit 1
);

update public.market_news_reactions
set papel_analise = 'exploratoria',
    hipotese_id = null,
    observacao_independente = false
where hipotese_id is null
   or event_id in (
      select e.id
      from public.market_news_events e
      cross join lateral (
        select inicio_amostra_em
        from public.market_news_hypotheses
        where status = 'ativa'
        limit 1
      ) h
      where e.publicado_em < h.inicio_amostra_em
   );

create table if not exists public.market_news_classifier_reviews (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique
    references public.market_news_events(id) on delete cascade,
  relevancia_manual text not null
    check (relevancia_manual = any (array['relevante','ambigua','irrelevante'])),
  categoria_manual text not null
    check (categoria_manual = any (array[
      'regulacao','macroeconomia','seguranca','exchange','stablecoin','rede',
      'institucional','projeto','mercado','mineracao','pagamentos','outros'
    ])),
  direcao_manual text not null
    check (direcao_manual = any (array['positiva','negativa','incerta'])),
  ativo_principal_manual text,
  observacoes text,
  classificador_versao text not null,
  revisado_por uuid default auth.uid(),
  revisado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table public.market_news_hypotheses enable row level security;
alter table public.market_news_classifier_reviews enable row level security;

revoke all on public.market_news_hypotheses from anon;
revoke all on public.market_news_classifier_reviews from anon;
grant select on public.market_news_hypotheses to authenticated;
grant select, insert, update on public.market_news_classifier_reviews to authenticated;

drop policy if exists "hipoteses de noticias visiveis para autenticados" on public.market_news_hypotheses;
create policy "hipoteses de noticias visiveis para autenticados"
  on public.market_news_hypotheses for select to authenticated using (true);

drop policy if exists "revisoes de classificador visiveis para autenticados" on public.market_news_classifier_reviews;
create policy "revisoes de classificador visiveis para autenticados"
  on public.market_news_classifier_reviews for select to authenticated using (true);
drop policy if exists "revisoes de classificador criadas por autenticados" on public.market_news_classifier_reviews;
create policy "revisoes de classificador criadas por autenticados"
  on public.market_news_classifier_reviews for insert to authenticated
  with check (revisado_por = auth.uid());
drop policy if exists "revisoes de classificador atualizadas por autenticados" on public.market_news_classifier_reviews;
create policy "revisoes de classificador atualizadas por autenticados"
  on public.market_news_classifier_reviews for update to authenticated
  using (revisado_por = auth.uid())
  with check (revisado_por = auth.uid());

create or replace function public.normal_cdf_approx(z double precision)
returns double precision
language plpgsql
immutable
strict
as $$
declare
  x double precision := abs(z);
  t double precision := 1.0 / (1.0 + 0.2316419 * x);
  d double precision := 0.3989422804014327 * exp(-0.5 * x * x);
  p double precision;
begin
  p := 1.0 - d * t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  return case when z >= 0 then p else 1.0 - p end;
end;
$$;

