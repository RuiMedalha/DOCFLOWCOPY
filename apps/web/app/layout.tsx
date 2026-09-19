import type { Metadata, Viewport } from 'next';
import { Inter, Inter_Tight, Fraunces } from 'next/font/google';
import { ThemeProvider } from './_providers/theme-provider';
import { AppProviders } from './_providers/providers';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const interTight = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter-tight',
});
// Editorial display — Fraunces: serifa moderna editorial (variável).
// Substitui "Editorial New" (que é família paga da Pangram Pangram).
// Casa com a estética Blueprint Edition: contemporary editorial, não tradicional.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['300', '500', '700'],
  variable: '--font-editorial',
});

export const metadata: Metadata = {
  title: 'DocFlow — Document Intelligence',
  description:
    'SaaS multi-tenant para gestão documental, conciliação bancária e contabilidade para PMEs portuguesas.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'DocFlow',
  },
};

export const viewport: Viewport = {
  themeColor: '#070b14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${interTight.variable} ${fraunces.variable} ${inter.className} antialiased`}
      >
        <ThemeProvider>
          <AppProviders>{children}</AppProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}