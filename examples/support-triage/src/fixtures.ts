/**
 * Deterministic "triage knowledge" — classification + customer lookup. These are
 * the read-only tools; given the same args they always return the same result, so
 * they replay bit-identically and are safe to re-run live in a fork.
 */

export interface Classification {
  priority: 'high' | 'normal' | 'low';
  category: string;
}

export function classify(text: string): Classification {
  const t = text.toLowerCase();
  const priority: Classification['priority'] = /urgent|outage|down|asap|critical|cannot/.test(t)
    ? 'high'
    : /how|question|help|where|when/.test(t)
      ? 'normal'
      : 'low';
  const category = /bill|charge|invoice|payment|refund/.test(t)
    ? 'billing'
    : /login|password|auth|access|2fa/.test(t)
      ? 'auth'
      : /bug|error|crash|broken|fail/.test(t)
        ? 'bug'
        : 'general';
  return { priority, category };
}

export interface Customer {
  id: string;
  plan: string;
  openTickets: number;
}

export function lookupCustomer(id: string): Customer {
  // Deterministic pseudo-record derived from the id.
  const n = [...id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const plan = (['free', 'pro', 'enterprise'] as const)[n % 3]!;
  return { id, plan, openTickets: n % 4 };
}
