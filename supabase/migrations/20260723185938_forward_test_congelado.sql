-- ============================================================================
-- Teste prospectivo (forward test) — regras congeladas.
--
-- Objetivo: medir as estratégias diárias daqui para frente, sem nenhuma das
-- contaminações que invalidaram os backtests (sobrevivência na escolha de
-- moedas, seleção entre dezenas de combinações, ajuste sobre os mesmos dados).
--
-- O valor do experimento vem de as regras NÃO mudarem. Por isso a configuração
-- fica numa tabela separada da produção, com data de congelamento, e qualquer
-- alteração exige criar uma versão nova em vez de editar a existente.
--
-- Nada aqui executa ordens. É registro e medição apenas.
-- ============================================================================

create table public.forward_test_config (
  id uuid primary key default gen_random_uuid(),

  nome text not null,
  versao text not null,

  timeframe text not null,
  estrategias text[] not null,
  simbolos text[] not null,

  -- Custos usados na simulação do resultado.
  fee_rate_pct numeric not null,
  slippage_pct numeric not null,

  -- Distância máxima entre a abertura seguinte e a entrada planejada, em ATR.
  -- Acima disso o sinal é cancelado em vez de entrar com preço ruim.
  max_next_open_distance_atr numeric not null default 0.5,

  observacoes text,

  congelado_em timestamptz not null default now(),
  ativo boolean not null default true,

  criado_em timestamptz not null default now()
);

comment on table public.forward_test_config is
  'Regras congeladas do teste prospectivo. Para mudar algo, crie uma versão nova e desative a anterior — editar invalida o experimento.';

create unique index forward_test_config_ativo_idx
  on public.forward_test_config (ativo)
  where ativo;

create table public.forward_test_signals (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.forward_test_config (id) on delete cascade,

  simbolo text not null,
  estrategia text not null,
  estrategia_versao text,

  -- Candle que gerou o sinal (encerrado).
  candle_open_time timestamptz not null,
  candle_close_time timestamptz not null,
  detectado_em timestamptz not null default now(),

  -- Plano no momento do sinal.
  entrada_referencia numeric not null,
  stop_referencia numeric not null,
  alvo_referencia numeric not null,
  atr numeric,
  score_pct numeric,
  condicoes_atendidas integer,
  condicoes_totais integer,

  -- Ciclo de vida.
  status text not null default 'aguardando_entrada'
    check (status in ('aguardando_entrada', 'aberto', 'fechado', 'cancelado')),

  entrada_preco numeric,
  entrada_em timestamptz,

  saida_preco numeric,
  saida_em timestamptz,
  saida_motivo text
    check (saida_motivo is null or saida_motivo in ('stop', 'alvo', 'cancelado')),

  resultado_r numeric,
  excursao_favoravel_r numeric,
  excursao_adversa_r numeric,

  -- Dimensionamento registrado em paralelo, para comparação honesta.
  -- O tamanho fixo é a referência; o anti-martingale suave multiplica por 1,5
  -- quando a operação anterior do mesmo símbolo e estratégia foi ganhadora.
  tamanho_fixo numeric not null default 1,
  tamanho_anti numeric not null default 1,
  resultado_anterior text
    check (resultado_anterior is null or resultado_anterior in ('ganho', 'perda', 'nenhum')),

  atualizado_em timestamptz not null default now(),

  -- Idempotência: o cron pode rodar mais de uma vez no mesmo dia sem duplicar.
  unique (config_id, simbolo, estrategia, candle_open_time)
);

comment on table public.forward_test_signals is
  'Sinais do teste prospectivo, com resultado simulado e os dois esquemas de tamanho registrados lado a lado.';

create index forward_test_signals_abertos_idx
  on public.forward_test_signals (config_id, simbolo, estrategia)
  where status in ('aguardando_entrada', 'aberto');

create index forward_test_signals_fechados_idx
  on public.forward_test_signals (config_id, simbolo, estrategia, candle_open_time desc)
  where status = 'fechado';

-- ============================================================================
-- Leitura liberada para acompanhamento; escrita somente pelo serviço.
-- ============================================================================

alter table public.forward_test_config enable row level security;
alter table public.forward_test_signals enable row level security;

create policy "config visivel para autenticados"
  on public.forward_test_config for select to authenticated using (true);

create policy "sinais visiveis para autenticados"
  on public.forward_test_signals for select to authenticated using (true);

-- ============================================================================
-- Visão consolidada: compara tamanho fixo contra anti-martingale suave.
-- ============================================================================

create or replace view public.forward_test_resumo as
select
  c.nome,
  c.versao,
  s.estrategia,
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
group by c.nome, c.versao, s.estrategia;

comment on view public.forward_test_resumo is
  'Acompanhamento do teste prospectivo. soma_r_fixo é a referência; soma_r_anti aplica o anti-martingale suave.';
