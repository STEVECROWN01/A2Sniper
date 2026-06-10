import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { StoreInitializer } from '@/components/store-initializer';
import { GlobalLoader } from '@/components/ui/global-loader';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'A2Sniper - TradeAlgo.AI',
  description: 'TradeAlgo.AI - Système de signaux de trading algorithmique à haute précision pour Pocket Option',
  icons: {
    icon: '/favicon.ico',
  },
  openGraph: {
    title: 'A2Sniper - TradeAlgo.AI',
    description: 'Système de signaux de trading algorithmique à haute précision pour Pocket Option',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body className={inter.className}>
        <GlobalLoader />
        <StoreInitializer />
        {children}
      </body>
    </html>
  );
}
