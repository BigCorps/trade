export interface GdeltArticle {
  url: string;
  title: string;
  seenAt: string;
  domain: string | null;
  sourceCountry: string | null;
  language: string | null;
  raw: Record<string, unknown>;
}

function gdeltDate(value: Date): string {
  const part = (number: number) => String(number).padStart(2, '0');
  return String(value.getUTCFullYear()) + part(value.getUTCMonth() + 1) + part(value.getUTCDate()) + part(value.getUTCHours()) + part(value.getUTCMinutes()) + part(value.getUTCSeconds());
}

function parseSeenDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))).toISOString();
}

export async function fetchGdeltArticles(from: Date, to: Date): Promise<GdeltArticle[]> {
  const endpoint = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  endpoint.searchParams.set('query', '(bitcoin OR cryptocurrency OR crypto OR ethereum OR blockchain OR stablecoin OR binance OR coinbase OR solana OR ripple OR crypto ETF)');
  endpoint.searchParams.set('mode', 'ArtList');
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('maxrecords', '250');
  endpoint.searchParams.set('sort', 'HybridRel');
  endpoint.searchParams.set('startdatetime', gdeltDate(from));
  endpoint.searchParams.set('enddatetime', gdeltDate(to));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error('GDELT respondeu HTTP ' + response.status);
  const payload = await response.json() as { articles?: Array<Record<string, unknown>> };
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  return articles.flatMap((article) => {
    const url = typeof article.url === 'string' ? article.url : '';
    const title = typeof article.title === 'string' ? article.title.trim() : '';
    const seenAt = parseSeenDate(article.seendate);
    if (!url || !title || !seenAt) return [];
    return [{
      url,
      title,
      seenAt,
      domain: typeof article.domain === 'string' ? article.domain : null,
      sourceCountry: typeof article.sourcecountry === 'string' ? article.sourcecountry : null,
      language: typeof article.language === 'string' ? article.language : null,
      raw: article,
    }];
  });
}
