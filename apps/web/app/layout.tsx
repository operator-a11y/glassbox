import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Glassbox',
  description: 'Deterministic record-replay-fork debugger for agent runs',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-zinc-800">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-baseline gap-3">
            <a href="/" className="text-lg font-semibold tracking-tight">
              Glassbox
            </a>
            <span className="text-sm text-zinc-500">
              record → replay → fork
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
