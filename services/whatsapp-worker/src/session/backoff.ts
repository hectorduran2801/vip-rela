export interface BackoffOptions { baseMs: number; maxMs: number; factor?: number; jitter?: number }

/** Backoff exponencial con tope y jitter ±`jitter` (fracción). attempt empieza en 0. */
export function backoffDelay(attempt: number, o: BackoffOptions, rnd: () => number = Math.random): number {
  const raw = Math.min(o.maxMs, o.baseMs * (o.factor ?? 2) ** Math.max(0, attempt));
  const j = o.jitter ?? 0.1;
  return Math.max(0, Math.round(raw * (1 + (rnd() * 2 - 1) * j)));
}
