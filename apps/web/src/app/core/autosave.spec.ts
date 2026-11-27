import { Autosave, norm } from './autosave';

const eq = (a: string | null, b: string | null) => norm(a) === norm(b);
const gate = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { p, resolve, reject }; };

describe('Autosave (guardado automático)', () => {
  afterEach(() => vi.useRealTimers());
  it('norm: recorta y convierte vacío en null', () => { expect(norm('  CHAPA ')).toBe('CHAPA'); expect(norm('   ')).toBeNull(); expect(norm(null)).toBeNull(); });
  it('no envía si el valor no cambió (ni repitiendo el blur)', async () => {
    const persist = vi.fn(async (v: string | null) => v);
    const a = new Autosave<string | null>('A', eq, persist);
    await a.commit(); expect(persist).not.toHaveBeenCalled();
    a.set('A  '); await a.commit(); expect(persist).not.toHaveBeenCalled();
    a.set('B'); await a.commit(); await a.commit(); await a.commit();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('B');
  });
  it('estados: guardando → guardado → (desaparece solo) idle', async () => {
    vi.useFakeTimers();
    const g = gate<string | null>();
    const a = new Autosave<string | null>(null, eq, () => g.p);
    a.set('X');
    const done = a.commit();
    expect(a.status()).toBe('saving');
    g.resolve('X'); await done;
    expect(a.status()).toBe('saved');
    vi.advanceTimersByTime(3000);
    expect(a.status()).toBe('idle');
  });
  it('serializa: si se edita mientras guarda, encola SOLO el último valor (sin solicitudes concurrentes)', async () => {
    const gates = [gate<string | null>(), gate<string | null>()];
    let active = 0, maxActive = 0, i = 0;
    const persist = vi.fn(async () => { active++; maxActive = Math.max(maxActive, active); const v = await gates[i++]!.p; active--; return v; });
    const a = new Autosave<string | null>(null, eq, persist);
    a.set('uno'); const p1 = a.commit();
    a.set('dos'); void a.commit(); a.set('tres'); void a.commit();
    gates[0]!.resolve('uno'); await Promise.resolve(); await Promise.resolve();
    gates[1]!.resolve('tres'); await p1;
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['uno', 'tres']);
    expect(maxActive).toBe(1);
  });
  it('error: conserva lo escrito, muestra el mensaje y permite reintentar', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('X');
    const a = new Autosave<string | null>(null, eq, persist);
    a.set('X'); await a.commit();
    expect(a.status()).toBe('error');
    expect(a.error()).toBeTruthy();
    expect(a.dirty).toBe(true);
    await a.retry();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(a.status()).toBe('saved');
    expect(a.dirty).toBe(false);
  });
  it('adopta lo que devuelve el servidor (no queda solo en memoria)', async () => {
    const onSaved = vi.fn();
    const a = new Autosave<string | null>(null, eq, async () => 'NORMALIZADO', onSaved);
    a.set('  normalizado '); await a.commit();
    expect(onSaved).toHaveBeenCalledWith('NORMALIZADO');
    a.set('NORMALIZADO'); await a.commit();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
  it('flush guarda lo pendiente', async () => {
    const persist = vi.fn(async (v: string | null) => v);
    const a = new Autosave<string | null>(null, eq, persist);
    a.set('Z'); await a.flush();
    expect(persist).toHaveBeenCalledWith('Z');
  });
});
