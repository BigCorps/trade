-- Registra todas as 16 combinações do ensaio técnico FBR 1h/360d.
-- Resultados negativos também contam para a correção por múltiplos testes.
update public.configuracao_pesquisa
set
  valor_inteiro = 184,
  descricao = descricao ||
    ' 08/08/2026: +16 combinacoes FBR short (4 simbolos x 4 gestoes, 1h/360d, custos reais); todas com media R negativa.',
  atualizado_em = now()
where chave = 'carga_de_busca'
  and valor_inteiro = 168;

do $$
begin
  if not exists (
    select 1
    from public.configuracao_pesquisa
    where chave = 'carga_de_busca'
      and valor_inteiro = 184
  ) then
    raise exception 'carga_de_busca não avançou de 168 para 184';
  end if;
end;
$$;
