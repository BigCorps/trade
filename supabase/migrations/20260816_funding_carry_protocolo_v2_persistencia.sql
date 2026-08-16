-- =========================================================================
-- Funding carry — protocolo 2.0.0
--
-- Aplicada no projeto xzqmfcxtvfffgrmqqzdz em 2026-08-16.
-- Este arquivo existe para que o histórico do repositório bata com o
-- estado real do banco.
--
-- PROBLEMA CORRIGIDO
-- O protocolo 1.0.0 declarava elegibilidade lendo o funding INSTANTÂNEO e
-- projetando-o sobre 30 dias de retenção. Em 09/08/2026 isso marcou
-- BNBUSDT como "+11,23% de carry líquido anualizado".
--
-- Medição da premissa nos 2.706 snapshots já coletados (06–16/08):
--
--   funding >= 15% agora  ->  8,86% em 24h  ->  6,30% em 72h
--   funding 10,9-15%      ->  8,01% em 24h  ->  6,17% em 72h
--   funding 5-10,9%       ->  6,15% em 24h  ->  5,67% em 72h
--   funding <= 0%         ->  1,46% em 24h  ->  3,61% em 72h
--
-- O funding reverte para ~6% anualizado em 72 horas independentemente de
-- onde começa. A janela elegível de 09/08 durou SEIS HORAS. Projetar a
-- taxa de pico sobre 30 dias superestima o retorno por um fator grande.
--
-- Pior: BNBUSDT, o único símbolo que disparou elegibilidade na v1, tem o
-- TERCEIRO PIOR funding médio do conjunto (3,79% a.a.). A regra antiga
-- selecionava picos de volatilidade de funding, não fontes persistentes
-- de carry — seleção de outlier.
--
-- REGRA NOVA
-- Elegibilidade passa a usar a média móvel de 72h do funding anualizado
-- como estimador do que será efetivamente recebido, e exige que o ganho
-- projetado sobre o horizonte de retenção supere o custo de ida e volta
-- mais uma margem de segurança.
--
-- VALIDAÇÃO RETROSPECTIVA nos mesmos 2.706 snapshots (1.936 horas com
-- janela de 72h completa), custo 0,60% e margem 0,15%:
--
--   LINKUSDT  113 horas elegíveis    SOLUSDT  42    UNIUSDT  39
--   DOGEUSDT   13                    AVAXUSDT  7
--   BNBUSDT     0  <- corretamente rejeitado
--   BTC, ETH, XRP, ADA, DOT: 0
--
-- A regra nova rejeita o outlier que a v1 aceitou e seleciona os símbolos
-- com funding persistentemente alto. É o comportamento pretendido.
--
-- O CUSTO NÃO FOI ALTERADO. Permanece em 0,60% porque é uma suposição
-- ainda não confirmada empiricamente. Se a execução maker nas duas pernas
-- for confirmada (~0,24%), basta atualizar o campo — mas note que a 0,24%
-- a regra passa a marcar 1.196 das 1.936 horas, ou seja, deixa de
-- discriminar. Nesse regime o fator limitante vira capacidade e risco de
-- execução, não seleção de símbolo.
--
-- Nenhuma ordem é autorizada por esta migration. Módulo permanece
-- observacional.
-- =========================================================================

-- 1. Campos novos no protocolo --------------------------------------------
alter table public.funding_carry_protocol
  add column if not exists funding_ma_horas integer not null default 72,
  add column if not exists margem_seguranca_pct numeric not null default 0.15,
  add column if not exists regra_saida text;

-- 2. Campos novos no snapshot ---------------------------------------------
alter table public.funding_carry_snapshots
  add column if not exists funding_ma_72h_pct numeric,
  add column if not exists horas_na_media integer,
  add column if not exists ganho_periodo_pct numeric,
  add column if not exists carry_liquido_periodo_pct numeric,
  add column if not exists protocolo_versao text;

comment on column public.funding_carry_snapshots.funding_ma_72h_pct is
  'Média móvel de 72h do funding anualizado. Estimador de persistência: é isto que se recebe, não a taxa instantânea.';
comment on column public.funding_carry_snapshots.carry_liquido_periodo_pct is
  'Ganho projetado sobre holding_dias_assumido menos custo de ida e volta, em pontos percentuais do notional. NÃO anualizado.';

-- 3. Preencher retroativamente os snapshots já coletados -------------------
with calc as (
  select id,
    avg(funding_anualizado_pct) over w as ma72,
    count(*) over w as horas
  from public.funding_carry_snapshots
  window w as (
    partition by simbolo order by coletado_em
    rows between 71 preceding and current row
  )
)
update public.funding_carry_snapshots s
   set funding_ma_72h_pct = round(calc.ma72, 6),
       horas_na_media = calc.horas,
       ganho_periodo_pct = round(calc.ma72 * s.holding_dias_assumido / 365.0, 6),
       carry_liquido_periodo_pct =
         round(calc.ma72 * s.holding_dias_assumido / 365.0 - s.custo_round_trip_pct, 6),
       protocolo_versao = coalesce(s.protocolo_versao, '1.0.0')
  from calc
 where calc.id = s.id
   and s.funding_ma_72h_pct is null;

-- 4. Encerrar o protocolo 1.0.0, preservando-o para auditoria -------------
update public.funding_carry_protocol
   set status = 'encerrado',
       observacoes = coalesce(observacoes,'')
         || ' | ENCERRADO em 2026-08-16: a regra projetava o funding instantâneo '
         || 'sobre 30 dias. Medição da persistência nos próprios snapshots mostrou '
         || 'reversão para ~6% a.a. em 72h. Os 7 elegíveis registrados sob esta '
         || 'versão (BNBUSDT, 09-10/08) são artefato da regra, não oportunidades.'
 where versao = '1.0.0';

-- 5. Protocolo 2.0.0 ------------------------------------------------------
insert into public.funding_carry_protocol (
  versao, nome, simbolos,
  funding_anualizado_min_pct, basis_abs_max_pct,
  custo_round_trip_pct, holding_dias_assumido,
  funding_ma_horas, margem_seguranca_pct,
  amostra_horas_alvo, status, regra_saida, observacoes
)
values (
  '2.0.0',
  'Funding carry delta-neutro — persistência medida',
  array['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT','UNIUSDT'],
  9.13,
  0.75,
  0.60,
  30,
  72,
  0.15,
  2160,
  'coletando',
  'Sair quando a média móvel de 72h do funding anualizado cair abaixo do break-even '
  || '(custo_round_trip * 365 / holding_dias_assumido = 7,30% a.a. nos parâmetros atuais), '
  || 'ou quando |basis| ultrapassar o limite. A saída é por regra, não por expectativa '
  || 'de que a taxa permaneça parada.',
  'Long spot + short perp, apenas como hipótese observacional. NENHUMA ORDEM. '
  || 'Elegibilidade v2: média móvel de 72h do funding (não a taxa instantânea), '
  || 'basis controlado, e ganho projetado sobre 30 dias superando custo + margem de 0,15%. '
  || 'O piso de 9,13% a.a. é derivado, não escolhido: é (0,60 + 0,15) * 365 / 30. '
  || 'Se o custo for revisado, este piso DEVE ser recalculado pela mesma fórmula. '
  || 'Alvo de amostra elevado de 720h para 2160h (90 dias): 10 dias não bastam para '
  || 'mapear frequência de regime elegível.'
)
on conflict (versao) do nothing;

-- 6. View expõe os campos novos -------------------------------------------
-- create or replace falha aqui porque a ordem das colunas muda; o drop é
-- necessário. A view é recriada na mesma transação, sem janela de
-- indisponibilidade para o frontend.
drop view if exists public.funding_carry_latest;

create view public.funding_carry_latest
with (security_invoker=true) as
select distinct on (simbolo)
  simbolo, coletado_em, mark_price, index_price, funding_rate_pct,
  funding_anualizado_pct, funding_ma_72h_pct, horas_na_media,
  basis_pct, custo_round_trip_pct, holding_dias_assumido,
  ganho_periodo_pct, carry_liquido_periodo_pct,
  carry_liquido_anualizado_pct, elegivel, motivo, protocolo_versao
from public.funding_carry_snapshots
order by simbolo, coletado_em desc;

grant select on public.funding_carry_latest to authenticated, service_role;
