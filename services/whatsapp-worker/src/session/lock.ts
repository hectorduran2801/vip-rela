import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Exclusión mutua entre instancias del worker sobre la MISMA sesión de WhatsApp: dos procesos con el mismo archivo de sesión se pisarían
 * (y WhatsApp expulsa a uno). Se crea `<sesión>.lock` con el PID (flag `wx`, atómico). Un bloqueo cuyo PID ya no existe se considera
 * huérfano y se reemplaza; si el PID sigue vivo, NO se arranca.
 */
export class SessionLockedError extends Error {
  constructor(readonly pid: number) { super(`otra instancia del worker (pid ${pid}) ya usa esta sesión de WhatsApp; no se inicia una segunda`); this.name = 'SessionLockedError'; }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export class SessionLock {
  private held = false;
  constructor(private readonly file: string, private readonly pid = process.pid) {}

  acquire(): void {
    if (this.held) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, 'wx', 0o600);
        writeSync(fd, String(this.pid)); closeSync(fd); this.held = true; return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const other = Number.parseInt(readFileSync(this.file, 'utf8').trim(), 10);
        if (Number.isFinite(other) && other !== this.pid && alive(other)) throw new SessionLockedError(other);
        try { unlinkSync(this.file); } catch { /* otro proceso ya lo retiró */ }      // huérfano (proceso muerto) o propio: se reemplaza
      }
    }
    throw new Error('no se pudo adquirir el bloqueo de la sesión de WhatsApp');
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try { if (Number.parseInt(readFileSync(this.file, 'utf8').trim(), 10) === this.pid) unlinkSync(this.file); } catch { /* ya no existe */ }
  }
}
