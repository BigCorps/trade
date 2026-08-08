-- =============================================================================
-- VigIA Trade — Disciplina estatística da pesquisa
-- =============================================================================
--
-- O QUE ESTA MIGRAÇÃO RESOLVE
-- ---------------------------
-- A auditoria de 07/08/2026 mostrou que as baterias de walk-forward testavam
-- 64 a 72 combinações e escolhiam a melhor. Isso produz um "vencedor" mesmo
-- em dados aleatórios: nas três baterias, o melhor t observado ficou ABAIXO
-- do que o ruído puro produziria.
--
-- Esta migração torna esse erro difícil de cometer:
--
--   1. hipoteses_pesquisa       — a hipótese é declarada ANTES de olhar os
--                                 dados, com critério de morte definido.
--   2. hipotese_combinacoes     — toda combinação testada é contada,
--                                 inclusive as descartadas. Sem isso a
--                                 correção estatística fica subestimada.
--   3. vw_*                     — leituras honestas do forward test.
--   4. avaliar_portao_execucao  — o portão só abre por critério objetivo.
--   5. trigger de guarda        — impede habilitar execução manualmente.
--
-- SEGURANÇA: nada aqui executa ordens. O efeito prático é tornar MAIS
-- difícil habilitar execução real, nunca mais fácil.
--
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Pré-registro de hipóteses
-- -----------------------------------------------------------------------------

create table if not exists public.hipoteses_pesquisa (
  id uuid primary key default gen_random_uuid(),

  nome text not null,
  -- A pergunta em uma frase, em linguagem comum. Se não couber numa frase,
  -- a hipótese ainda não está clara o bastante para ser testada.
  pergunta text not null,

  -- Por que esta hipótese deveria funcionar? Qual comportamento de mercado
  -- ela captura? "O indicador X cruzou" não é razão — é descrição.
  fundamento_economico text not null,

  simbolos text[] not null,
  timeframes text[] not null,
  estrategias text[] not null,

  -- CRITÉRIOS DEFINIDOS ANTES DE VER OS DADOS
  amostra_minima integer not null default 100,
  t_minimo_exigido numeric not null default 2.5,
  criterio_morte text not null,

  -- Contagem honesta de tudo que foi testado nesta linha de pesquisa.
  -- Inclui baterias anteriores sobre os mesmos dados.
  combinacoes_testadas integer not null default 0,

  status text not null default 'registrada'
    check (status in ('registrada','coletando','aprovada','morta','suspensa')),

  registrada_em timestamptz not null default now(),
  congelada_em timestamptz,
  encerrada_em timestamptz,
  motivo_encerramento text,

  criada_por uuid references auth.users(id) on delete set null,

  constraint hipoteses_amostra_positiva check (amostra_minima >= 30),
  constraint hipoteses_t_razoavel check (t_minimo_exigido >= 1.96)
);

comment on table public.hipoteses_pesquisa is
  'Hipóteses declaradas ANTES da coleta. Editar campos de uma hipótese que já '
  'está coletando invalida o experimento: crie uma nova versão.';

comment on column public.hipoteses_pesquisa.combinacoes_testadas is
  'Total de combinações testadas nesta linha de pesquisa, incluindo as '
  'descartadas. Subestimar este número infla artificialmente a significância.';

comment on column public.hipoteses_pesquisa.criterio_morte is
  'A condição que encerra a hipótese, escrita antes de começar. Sem critério '
  'de morte, uma hipótese nunca morre — apenas ganha desculpas.';

create index if not exists idx_hipoteses_status
  on public.hipoteses_pesquisa (status, registrada_em desc);

-- Congela a hipótese assim que a coleta começa.
create or replace function public.impedir_edicao_hipotese_congelada()
returns trigger
language plpgsql
as $$
begin
  if old.congelada_em is not null then
    if new.simbolos is distinct from old.simbolos
       or new.timeframes is distinct from old.timeframes
       or new.estrategias is distinct from old.estrategias
       or new.amostra_minima is distinct from old.amostra_minima
       or new.t_minimo_exigido is distinct from old.t_minimo_exigido
       or new.criterio_morte is distinct from old.criterio_morte
    then
      raise exception
        'Hipótese % está congelada desde %. Alterar escopo ou critérios agora '
        'invalidaria o experimento. Registre uma nova hipótese.',
        old.nome, old.congelada_em
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hipotese_congelada on public.hipoteses_pesquisa;
create trigger trg_hipotese_congelada
  before update on public.hipoteses_pesquisa
  for each row execute function public.impedir_edicao_hipotese_congelada();

-- -----------------------------------------------------------------------------
-- 2. Registro de toda combinação testada
-- -----------------------------------------------------------------------------

create table if not exists public.hipotese_combinacoes (
  id uuid primary key default gen_random_uuid(),
  hipotese_id uuid not null references public.hipoteses_pesquisa(id) on delete cascade,

  simbolo text not null,
  timeframe text not null,
  estrategia text not null,
  gestao text,

  operacoes integer not null default 0,
  soma_r numeric,
  media_r numeric,
  desvio_r numeric,
  t_observado numeric,

  -- Preenchidos pela avaliação, não pela mão.
  piso_ruido numeric,
  t_exigido numeric,
  p_corrigido numeric,
  sharpe_deflacionado numeric,
  veredito text,

  avaliada_em timestamptz not null default now(),

  unique (hipotese_id, simbolo, timeframe, estrategia, gestao)
);

comment on table public.hipotese_combinacoes is
  'Toda combinação testada, inclusive as ruins. Contar apenas as boas é '
  'exatamente o viés que a correção por múltiplos testes existe para remover.';

create index if not exists idx_combinacoes_hipotese
  on public.hipotese_combinacoes (hipotese_id, t_observado desc nulls last);

-- Mantém combinacoes_testadas em dia automaticamente.
create or replace function public.sincronizar_contagem_combinacoes()
returns trigger
language plpgsql
as $$
declare
  alvo uuid := coalesce(new.hipotese_id, old.hipotese_id);
begin
  update public.hipoteses_pesquisa h
     set combinacoes_testadas = (
           select count(*) from public.hipotese_combinacoes c
            where c.hipotese_id = alvo
         )
   where h.id = alvo;
  return null;
end;
$$;

drop trigger if exists trg_contagem_combinacoes on public.hipotese_combinacoes;
create trigger trg_contagem_combinacoes
  after insert or delete on public.hipotese_combinacoes
  for each row execute function public.sincronizar_contagem_combinacoes();

-- -----------------------------------------------------------------------------
-- 3. Funções estatísticas
-- -----------------------------------------------------------------------------

-- Piso de ruído: t esperado do melhor de n testes sob a hipótese nula.
-- Aproximação de Gumbel para o máximo de n normais padrão.
create or replace function public.piso_ruido_t(n_testes integer)
returns numeric
language plpgsql
immutable
as $$
declare
  ln_n numeric;
  raiz numeric;
begin
  if n_testes is null or n_testes <= 1 then
    return 0;
  end if;

  ln_n := ln(n_testes::numeric);
  raiz := sqrt(2 * ln_n);

  if n_testes < 3 then
    return raiz;
  end if;

  return raiz - (ln(ln_n) + ln(4 * pi()::numeric)) / (2 * raiz);
end;
$$;

comment on function public.piso_ruido_t is
  'O t que o acaso produziria como melhor de n tentativas. Um resultado '
  'abaixo deste valor não é notícia, por maior que pareça a soma de R.';

-- CDF da normal padrão via erf.
create or replace function public.normal_cdf(z numeric)
returns numeric
language plpgsql
immutable
as $$
declare
  sinal integer;
  x numeric;
  t numeric;
  poli numeric;
begin
  if z is null then return null; end if;

  sinal := case when z < 0 then -1 else 1 end;
  x := abs(z) / sqrt(2);

  t := 1 / (1 + 0.3275911 * x);
  poli := t * (0.254829592
        + t * (-0.284496736
        + t * (1.421413741
        + t * (-1.453152027
        + t * 1.061405429))));

  return 0.5 * (1 + sinal * (1 - poli * exp(-x * x)));
end;
$$;

-- p corrigido pela família de testes (Šidák).
create or replace function public.p_corrigido_sidak(t_obs numeric, n_testes integer)
returns numeric
language plpgsql
immutable
as $$
declare
  p_simples numeric;
begin
  if t_obs is null then return null; end if;

  p_simples := 1 - public.normal_cdf(t_obs);

  if n_testes is null or n_testes <= 1 then
    return p_simples;
  end if;

  return 1 - power(1 - greatest(0, least(1, p_simples)), n_testes);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Leituras honestas do forward test
-- -----------------------------------------------------------------------------

create or replace view public.vw_forward_test_evidencia as
with fechados as (
  select
    estrategia,
    timeframe,
    count(*)::integer                                    as operacoes,
    sum(resultado_r)                                     as soma_r,
    avg(resultado_r)                                     as media_r,
    stddev_samp(resultado_r)                             as desvio_r,
    count(*) filter (where resultado_r > 0)::integer     as ganhos,
    count(*) filter (where resultado_r <= 0)::integer    as perdas,
    avg(resultado_r) filter (where saida_motivo = 'alvo')  as ganho_medio_r,
    avg(resultado_r) filter (where saida_motivo = 'stop')  as perda_media_r,
    avg(excursao_favoravel_r) filter (where saida_motivo = 'stop') as mfe_perdedoras_r,
    max(excursao_favoravel_r) filter (where saida_motivo = 'stop') as mfe_max_perdedoras_r,
    min(candle_close_time)                               as primeiro_sinal,
    max(candle_close_time)                               as ultimo_sinal
  from public.forward_test_signals
  where status = 'fechado'
    and resultado_r is not null
  group by estrategia, timeframe
),
com_t as (
  select
    f.*,
    case
      when desvio_r > 0 and operacoes > 1
      then (media_r / desvio_r) * sqrt(operacoes)
    end as t_observado,
    -- Toda combinação estratégia × timeframe presente conta como teste.
    (select count(distinct (estrategia, timeframe))
       from public.forward_test_signals)::integer as combinacoes_no_experimento
  from fechados f
)
select
  estrategia,
  timeframe,
  operacoes,
  round(soma_r, 2)        as soma_r,
  round(media_r, 3)       as media_r,
  round(desvio_r, 3)      as desvio_r,
  ganhos,
  perdas,
  round(100.0 * ganhos / nullif(operacoes, 0), 1) as acerto_pct,

  round(ganho_medio_r, 3) as ganho_medio_r,
  round(perda_media_r, 3) as perda_media_r,

  -- Acerto necessário para empatar, com o payoff REAL entregue.
  round(
    100.0 * abs(perda_media_r) / nullif(abs(ganho_medio_r) + abs(perda_media_r), 0),
    1
  ) as acerto_equilibrio_pct,

  -- Quanto o stop custou além de 1 R. Positivo = derrapagem.
  round(abs(perda_media_r) - 1, 3) as derrapagem_stop_r,

  -- O teste decisivo: as perdedoras andam a favor antes de morrer?
  round(mfe_perdedoras_r, 3)     as mfe_perdedoras_r,
  round(mfe_max_perdedoras_r, 3) as mfe_max_perdedoras_r,
  case
    when mfe_perdedoras_r is null then 'sem dados'
    when mfe_perdedoras_r >= 0.8  then 'entrada acerta — vale ajustar gestão de saída'
    else 'entrada não acerta — gestão de saída não resolve'
  end as diagnostico_entrada,

  round(t_observado, 2)                                as t_observado,
  combinacoes_no_experimento,
  round(public.piso_ruido_t(combinacoes_no_experimento), 2) as piso_ruido,
  round(public.p_corrigido_sidak(t_observado, combinacoes_no_experimento), 4) as p_corrigido,

  case
    when operacoes < 30 then 'amostra insuficiente'
    when t_observado <= -public.piso_ruido_t(combinacoes_no_experimento)
      then 'edge negativo significativo — encerrar'
    when t_observado < public.piso_ruido_t(combinacoes_no_experimento)
      then 'indistinguível de ruído'
    when public.p_corrigido_sidak(t_observado, combinacoes_no_experimento) < 0.05
      then 'evidência sobrevive à correção'
    else 'promissor, sem confirmação'
  end as veredito,

  primeiro_sinal,
  ultimo_sinal
from com_t
order by soma_r;

comment on view public.vw_forward_test_evidencia is
  'Leitura do forward test já corrigida por múltiplos testes. Ordenada do '
  'pior para o melhor de propósito: o topo de uma tabela ordenada por lucro '
  'é onde o viés de seleção se esconde.';

-- Decomposição sinal × fricção do experimento inteiro.
create or replace view public.vw_decomposicao_edge as
with base as (
  select
    count(*) filter (where saida_motivo = 'alvo')::numeric as ganhos,
    count(*) filter (where saida_motivo = 'stop')::numeric as perdas,
    avg(resultado_r) filter (where saida_motivo = 'alvo')  as ganho_medio_r,
    abs(avg(resultado_r) filter (where saida_motivo = 'stop')) as perda_media_r,
    avg(
      abs(alvo_referencia - entrada_referencia)
      / nullif(abs(entrada_referencia - stop_referencia), 0)
    ) as rr_planejado,
    avg(resultado_r) as expectativa_real_r,
    avg(
      abs(entrada_referencia - stop_referencia)
      / nullif(entrada_referencia, 0) * 100
    ) as stop_pct_preco
  from public.forward_test_signals
  where status = 'fechado' and resultado_r is not null
)
select
  (ganhos + perdas)::integer                    as operacoes,
  round(ganhos / nullif(ganhos + perdas, 0), 4) as taxa_acerto,
  round(rr_planejado, 2)                        as rr_planejado,
  round(ganho_medio_r, 3)                       as ganho_medio_r,
  round(perda_media_r, 3)                       as perda_media_r,
  round(expectativa_real_r, 3)                  as expectativa_real_r,

  -- Contrafactual: alvo entrega o planejado, stop custa exatamente 1 R.
  round(
    (ganhos / nullif(ganhos + perdas, 0)) * rr_planejado
    - (perdas / nullif(ganhos + perdas, 0)) * 1,
    3
  ) as expectativa_sem_friccao_r,

  round(
    expectativa_real_r - (
      (ganhos / nullif(ganhos + perdas, 0)) * rr_planejado
      - (perdas / nullif(ganhos + perdas, 0)) * 1
    ),
    3
  ) as custo_friccao_r,

  round(stop_pct_preco, 3) as stop_pct_preco,

  case
    when (ganhos / nullif(ganhos + perdas, 0)) * rr_planejado
       - (perdas / nullif(ganhos + perdas, 0)) < 0
      then 'sinal — a entrada não prevê; trocar hipótese'
    else 'fricção — o sinal existe; reduzir custo ou alargar stop'
  end as problema_principal
from base;

comment on view public.vw_decomposicao_edge is
  'Separa prejuízo por sinal ruim de prejuízo por custo. Exigem correções '
  'diferentes e confundi-los custa meses.';

-- -----------------------------------------------------------------------------
-- 5. Portão de execução por critério objetivo
-- -----------------------------------------------------------------------------

create or replace function public.avaliar_portao_execucao(
  p_estrategia text,
  p_timeframe text default null
)
returns table (
  estrategia text,
  timeframe text,
  operacoes integer,
  t_observado numeric,
  piso_ruido numeric,
  p_corrigido numeric,
  aprovado boolean,
  motivo text
)
language plpgsql
stable
as $$
begin
  return query
  select
    v.estrategia,
    v.timeframe,
    v.operacoes,
    v.t_observado,
    v.piso_ruido,
    v.p_corrigido,
    (
      v.operacoes >= 100
      and v.t_observado is not null
      and v.t_observado > v.piso_ruido
      and v.p_corrigido < 0.05
    ) as aprovado,
    case
      when v.operacoes < 100 then
        format('Faltam %s operações para a amostra mínima de 100.',
               100 - v.operacoes)
      when v.t_observado is null then
        'Sem variabilidade suficiente para calcular t.'
      when v.t_observado <= -v.piso_ruido then
        format('Edge negativo significativo (t = %s). Encerrar a hipótese.',
               round(v.t_observado, 2))
      when v.t_observado <= v.piso_ruido then
        format('t = %s não supera o piso de ruído %s para %s combinações.',
               round(v.t_observado, 2), v.piso_ruido, v.combinacoes_no_experimento)
      when v.p_corrigido >= 0.05 then
        format('p corrigido = %s. Acima de 0,05.', v.p_corrigido)
      else
        format('Aprovado: t = %s supera o piso %s, p corrigido = %s.',
               round(v.t_observado, 2), v.piso_ruido, v.p_corrigido)
    end as motivo
  from public.vw_forward_test_evidencia v
  where v.estrategia = p_estrategia
    and (p_timeframe is null or v.timeframe = p_timeframe);
end;
$$;

comment on function public.avaliar_portao_execucao is
  'Única fonte autorizada para liberar execução. Critérios fixos e objetivos, '
  'avaliados sobre dados prospectivos.';

-- -----------------------------------------------------------------------------
-- 6. Guarda contra habilitação manual
-- -----------------------------------------------------------------------------

create or replace function public.guardar_portao_execucao()
returns trigger
language plpgsql
as $$
declare
  avaliacao record;
begin
  -- Desabilitar é sempre permitido.
  if new.execution_enabled is not true then
    return new;
  end if;

  if old.execution_enabled is true then
    return new;
  end if;

  select * into avaliacao
    from public.avaliar_portao_execucao(new.strategy)
   where aprovado is true
   limit 1;

  if avaliacao is null then
    raise exception
      'Execução de "%" não pode ser habilitada: nenhum timeframe passou na '
      'avaliação estatística prospectiva. Consulte '
      'select * from avaliar_portao_execucao(''%'');',
      new.strategy, new.strategy
      using errcode = 'check_violation',
            hint = 'O portão existe para proteger capital de decisões tomadas '
                   'sob impaciência. Se quiser mesmo assim, desative este '
                   'trigger conscientemente — e registre por quê.';
  end if;

  new.validated_at := now();
  new.reason := format(
    'Habilitado em %s por avaliação automática: %s',
    to_char(now(), 'YYYY-MM-DD HH24:MI'),
    avaliacao.motivo
  );

  return new;
end;
$$;

drop trigger if exists trg_guardar_portao on public.daytrade_strategy_execution_policy;
create trigger trg_guardar_portao
  before update on public.daytrade_strategy_execution_policy
  for each row execute function public.guardar_portao_execucao();

comment on function public.guardar_portao_execucao is
  'Impede habilitar execução real sem aprovação estatística. Desabilitar '
  'permanece sempre livre — a proteção é assimétrica de propósito.';

-- -----------------------------------------------------------------------------
-- 7. Permissões
-- -----------------------------------------------------------------------------

alter table public.hipoteses_pesquisa   enable row level security;
alter table public.hipotese_combinacoes enable row level security;

drop policy if exists hipoteses_leitura on public.hipoteses_pesquisa;
create policy hipoteses_leitura on public.hipoteses_pesquisa
  for select to authenticated using (true);

drop policy if exists hipoteses_escrita on public.hipoteses_pesquisa;
create policy hipoteses_escrita on public.hipoteses_pesquisa
  for all to authenticated using (true) with check (true);

drop policy if exists combinacoes_leitura on public.hipotese_combinacoes;
create policy combinacoes_leitura on public.hipotese_combinacoes
  for select to authenticated using (true);

drop policy if exists combinacoes_escrita on public.hipotese_combinacoes;
create policy combinacoes_escrita on public.hipotese_combinacoes
  for all to authenticated using (true) with check (true);

grant select on public.vw_forward_test_evidencia to authenticated;
grant select on public.vw_decomposicao_edge      to authenticated;
grant execute on function public.avaliar_portao_execucao(text, text) to authenticated;
grant execute on function public.piso_ruido_t(integer)               to authenticated;
grant execute on function public.p_corrigido_sidak(numeric, integer) to authenticated;
grant execute on function public.normal_cdf(numeric)                 to authenticated;

commit;

-- =============================================================================
-- VERIFICAÇÃO — rode após aplicar
-- =============================================================================
--
--   select * from vw_forward_test_evidencia;
--   select * from vw_decomposicao_edge;
--   select * from avaliar_portao_execucao('trend_pullback');
--
-- Com os dados de 07/08/2026, o portão deve recusar todas as estratégias.
-- Se alguma passar, investigue antes de comemorar.
-- =============================================================================
