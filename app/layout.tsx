import type { Metadata } from 'next';
import { Space_Grotesk, Inter, IBM_Plex_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import { ThemeInit } from '@/components/settings/theme-init';
import { ServiceWorkerRegister } from '@/components/pwa/service-worker-register';
import { MotionProvider } from '@/components/motion/motion-provider';
import { APPEARANCES, APPEARANCE_KEY, PALETTES, PALETTE_KEY } from '@/lib/preferences';
import './globals.css';

// Runs synchronously during HTML parsing, before first paint, so a saved
// palette/appearance applies immediately instead of flashing the server
// default (clay/system) first. See ThemeInit for the same logic re-applied
// reactively after hydration (and to survive React Strict Mode's dev
// remount, which clears attributes the script set).
const themeInitScript = `(function(){try{
var pal=localStorage.getItem(${JSON.stringify(PALETTE_KEY)});
if(pal&&${JSON.stringify(PALETTES)}.indexOf(pal)>-1)document.documentElement.setAttribute('data-pal',pal);
var theme=localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)});
if(theme&&theme!=='system'&&${JSON.stringify(APPEARANCES)}.indexOf(theme)>-1)document.documentElement.setAttribute('data-theme',theme);
}catch(e){}})()`;

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin'],
  weight: ['500', '600', '700'],
});

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Track a Loonie',
  description: 'A small, honest budget tracker.',
};

const RootLayout = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <html
    lang="en"
    data-pal="clay"
    suppressHydrationWarning
    className={`${spaceGrotesk.variable} ${inter.variable} ${plexMono.variable} h-full`}
  >
    <head>
      <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
    </head>
    <body className="flex min-h-full flex-col antialiased">
      <ThemeInit />
      <ServiceWorkerRegister />
      <MotionProvider>{children}</MotionProvider>
      <Analytics />
      <SpeedInsights />
    </body>
  </html>
);

export default RootLayout;
