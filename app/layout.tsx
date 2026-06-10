import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { StoreInitializer } from '@/components/store-initializer';
import { GlobalLoader } from '@/components/ui/global-loader';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'A2Sniper - Plateforme de Trading Algorithmique',
  description: "Plateforme de trading algorithmique propulsée par l'Assistant. Signaux Sniper OTC avec 99,99% de précision.",
  icons: {
    icon: '/A2Sniper-logo.jpeg',
    shortcut: '/A2Sniper-logo.jpeg',
    apple: '/A2Sniper-logo.jpeg',
  }
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