alter table public.market_news_runs
  drop constraint if exists market_news_runs_tipo_check,
  add constraint market_news_runs_tipo_check
    check (tipo = any (array['coleta','reacoes','coleta_e_reacoes','reclassificacao_v2']));
