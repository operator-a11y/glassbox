import type { ReactNode } from 'react';

export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium leading-none ${className}`}>{children}</span>
  );
}
