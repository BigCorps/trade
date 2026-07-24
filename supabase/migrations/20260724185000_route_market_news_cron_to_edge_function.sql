-- Aplicada em produção em 24/07/2026.
-- Redireciona o coletor de notícias da rota Vercel para a Edge Function do Supabase.

do $$
begin
  perform cron.unschedule('vigia-market-news-30min');
exception when others then
  null;
end $$;

select cron.schedule(
  'vigia-market-news-30min',
  '7,37 * * * *',
  $cron$
    select net.http_post(
      url := 'https://xzqmfcxtvfffgrmqqzdz.supabase.co/functions/v1/market-news',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'vigia_cron_secret_20260720'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 280000
    );
  $cron$
);
