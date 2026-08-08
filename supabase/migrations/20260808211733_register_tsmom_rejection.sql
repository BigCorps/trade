-- Registra todas as 12 combinações pré-registradas do TSMOM diário.
-- A formulação foi rejeitada pelo resultado fora da amostra e pelo drawdown.
update public.configuracao_pesquisa
set
  valor_inteiro = 196,
  descricao = descricao ||
    ' 08/08/2026: +12 combinacoes TSMOM diario (4 simbolos x lookbacks 90/180/360d, long/short, rebalanceamento mensal, custos reais); carteira rejeitada fora da amostra por retorno insuficiente ou drawdown excessivo.',
  atualizado_em = now()
where chave = 'carga_de_busca'
  and valor_inteiro = 184;

do $$
begin
  if not exists (
    select 1 from public.configuracao_pesquisa
    where chave = 'carga_de_busca' and valor_inteiro = 196
  ) then
    raise exception 'carga_de_busca não avançou de 184 para 196';
  end if;
end;
$$;
