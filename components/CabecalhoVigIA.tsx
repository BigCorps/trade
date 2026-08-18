'use client';

/**
 * components/CabecalhoVigIA.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Cabeçalho compartilhado.
 *
 * Antes este bloco estava copiado em 5 páginas (`page`, `daytrade`,
 * `oportunidades`, `robustez`, `alertas`, `conta`). Mudar um item do menu
 * exigia editar seis arquivos, e foi assim que os menus ficaram divergentes
 * entre telas.
 *
 * Mantém exatamente o padrão visual existente: logo à esquerda, título e
 * subtítulo centralizados, navegação abaixo, botão Sair quando há sessão.
 * Nada de novo foi inventado aqui — só centralizado.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

/**
 * Paleta unificada.
 *
 * Cada página mantinha sua própria cópia, e elas divergiram: `daytrade` usava
 * `panelSoft`, `oportunidades` e `robustez` usavam `soft`, `robustez` chamava
 * o âmbar de `orange` enquanto as outras chamavam de `a`, e só `robustez`
 * tinha `purple`. Os hexadecimais eram os mesmos — só os nomes divergiam.
 *
 * Aqui estão todos os nomes já usados, apontando para as mesmas cores, para
 * que nenhuma página quebre. Em código novo, prefira `a`, `blue` e `soft`.
 */
export const S = {
  bg: '#101418',
  panel: '#181f26',
  soft: '#141a20',
  panelSoft: '#141a20', // alias usado em daytrade
  border: '#2a343f',
  text: '#d7dee6',
  dim: '#7d8a97',
  a: '#e8a13c',
  orange: '#e8a13c', // alias usado em robustez
  blue: '#4f8fd0',
  b: '#4f8fd0', // alias usado em daytrade e na home antiga
  green: '#3fb26f',
  red: '#d05555',
  yellow: '#d6b35b',
  purple: '#9a7fd1',
};

export interface DestinoNav {
  href: string;
  rotulo: string;
}

/**
 * Destinos do menu, em um único lugar.
 *
 * Para adicionar ou remover uma página do menu, edite apenas esta lista.
 */
export const DESTINOS: DestinoNav[] = [
  { href: '/', rotulo: 'Painel' },
  { href: '/coleta', rotulo: 'Coleta' },
  { href: '/validacao', rotulo: 'Estatística' },
  { href: '/daytrade', rotulo: 'Validação' },
  { href: '/oportunidades', rotulo: 'Teste prospectivo' },
  { href: '/robustez', rotulo: 'Robustez' },
  { href: '/alertas', rotulo: 'Entrar / Alertas' },
  { href: '/conta', rotulo: 'Conta Binance' },
];

interface Props {
  /** Título grande, ao lado do logo. Ex.: "Conta Binance" */
  titulo: string;
  /** Linha fina abaixo do título. Ex.: "conexão · ordens · histórico" */
  subtitulo?: string;
  /** href do destino atual, destacado em âmbar e sem link. */
  ativo: string;
  /**
   * Cliente Supabase da página. Opcional: sem ele o botão Sair não aparece.
   * Passar o cliente já existente evita abrir uma segunda conexão.
   */
  supabase?: SupabaseClient;
}

export default function CabecalhoVigIA({
  titulo,
  subtitulo,
  ativo,
  supabase,
}: Props) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;

    let vivo = true;

    supabase.auth.getSession().then(({ data }) => {
      if (vivo) setSession(data.session ?? null);
    });

    const { data: inscricao } = supabase.auth.onAuthStateChange(
      (_evento, novaSessao) => {
        if (vivo) setSession(novaSessao);
      },
    );

    return () => {
      vivo = false;
      inscricao.subscription.unsubscribe();
    };
  }, [supabase]);

  return (
    <header
      style={{
        borderBottom: `1px solid ${S.border}`,
        background: S.panel,
        padding: '12px 20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt="VigIA Trade"
          style={{ height: 32, width: 'auto', display: 'block' }}
        />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>
            {titulo}
          </div>
          {subtitulo && (
            <div style={{ fontSize: 11, color: S.dim }}>{subtitulo}</div>
          )}
        </div>
      </div>

      <nav
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 20,
          marginTop: 8,
          fontSize: 13,
        }}
      >
        {DESTINOS.map((destino) =>
          destino.href === ativo ? (
            <span
              key={destino.href}
              style={{ color: S.a, fontWeight: 600 }}
              aria-current="page"
            >
              {destino.rotulo}
            </span>
          ) : (
            <Link
              key={destino.href}
              href={destino.href}
              style={{ color: S.dim, textDecoration: 'none' }}
            >
              {destino.rotulo}
            </Link>
          ),
        )}

        {supabase && session && (
          <button
            onClick={() => supabase.auth.signOut()}
            style={{
              background: 'transparent',
              border: 'none',
              color: S.red,
              fontSize: 13,
              cursor: 'pointer',
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            Sair
          </button>
        )}
      </nav>
    </header>
  );
}
