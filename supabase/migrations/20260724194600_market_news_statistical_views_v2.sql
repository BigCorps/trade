-- VigIA Market News v2 — views estatísticas

create or replace view public.market_news_quality_summary
with (security_invoker = true)
as
select
  count(*)::bigint as eventos_total,
  count(*) filter (where relevancia = 'relevante')::bigint as eventos_relevantes,
  count(*) filter (where relevancia = 'ambigua')::bigint as eventos_ambiguos,
  count(*) filter (where relevancia = 'irrelevante')::bigint as eventos_irrelevantes,
  count(*) filter (where relevancia = 'nao_avaliada')::bigint as eventos_nao_avaliados,
  count(*) filter (where elegivel_reacao)::bigint as eventos_com_reacao,
  count(*) filter (where hipotese_principal_elegivel)::bigint as eventos_confirmatorios,
  count(*) filter (where ativo_principal is not null)::bigint as eventos_com_ativo_explicito,
  round(avg(confianca_pct), 2) as confianca_media_pct,
  round(avg(relevancia_pct), 2) as relevancia_media_pct,
  max(classificador_versao) filter (where classificador_versao <> 'legacy-v1') as classificador_atual
from public.market_news_events;

grant select on public.market_news_quality_summary to authenticated;

create or replace view public.market_news_primary_hypothesis_status
with (security_invoker = true)
as
select
  h.id,
  h.nome,
  h.versao,
  h.descricao,
  h.status,
  h.congelada_em,
  h.inicio_amostra_em,
  h.horizonte_minutos,
  h.confianca_min_pct,
  h.alvo_eventos,
  count(distinct e.id) filter (where e.hipotese_principal_elegivel)::bigint as eventos_elegiveis,
  count(distinct r.event_id) filter (where r.status = 'concluido')::bigint as eventos_concluidos,
  count(distinct r.event_id) filter (where r.status = 'pendente')::bigint as eventos_pendentes,
  round(avg(r.retorno_excesso_pct) filter (where r.status = 'concluido'), 6) as retorno_medio_excesso_pct,
  round(stddev_samp(r.retorno_excesso_pct) filter (where r.status = 'concluido'), 6) as desvio_padrao_excesso_pct,
  round(100.0 * avg(
    case when r.status = 'concluido' then
      case when r.retorno_excesso_pct < -0.25 then 1.0 else 0.0 end
    end
  ), 2) as direcao_confirmada_pct,
  case
    when count(distinct r.event_id) filter (where r.status = 'concluido') < h.alvo_eventos then 'coletando'
    else 'amostra_alvo_atingida'
  end as situacao_amostra
from public.market_news_hypotheses h
left join public.market_news_events e
  on e.hipotese_principal_id = h.id
 and e.hipotese_principal_elegivel
left join public.market_news_reactions r
  on r.event_id = e.id
 and r.hipotese_id = h.id
 and r.papel_analise = 'confirmatoria'
 and r.observacao_independente
where h.status = 'ativa'
group by h.id;

grant select on public.market_news_primary_hypothesis_status to authenticated;

drop view if exists public.market_news_impact_summary;

create view public.market_news_impact_summary
with (security_invoker = true)
as
with event_level as (
  select
    e.id as event_id,
    e.categoria,
    e.direcao_esperada,
    r.papel_analise,
    r.horizonte_minutos,
    count(*)::integer as linhas_reacao,
    avg(r.retorno_excesso_pct)::double precision as retorno_evento_pct
  from public.market_news_reactions r
  join public.market_news_events e on e.id = r.event_id
  where r.status = 'concluido'
    and e.relevancia = 'relevante'
    and e.elegivel_reacao
  group by e.id, e.categoria, e.direcao_esperada, r.papel_analise, r.horizonte_minutos
), stats as (
  select
    categoria,
    direcao_esperada,
    papel_analise,
    horizonte_minutos,
    count(*)::bigint as eventos_independentes,
    sum(linhas_reacao)::bigint as linhas_reacao,
    avg(retorno_evento_pct) as media,
    stddev_samp(retorno_evento_pct) as desvio,
    avg(abs(retorno_evento_pct)) as movimento_absoluto,
    avg(case
      when direcao_esperada = 'positiva' then case when retorno_evento_pct > 0.25 then 1.0 else 0.0 end
      when direcao_esperada = 'negativa' then case when retorno_evento_pct < -0.25 then 1.0 else 0.0 end
      else null
    end) as confirmacao,
    count(*) filter (where abs(retorno_evento_pct) >= 2)::bigint as impactos_altos,
    count(*) filter (where abs(retorno_evento_pct) >= 0.75 and abs(retorno_evento_pct) < 2)::bigint as impactos_medios,
    count(*) filter (where abs(retorno_evento_pct) < 0.75)::bigint as impactos_baixos
  from event_level
  group by categoria, direcao_esperada, papel_analise, horizonte_minutos
), tested as (
  select *,
    case
      when eventos_independentes >= 5 and desvio is not null and desvio > 0 then
        2.0 * (1.0 - public.normal_cdf_approx(abs(media / (desvio / sqrt(eventos_independentes::double precision)))))
      else null
    end as p_value
  from stats
), ranked as (
  select *,
    case when p_value is not null then row_number() over (partition by papel_analise order by p_value) end as p_rank,
    count(p_value) over (partition by papel_analise) as testes_validos
  from tested
), raw_adjusted as (
  select *,
    case
      when p_value is null then null
      else least(1.0, p_value * testes_validos / p_rank)
    end as q_raw
  from ranked
), adjusted as (
  select *,
    case
      when q_raw is null then null
      else min(q_raw) over (
        partition by papel_analise
        order by p_value desc
        rows between unbounded preceding and current row
      )
    end as q_value
  from raw_adjusted
)
select
  categoria,
  direcao_esperada,
  papel_analise,
  horizonte_minutos,
  eventos_independentes,
  linhas_reacao,
  round(media::numeric, 6) as retorno_medio_excesso_pct,
  round(movimento_absoluto::numeric, 6) as movimento_absoluto_medio_pct,
  round((100.0 * confirmacao)::numeric, 2) as direcao_confirmada_pct,
  impactos_altos,
  impactos_medios,
  impactos_baixos,
  round(p_value::numeric, 6) as p_value,
  round(q_value::numeric, 6) as q_value_fdr,
  (q_value is not null and q_value < 0.05) as significativo_fdr
from adjusted;

grant select on public.market_news_impact_summary to authenticated;

create or replace view public.market_news_classifier_validation_summary
with (security_invoker = true)
as
select
  count(*)::bigint as revisoes_total,
  round(100.0 * avg(case when r.relevancia_manual = e.relevancia then 1.0 else 0.0 end), 2) as acuracia_relevancia_pct,
  round(100.0 * avg(case when r.categoria_manual = e.categoria then 1.0 else 0.0 end), 2) as acuracia_categoria_pct,
  round(100.0 * avg(case when r.direcao_manual = e.direcao_esperada then 1.0 else 0.0 end), 2) as acuracia_direcao_pct,
  count(*) filter (where r.relevancia_manual = 'relevante')::bigint as relevantes_manuais,
  count(*) filter (where r.relevancia_manual = 'ambigua')::bigint as ambiguos_manuais,
  count(*) filter (where r.relevancia_manual = 'irrelevante')::bigint as irrelevantes_manuais,
  max(r.revisado_em) as ultima_revisao_em
from public.market_news_classifier_reviews r
join public.market_news_events e on e.id = r.event_id;

grant select on public.market_news_classifier_validation_summary to authenticated;

comment on view public.market_news_impact_summary is
  'Análise exploratória agrupada primeiro por evento. P e q-FDR são indicativos; células com menos de 5 eventos não recebem teste.';
comment on view public.market_news_primary_hypothesis_status is
  'Hipótese confirmatória congelada. Uma única reação por evento é marcada como observação independente.';
