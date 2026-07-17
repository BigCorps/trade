// lib/supabaseClient.ts
// ----------------------------------------------------------------------------
// Client Supabase para o browser (singleton).
// Decisão: como o VigIA é 100% client-rendered ('use client') e o CRUD de
// alertas fala direto com o Supabase protegido por RLS, usamos
// @supabase/supabase-js puro — sem @supabase/ssr, middleware ou cookies.
// Se um dia páginas server-side precisarem de sessão, migramos para o pacote
// ssr; até lá, isso é menos código e menos superfície de erro.
// ----------------------------------------------------------------------------

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) {
      throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY não configuradas.');
    }
    client = createClient(url, anon, {
      auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true },
    });
  }
  return client;
}