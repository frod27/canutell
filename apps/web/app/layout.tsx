import type { Metadata, Viewport } from 'next';
import { TAGLINE } from '@canutell/protocol';
import './globals.css';

export const metadata: Metadata = {
  title: 'CANUTELL',
  description: `${TAGLINE} Invest, deal, gamble and vote — then work out who at the table is an AI.`,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'CANUTELL' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#14161a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer className="tagline">{TAGLINE}</footer>
      </body>
    </html>
  );
}
