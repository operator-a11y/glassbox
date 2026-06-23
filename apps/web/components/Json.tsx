import { prettyJson } from '@/lib/format';

export function Json({ value, className = '' }: { value: unknown; className?: string }) {
  return (
    <pre
      className={`mono max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300 ${className}`}
    >
      {prettyJson(value)}
    </pre>
  );
}
