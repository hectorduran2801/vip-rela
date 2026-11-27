import { execFileSync } from 'node:child_process';

/** Todos los descendientes de `root` (hijos, nietos…), según `ps`. */
export function descendants(root: number, table = psTable()): number[] {
  const out: number[] = [];
  for (let queue = [root]; queue.length;) {
    const parent = queue.shift()!;
    for (const [pid, ppid] of table) if (ppid === parent && !out.includes(pid) && pid !== root) { out.push(pid); queue.push(pid); }
  }
  return out;
}
function psTable(): [number, number][] {
  try { return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number) as [number, number]); }
  catch { return []; }
}
/** Mata el proceso y su descendencia (Chromium incluido): si solo se mata al padre, el navegador queda huérfano consumiendo memoria. */
export function killTree(root: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  const all = [...descendants(root), root];                 // se calcula ANTES de matar: al morir el padre, los hijos cambian de padre
  for (const pid of all) { try { process.kill(pid, signal); } catch { /* ya no existe */ } }
}
