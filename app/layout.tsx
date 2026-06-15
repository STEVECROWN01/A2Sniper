import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { StoreInitializer } from '@/components/store-initializer';
import { GlobalLoader } from '@/components/ui/global-loader';
import { Toaster } from 'sonner';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'A2Sniper - TradeAlgo.AI',
  description: 'TradeAlgo.AI - High-precision algorithmic trading signals for Pocket Option',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/A2Sniper-logo.jpeg', type: 'image/jpeg' },
    ],
  },
  openGraph: {
    title: 'A2Sniper - TradeAlgo.AI',
    description: 'High-precision algorithmic trading signals for Pocket Option',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <GlobalLoader />
        <StoreInitializer />
        {children}
        <Toaster
          position="top-right"
          richColors
          closeButton
          toastOptions={{
            duration: 4000,
            style: {
              background: '#0A0B0E',
              border: '1px solid #D4AF3733',
              color: '#fff',
            },
          }}
        />
      </body>
    </html>
  );
}
