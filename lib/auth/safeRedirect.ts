/**
 * lib/auth/safeRedirect.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Utilitários para redirecionamentos de autenticação e deep links.
 *
 * Objetivos:
 * - impedir open redirect para domínios externos;
 * - aceitar apenas rotas conhecidas do VigIA;
 * - preservar somente parâmetros explicitamente permitidos;
 * - validar o deep link de oportunidade por UUID;
 * - produzir a URL absoluta usada em `emailRedirectTo`;
 * - funcionar tanto no browser quanto em código reutilizado no servidor.
 *
 * Exemplos:
 *
 *   const emailRedirectTo = buildMagicLinkRedirect({
 *     origin: window.location.origin,
 *     next: '/oportunidades?focus=9b8d...'
 *   });
 *
 *   const next = readSafeNextFromUrl(window.location.href, '/alertas');
 *
 * Nunca use diretamente um valor recebido de `next`, `redirect` ou `returnTo`
 * em `window.location`, `router.push` ou `emailRedirectTo`.
 * -----------------------------------------------------------------------------
 */

export const SAFE_AUTH_PATHS = [
  '/',
  '/daytrade',
  '/oportunidades',
  '/alertas',
  '/conta',
] as const;

export type SafeAuthPath = (typeof SAFE_AUTH_PATHS)[number];

export const OPPORTUNITY_TABS = [
  'pending',
  'positions',
  'exits',
  'history',
  'performance',
] as const;

export type OpportunityTab = (typeof OPPORTUNITY_TABS)[number];

export interface BuildMagicLinkRedirectOptions {
  /**
   * Origem confiável da aplicação, normalmente `window.location.origin`.
   * Exemplo: `https://vigia.example`.
   */
  origin: string;

  /**
   * Destino relativo desejado depois do login.
   * Pode conter somente uma rota da allowlist e parâmetros permitidos.
   */
  next?: string | null;

  /**
   * Destino seguro usado quando `next` for ausente ou inválido.
   */
  fallback?: SafeAuthPath;

  /**
   * UUID da oportunidade. Quando informado, força `/oportunidades` e adiciona
   * `focus=<uuid>`.
   */
  focus?: string | null;

  /**
   * Aba opcional da Central. Só é preservada em `/oportunidades`.
   */
  tab?: OpportunityTab | null;
}

export interface SanitizeRedirectOptions {
  fallback?: SafeAuthPath;
  allowOpportunityTab?: boolean;
}

const SAFE_PATH_SET = new Set<string>(SAFE_AUTH_PATHS);
const OPPORTUNITY_TAB_SET = new Set<string>(OPPORTUNITY_TABS);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i;

const NEXT_PARAM_NAMES = ['next', 'redirect', 'returnTo'] as const;

/**
 * Retorna `true` somente para UUIDs RFC 4122 nas versões 1 a 5.
 */
export function isSafeUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Retorna `true` somente para as rotas autorizadas do app.
 */
export function isSafeAuthPath(
  pathname: unknown,
): pathname is SafeAuthPath {
  return typeof pathname === 'string' && SAFE_PATH_SET.has(pathname);
}

/**
 * Retorna `true` somente para abas conhecidas da Central.
 */
export function isOpportunityTab(
  value: unknown,
): value is OpportunityTab {
  return (
    typeof value === 'string' &&
    OPPORTUNITY_TAB_SET.has(value)
  );
}

function normalizeOrigin(origin: string): URL {
  const trimmed = origin.trim();

  if (!trimmed) {
    throw new Error('Origem da aplicação não informada.');
  }

  const parsed = new URL(trimmed);

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('A origem precisa usar HTTP ou HTTPS.');
  }

  // Uma origem confiável não deve carregar usuário, senha, query ou fragmento.
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Origem da aplicação inválida.');
  }

  return new URL(parsed.origin);
}

function sanitizeFallback(
  fallback: SafeAuthPath | undefined,
): SafeAuthPath {
  return fallback && isSafeAuthPath(fallback) ? fallback : '/';
}

function hasUnsafeRawSyntax(candidate: string): boolean {
  const value = candidate.trim();

  return (
    value === '' ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.includes('\\') ||
    value.startsWith('//') ||
    ABSOLUTE_SCHEME_PATTERN.test(value) ||
    ENCODED_PATH_SEPARATOR_PATTERN.test(value)
  );
}

function normalizeAllowedPathname(
  pathname: string,
): SafeAuthPath | null {
  if (isSafeAuthPath(pathname)) {
    return pathname;
  }

  // Aceita somente uma barra final simples nas rotas conhecidas.
  if (
    pathname.length > 1 &&
    pathname.endsWith('/') &&
    isSafeAuthPath(pathname.slice(0, -1))
  ) {
    return pathname.slice(0, -1) as SafeAuthPath;
  }

  return null;
}

function buildSanitizedRelativeUrl(
  pathname: SafeAuthPath,
  source: URL,
  allowOpportunityTab: boolean,
): string {
  const output = new URL(pathname, 'https://vigia.invalid');

  if (pathname === '/oportunidades') {
    const focus = source.searchParams.get('focus');

    if (focus && isSafeUuid(focus)) {
      output.searchParams.set('focus', focus);
    }

    if (allowOpportunityTab) {
      const tab = source.searchParams.get('tab');

      if (tab && isOpportunityTab(tab)) {
        output.searchParams.set('tab', tab);
      }
    }
  }

  // Nenhum fragmento é preservado. Tokens de autenticação podem aparecer no
  // hash durante o fluxo do Supabase e não devem virar parte do `next`.
  return `${output.pathname}${output.search}`;
}

/**
 * Sanitiza um destino relativo.
 *
 * Regras:
 * - rejeita URLs absolutas, protocol-relative, backslashes e caracteres de
 *   controle;
 * - exige uma rota presente em `SAFE_AUTH_PATHS`;
 * - remove parâmetros desconhecidos;
 * - em `/oportunidades`, preserva apenas `focus` válido e, opcionalmente, `tab`;
 * - nunca preserva hash.
 */
export function sanitizeRedirectTarget(
  candidate: unknown,
  options: SanitizeRedirectOptions = {},
): string {
  const fallback = sanitizeFallback(options.fallback);

  if (typeof candidate !== 'string') {
    return fallback;
  }

  const trimmed = candidate.trim();

  if (hasUnsafeRawSyntax(trimmed)) {
    return fallback;
  }

  try {
    // A origem sentinela permite usar o parser nativo sem aceitar outro host.
    const sentinel = new URL('https://vigia.invalid');
    const parsed = new URL(trimmed, sentinel);

    if (parsed.origin !== sentinel.origin) {
      return fallback;
    }

    const safePathname = normalizeAllowedPathname(parsed.pathname);

    if (!safePathname) {
      return fallback;
    }

    return buildSanitizedRelativeUrl(
      safePathname,
      parsed,
      options.allowOpportunityTab ?? true,
    );
  } catch {
    return fallback;
  }
}

/**
 * Converte um destino relativo já sanitizado em uma URL absoluta da aplicação.
 */
export function toAbsoluteAppUrl(
  origin: string,
  candidate: unknown,
  options: SanitizeRedirectOptions = {},
): string {
  const safeOrigin = normalizeOrigin(origin);
  const safeTarget = sanitizeRedirectTarget(candidate, options);

  return new URL(safeTarget, safeOrigin).toString();
}

/**
 * Monta a URL usada em `supabase.auth.signInWithOtp({ options:
 * { emailRedirectTo } })`.
 *
 * Quando `focus` é válido, o destino é forçado para a Central de Oportunidades.
 * Isso evita que um UUID recebido por email seja combinado com outra rota.
 */
export function buildMagicLinkRedirect(
  options: BuildMagicLinkRedirectOptions,
): string {
  const fallback = sanitizeFallback(options.fallback);

  let target = sanitizeRedirectTarget(options.next, {
    fallback,
    allowOpportunityTab: true,
  });

  if (options.focus !== undefined && options.focus !== null) {
    if (!isSafeUuid(options.focus)) {
      target = fallback;
    } else {
      const url = new URL(
        '/oportunidades',
        'https://vigia.invalid',
      );

      url.searchParams.set('focus', options.focus);

      if (options.tab && isOpportunityTab(options.tab)) {
        url.searchParams.set('tab', options.tab);
      }

      target = `${url.pathname}${url.search}`;
    }
  } else if (
    options.tab &&
    isOpportunityTab(options.tab) &&
    target.startsWith('/oportunidades')
  ) {
    const url = new URL(target, 'https://vigia.invalid');
    url.searchParams.set('tab', options.tab);
    target = `${url.pathname}${url.search}`;
  }

  return toAbsoluteAppUrl(options.origin, target, {
    fallback,
    allowOpportunityTab: true,
  });
}

/**
 * Lê o primeiro parâmetro de retorno conhecido (`next`, `redirect` ou
 * `returnTo`) de uma URL e devolve somente um destino seguro.
 */
export function readSafeNextFromUrl(
  urlLike: string | URL,
  fallback: SafeAuthPath = '/',
): string {
  try {
    const parsed =
      urlLike instanceof URL
        ? urlLike
        : new URL(urlLike, 'https://vigia.invalid');

    for (const name of NEXT_PARAM_NAMES) {
      const candidate = parsed.searchParams.get(name);

      if (candidate !== null) {
        return sanitizeRedirectTarget(candidate, {
          fallback,
          allowOpportunityTab: true,
        });
      }
    }

    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Extrai diretamente o deep link seguro da Central a partir da URL atual.
 *
 * Útil quando a própria página `/oportunidades?focus=<uuid>` é usada como
 * `emailRedirectTo`, sem uma rota de callback intermediária.
 */
export function readOpportunityDeepLink(
  urlLike: string | URL,
): {
  focus: string | null;
  tab: OpportunityTab | null;
  target: string;
} {
  try {
    const parsed =
      urlLike instanceof URL
        ? urlLike
        : new URL(urlLike, 'https://vigia.invalid');

    const focusCandidate = parsed.searchParams.get('focus');
    const tabCandidate = parsed.searchParams.get('tab');

    const focus = isSafeUuid(focusCandidate)
      ? focusCandidate
      : null;
    const tab = isOpportunityTab(tabCandidate)
      ? tabCandidate
      : null;

    const output = new URL(
      '/oportunidades',
      'https://vigia.invalid',
    );

    if (focus) {
      output.searchParams.set('focus', focus);
    }

    if (tab) {
      output.searchParams.set('tab', tab);
    }

    return {
      focus,
      tab,
      target: `${output.pathname}${output.search}`,
    };
  } catch {
    return {
      focus: null,
      tab: null,
      target: '/oportunidades',
    };
  }
}

/**
 * Resolve a origem atual do navegador. Fora do browser, exige fallback
 * explícito para evitar a criação silenciosa de URLs em um domínio incorreto.
 */
export function getCurrentAppOrigin(
  fallbackOrigin?: string,
): string {
  if (
    typeof window !== 'undefined' &&
    window.location?.origin
  ) {
    return normalizeOrigin(window.location.origin).origin;
  }

  if (fallbackOrigin) {
    return normalizeOrigin(fallbackOrigin).origin;
  }

  throw new Error(
    'Origem indisponível fora do navegador. Informe fallbackOrigin.',
  );
}