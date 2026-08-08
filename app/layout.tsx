/**
 * app/layout.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Acrescenta navegação, que não existia. Antes só era possível trocar de
 * página digitando a URL.
 *
 * Três destinos, por ordem de uso:
 *
 *   /            painel principal — as quatro perguntas em linguagem simples
 *   /validacao   detalhe estatístico — para quando quiser conferir os números
 *   /conta       chaves da corretora e configurações
 *
 * Metadata, ícones e fontes seguem exatamente como estavam.
 */

import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';

import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'VigIA Trade',
  description:
    'Acompanhamento estatístico de estratégias de negociação em teste.',

  applicationName: 'VigIA Trade',

  manifest: '/icons/manifest.json',

  icons: {
    icon: [
      { url: '/icons/favicon.ico' },
      { url: '/icons/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/icons/favicon.ico',
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },

  appleWebApp: {
    capable: true,
    title: 'VigIA',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0D1014',
};

const destinos = [
  { href: '/', rotulo: 'Painel' },
  { href: '/validacao', rotulo: 'Estatística' },
  { href: '/conta', rotulo: 'Conta' },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <nav className="nav-vigia" aria-label="Navegação principal">
          <span className="nav-marca">VigIA</span>
          <div className="nav-destinos">
            {destinos.map((destino) => (
              <Link key={destino.href} href={destino.href}>
                {destino.rotulo}
              </Link>
            ))}
          </div>
        </nav>

        {children}

        <style>{`
          html, body { background: #0D1014; margin: 0; }

          .nav-vigia {
            position: sticky; top: 0; z-index: 50;
            display: flex; align-items: center; justify-content: space-between;
            gap: 1rem;
            padding: 0.85rem 1.25rem;
            background: rgba(13, 16, 20, 0.92);
            backdrop-filter: blur(8px);
            border-bottom: 1px solid #29323D;
            font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          }

          .nav-marca {
            font-family: ui-monospace, "SF Mono", Menlo, monospace;
            font-size: 0.78rem;
            letter-spacing: 0.18em;
            color: #5A6675;
            text-transform: uppercase;
          }

          .nav-destinos { display: flex; gap: 1.5rem; }

          .nav-destinos a {
            color: #8794A5;
            text-decoration: none;
            font-size: 0.82rem;
            padding: 0.2rem 0;
            border-bottom: 1px solid transparent;
            transition: color 0.15s ease, border-color 0.15s ease;
          }

          .nav-destinos a:hover { color: #E3E8EF; border-bottom-color: #29323D; }

          .nav-destinos a:focus-visible {
            outline: 2px solid #4B9478;
            outline-offset: 3px;
            border-radius: 2px;
          }

          @media (max-width: 400px) {
            .nav-vigia { padding: 0.75rem 1rem; }
            .nav-destinos { gap: 1.1rem; }
            .nav-destinos a { font-size: 0.78rem; }
          }

          @media (prefers-reduced-motion: reduce) {
            .nav-destinos a { transition: none; }
          }
        `}</style>
      </body>
    </html>
  );
}
