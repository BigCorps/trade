begin;

-- The three pre-registered batteries executed on 2026-08-08 added exactly
-- 60 combinations (5 symbols x 4 management rules x 3 batteries).
-- Never decrement this counter: it is the multiplicity burden of the project.
update public.configuracao_pesquisa
set valor_inteiro = greatest(valor_inteiro, 168),
    atualizado_em = now()
where chave = 'carga_de_busca';

-- The 1h CTT signal was negative with real costs and remained negative in the
-- aggregate with zero costs. The daily run produced only two trades per
-- populated symbol, which is not evidence. Preserve every observation while
-- stopping new collection under the frozen 2.0.0 configs.
update public.forward_test_config
set coletar = false,
    protocolo_status = 'encerrado',
    observacoes = concat_ws(
      E'\n',
      nullif(observacoes, ''),
      'Encerrada em 2026-08-08 pelo critério pré-registrado: walk-forward 1h negativo com custos reais e agregado ainda negativo com custo zero. O teste 1d teve amostra insuficiente (máximo de 2 operações por combinação).'
    )
where versao in ('2.0.0-control', '2.0.0-selective')
  and estrategias @> array['confirmed_trend_continuation']::text[];

update public.daytrade_strategy_execution_policy
set execution_enabled = false,
    validated_at = null,
    reason = 'Hipótese encerrada em 2026-08-08 após walk-forward pré-registrado negativo, inclusive no agregado sem custos.',
    updated_at = now()
where strategy = 'confirmed_trend_continuation';

-- Money-real execution remains fail-closed independently of strategy state.
update public.daytrade_strategy_execution_policy
set execution_enabled = false,
    validated_at = null,
    reason = case
      when strategy = 'confirmed_trend_continuation' then reason
      else 'Execução real bloqueada; exige aprovação estatística prospectiva.'
    end,
    updated_at = now()
where execution_environment = 'real';

-- PostgreSQL 17 supports invoker-security views. This makes the five research
-- views obey the permissions/RLS of the caller instead of the view owner.
alter view public.vw_prazo_por_tamanho_efeito set (security_invoker = true);
alter view public.vw_decomposicao_edge set (security_invoker = true);
alter view public.vw_forward_test_evidencia set (security_invoker = true);
alter view public.vw_imposto_por_faixa_risco set (security_invoker = true);
alter view public.vw_evidencia_robusta set (security_invoker = true);

-- Pin search_path on every function reported by the Supabase advisor.
alter function public.normal_cdf_approx(double precision)
  set search_path = public, pg_temp;
alter function public.touch_market_news_reaction_updated_at()
  set search_path = public, pg_temp;
alter function public.impedir_edicao_hipotese_congelada()
  set search_path = public, pg_temp;
alter function public.sincronizar_contagem_combinacoes()
  set search_path = public, pg_temp;
alter function public.piso_ruido_t(integer)
  set search_path = public, pg_temp;
alter function public.avaliar_portao_execucao(text, text)
  set search_path = public, pg_temp;
alter function public.p_corrigido_sidak(numeric, integer)
  set search_path = public, pg_temp;
alter function public.normal_cdf(numeric)
  set search_path = public, pg_temp;
alter function public.guardar_portao_execucao()
  set search_path = public, pg_temp;

-- Research protocol is global system state, not user-owned content. Signed-in
-- clients may inspect it but may no longer rewrite hypotheses or multiplicity.
drop policy if exists hipoteses_escrita on public.hipoteses_pesquisa;
drop policy if exists combinacoes_escrita on public.hipotese_combinacoes;
drop policy if exists configuracao_escrita on public.configuracao_pesquisa;

revoke insert, update, delete on public.hipoteses_pesquisa from authenticated;
revoke insert, update, delete on public.hipotese_combinacoes from authenticated;
revoke insert, update, delete on public.configuracao_pesquisa from authenticated;
grant select on public.hipoteses_pesquisa to authenticated;
grant select on public.hipotese_combinacoes to authenticated;
grant select on public.configuracao_pesquisa to authenticated;

-- Keep the one intentional duplicate-index cleanup deterministic.
drop index if exists public.market_news_one_running_idx;

commit;
