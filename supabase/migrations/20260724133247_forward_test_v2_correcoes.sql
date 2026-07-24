-- ============================================================================
-- Correções de auditoria do teste prospectivo.
-- ============================================================================

-- 1. Alvo e risco efetivamente usados pela simulação -------------------------
-- O plano original fica em *_referencia; ao entrar, o alvo é recalculado sobre
-- o preenchimento real para preservar a relação de risco. Sem gravar o valor
-- efetivo, a tela mostrava um alvo diferente do que o backend usou.

alter table public.forward_test_signals
  add column alvo_efetivo numeric,
  add column risco_efetivo numeric,
  add column cancelamento_motivo text;

comment on column public.forward_test_signals.alvo_efetivo is
  'Alvo recalculado sobre o preço real de entrada. É o valor que a simulação usou.';
comment on column public.forward_test_signals.excursao_favoravel_r is
  'Estimativa por extremos do candle, não trajetória real: o OHLC não revela a ordem dos movimentos.';

-- 2. Congelamento de verdade -------------------------------------------------
-- Antes havia apenas um comentário pedindo para não editar. Agora o banco
-- recusa: para mudar qualquer regra é obrigatório desativar a versão e criar
-- outra, o que preserva a rastreabilidade do experimento.

create or replace function public.impedir_edicao_config_congelada()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'Configuração de teste prospectivo não pode ser excluída. Desative-a (ativo = false) para preservar o histórico.';
  end if;

  -- Desativar é permitido; é assim que se encerra uma versão.
  if old.ativo and not new.ativo then
    return new;
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
  then
    raise exception
      'Regras congeladas não podem ser alteradas. Crie uma versão nova: desative esta (ativo = false) e insira outra configuração.';
  end if;

  return new;
end;
$$;

create trigger forward_test_config_congelada
  before update or delete on public.forward_test_config
  for each row execute function public.impedir_edicao_config_congelada();

-- 3. Auditoria de execução ---------------------------------------------------
-- Antes, uma falha do cron sumia sem deixar rastro. Agora cada execução é
-- registrada, com quantos pares foram processados e quais falharam.

create table public.forward_test_runs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.forward_test_config (id),

  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,

  pares_esperados integer,
  pares_processados integer,
  sinais_criados integer default 0,
  sinais_resolvidos integer default 0,

  falhas jsonb default '[]'::jsonb,
  status text not null default 'executando'
    check (status in ('executando', 'concluido', 'falhou')),

  duracao_ms integer
);

comment on table public.forward_test_runs is
  'Auditoria de cada execução do cron. Sem isto, uma falha silenciosa criaria lacunas invisíveis no experimento.';

create index forward_test_runs_recentes_idx
  on public.forward_test_runs (config_id, iniciado_em desc);

alter table public.forward_test_runs enable row level security;

create policy "execucoes visiveis para autenticados"
  on public.forward_test_runs for select to authenticated using (true);

-- 4. Resumo passa a expor config_id ------------------------------------------
-- Sem isso o frontend soma versões diferentes do experimento quando houver v2.

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

comment on view public.forward_test_resumo is
  'Acompanhamento por horizonte. Filtre sempre por config_id: versões diferentes do experimento não devem ser somadas. O horizonte de 1h é controle negativo.';
