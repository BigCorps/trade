-- ============================================================================
-- Teste prospectivo (forward test) — regras congeladas.
--
-- JÁ APLICADA NA PRODUÇÃO em 23/07/2026 via MCP, junto com a configuração
-- inicial e o cron diário. Este arquivo existe para o repositório refletir o
-- estado real do banco.
--
-- Objetivo: medir as estratégias diárias daqui para frente, sem nenhuma das
-- contaminações que invalidaram os backtests (sobrevivência na escolha de
-- moedas, seleção entre dezenas de combinações, ajuste sobre os mesmos dados).
--
-- O valor do experimento vem de as regras NÃO mudarem. Por isso a configuração
-- fica separada da produção, com data de congelamento, e qualquer alteração
-- exige criar uma versão nova em vez de editar a existente.
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

  fee_rate_pct numeric not null,
  slippage_pct numeric not null,

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

  candle_open_time timestamptz not null,
  candle_close_time timestamptz not null,
  detectado_em timestamptz not null default now(),

  entrada_referencia numeric not null,
  stop_referencia numeric not null,
  alvo_referencia numeric not null,
  atr numeric,
  score_pct numeric,
  condicoes_atendidas integer,
  condicoes_totais integer,

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

  tamanho_fixo numeric not null default 1,
  tamanho_anti numeric not null default 1,
  resultado_anterior text
    check (resultado_anterior is null or resultado_anterior in ('ganho', 'perda', 'nenhum')),

  atualizado_em timestamptz not null default now(),

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

alter table public.forward_test_config enable row level security;
alter table public.forward_test_signals enable row level security;

create policy "config visivel para autenticados"
  on public.forward_test_config for select to authenticated using (true);

create policy "sinais visiveis para autenticados"
  on public.forward_test_signals for select to authenticated using (true);

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

-- ============================================================================
-- Configuração inicial congelada.
-- ============================================================================

insert into public.forward_test_config (
  nome, versao, timeframe, estrategias, simbolos,
  fee_rate_pct, slippage_pct, max_next_open_distance_atr, observacoes
) values (
  'Tendência diária — cesta ampla',
  '1.0.0',
  '1d',
  array['trend_breakout', 'trend_pullback'],
  array[
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT',
    'AVAXUSDT','LINKUSDT','LTCUSDT','TRXUSDT','DOTUSDT','MATICUSDT','ATOMUSDT',
    'NEARUSDT','FILUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT'
  ],
  0.1, 0.05, 0.5,
  'Regras congeladas em 23/07/2026. Cesta escolhida por liquidez, sem seleção por desempenho passado. Tamanho fixo é a referência; anti-martingale suave (x1,5 após ganho) registrado em paralelo. Nenhuma ordem é executada.'
);

-- ============================================================================
-- Cron diário (00:20 UTC, após o fechamento do candle diário da Binance).
-- ============================================================================

-- select cron.schedule(
--   'forward-test-diario',
--   '20 0 * * *',
--   $$
--     select net.http_post(
--       url := 'https://vigiatrade.com/api/forward-test',
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'x-cron-secret', (
--           select decrypted_secret from vault.decrypted_secrets
--           where name = 'vigia_cron_secret_20260720' limit 1
--         )
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 280000
--     );
--   $$
-- );
