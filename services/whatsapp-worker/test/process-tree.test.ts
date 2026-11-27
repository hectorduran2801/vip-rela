import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, killTree } from '../src/adapters/process-tree.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe('cierre sin procesos huérfanos', () => {
  it('encuentra a los nietos en la tabla de procesos', () => { expect(descendants(1000, [[1001, 1000], [1002, 1001], [1003, 1], [1004, 1002]]).sort()).toEqual([1001, 1002, 1004]); });
  it('mata al proceso y a su nieto', async () => {
    const parent = spawn(process.execPath, ['-e', `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`]);
    const grandchild = await new Promise<number>((r) => parent.stdout.once('data', (d) => r(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);
    killTree(parent.pid!);
    for (let i = 0; i < 100 && (alive(grandchild)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(grandchild)).toBe(false);
  });
});
