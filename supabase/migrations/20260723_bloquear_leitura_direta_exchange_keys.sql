-- ============================================================================
-- exchange_keys: impedir que o navegador leia api_key e api_secret_enc.
--
-- JÁ APLICADA NA PRODUÇÃO em 23/07/2026 via MCP. Este arquivo existe para o
-- repositório refletir o estado real do banco.
--
-- Situação anterior: a política de SELECT permitia ao usuário autenticado ler
-- a própria linha inteira, incluindo a chave e o segredo cifrado. Mesmo que o
-- app usasse a RPC mascarada, qualquer script no navegador (extensão maliciosa,
-- XSS) poderia consultar a tabela direto pelo cliente Supabase.
--
-- Situação nova: nenhuma leitura direta pelo cliente. O único caminho é a RPC
-- get_exchange_key_status(), que devolve apenas o status e a chave mascarada.
-- As edge functions continuam lendo normalmente porque usam service role,
-- que ignora RLS.
-- ============================================================================

-- 1. A RPC precisa ser SECURITY DEFINER: sem isso ela roda como o chamador e
--    pararia de funcionar assim que a política de SELECT sair. O filtro por
--    auth.uid() permanece dentro da função, então ela continua devolvendo
--    somente a linha do próprio usuário.
create or replace function public.get_exchange_key_status()
returns table (
  configured boolean,
  api_key_masked text,
  is_testnet boolean,
  atualizado_em timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    true,
    repeat('•', greatest(length(k.api_key) - 6, 6)) || right(k.api_key, 6),
    k.is_testnet,
    k.atualizado_em
  from public.exchange_keys k
  where k.user_id = (select auth.uid())
  union all
  select false, null::text, null::boolean, null::timestamptz
  where not exists (
    select 1 from public.exchange_keys k
    where k.user_id = (select auth.uid())
  )
  limit 1;
$function$;

comment on function public.get_exchange_key_status() is
  'Único caminho de leitura de exchange_keys pelo cliente. Devolve status e chave mascarada, nunca o valor completo nem o segredo.';

revoke execute on function public.get_exchange_key_status() from public;
revoke execute on function public.get_exchange_key_status() from anon;
grant execute on function public.get_exchange_key_status() to authenticated;
grant execute on function public.get_exchange_key_status() to service_role;

-- 2. Remover a leitura direta da tabela pelo cliente.
drop policy if exists "usuario le propria chave" on public.exchange_keys;

-- 3. Garantia extra: mesmo que alguma política de SELECT seja recriada por
--    engano no futuro, o cliente não terá privilégio de coluna.
revoke select on public.exchange_keys from authenticated;
revoke select on public.exchange_keys from anon;
