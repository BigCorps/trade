import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('x-cron-secret') !== secret) {
    return json({ ok: false, error: 'não autorizado' }, 401);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  if (!supabaseUrl) return json({ ok: false, error: 'NEXT_PUBLIC_SUPABASE_URL não configurada' }, 500);

  const incomingBody = await request.text();
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/market-news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
      body: incomingBody || '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(280_000),
    });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return json({ ok: false, error: message }, 502);
  }
}
