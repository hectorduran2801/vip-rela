/**
 * Limitador de ritmo compartido por todas las tareas concurrentes: reserva "turnos" separados por
 * 60000/perMinute ms más un jitter aleatorio [0, jitterMs], para no enviar a ritmo robótico.
 */
export class RateLimiter {
  private next = 0;
  constructor(
    private readonly perMinute: number,
    private readonly jitterMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly rnd: () => number = Math.random,
  ) {}

  /** Espera hasta que le toque el turno. */
  async acquire(): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + 60_000 / this.perMinute + this.rnd() * this.jitterMs;
    if (slot > t) await this.sleep(slot - t);
  }
}
