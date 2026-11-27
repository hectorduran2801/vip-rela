import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AUDITORÍA de acciones visuales: (a) todo <app-icon-button> lleva etiqueta; (b) todo <button> sin texto visible lleva aria-label;
 * (c) los iconos destructivos (papelera, bloqueo) llevan tono de advertencia y la pantalla pide confirmación; (d) ninguna fila/tarjeta tiene más de 3 iconos visibles.
 */
const ROOT = join(process.cwd(), 'src', 'app');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'testing' ? [] : files(p)) : /\.(ts|html)$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : []; });
}
const SRC = files(ROOT).map((p) => {
  const rel = p.slice(ROOT.length + 1);
  const sib = p.replace(/\.(ts|html)$/, p.endsWith('.ts') ? '.html' : '.ts');
  return { rel, text: readFileSync(p, 'utf8'), all: readFileSync(p, 'utf8') + (existsSync(sib) ? readFileSync(sib, 'utf8') : '') };
}).filter((f) => f.rel.endsWith('.html') || /template:\s*`/.test(f.text));

const ICON_BTN = /<app-icon-button\b([^>]*?)\/?>/gs;
/** Excepciones JUSTIFICADAS: acciones destructivas o secundarias que se quedan como botón de TEXTO. */
const TEXT_EXCEPTIONS: Record<string, string> = {
  'features/messaging/whatsapp.html': 'Conectar/Desconectar WhatsApp son acciones principales del módulo (texto, con confirmación)',
  'features/messaging/whatsapp-test.html': 'Confirmar envío de UN mensaje de prueba (acción principal, con confirmación)',
};

describe('Auditoría: acciones con icono', () => {
  it('hay pantallas que auditar y usan app-icon-button', () => {
    expect(SRC.length).toBeGreaterThan(30);
    expect(SRC.filter((f) => /<app-icon-button/.test(f.text)).length).toBeGreaterThanOrEqual(8);
  });
  it('todo <app-icon-button> lleva label (nombre accesible + tooltip)', () => {
    const bad: string[] = [];
    for (const f of SRC) for (const m of f.text.matchAll(ICON_BTN)) if (!/(^|\s)\[?label\]?=/.test(m[1]!)) bad.push(`${f.rel}: ${m[0].slice(0, 80)}`);
    expect(bad).toEqual([]);
  });
  it('todo <button> sin texto visible tiene aria-label (o es app-icon-button)', () => {
    const bad: string[] = [];
    for (const f of SRC) for (const m of f.text.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const visible = m[2]!.replace(/<app-icon\b[^>]*\/?>(<\/app-icon>)?/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
      if (!visible && !/aria-label|\[attr\.aria-label\]/.test(m[1]!)) bad.push(`${f.rel}: ${m[0].slice(0, 90).replace(/\s+/g, ' ')}`);
    }
    expect(bad).toEqual([]);
  });
  it('iconos destructivos (papelera, bloqueo) con tono de advertencia (danger/warn) y la pantalla pide confirmación', () => {
    const bad: string[] = [];
    for (const f of SRC.filter((x) => !x.rel.startsWith('shared/'))) for (const m of f.text.matchAll(ICON_BTN)) {
      if (!/icon="(trash|ban)"/.test(m[1]!)) continue;
      if (!/tone="(danger|warn)"/.test(m[1]!)) bad.push(`${f.rel}: sin tono de advertencia`);
      if (!/alertdialog|Sí, |confirm|panel\.set\('end'\)|\bpending\.set|confirming/i.test(f.all)) bad.push(`${f.rel}: sin confirmación`);
    }
    expect(bad).toEqual([]);
  });
  it('ninguna fila o tarjeta tiene más de 3 iconos visibles (el resto, en el menú de tres puntos)', () => {
    const over: string[] = [];
    for (const f of SRC) for (const g of f.text.matchAll(/<span class="icon-actions"[^>]*>([\s\S]*?)<\/span>(?=\s*[<@}]|\s*$)/g)) {
      const n = (g[1]!.match(/<app-icon-button/g) ?? []).length;
      if (n > 3) over.push(`${f.rel}: ${n} iconos`);
    }
    expect(over).toEqual([]);
  });
  it('las excepciones de botones de texto destructivos están justificadas y existen', () => {
    for (const [k, why] of Object.entries(TEXT_EXCEPTIONS)) { expect(existsSync(join(ROOT, k)), k).toBe(true); expect(why.length, k).toBeGreaterThan(20); }
  });
  it('en las filas ya no quedan botones de texto de «Eliminar», «Editar», «Suspender» ni «Reactivar» (son iconos)', () => {
    const bad: string[] = [];
    for (const f of SRC) for (const m of f.text.matchAll(/<button\b[^>]*>\s*(Eliminar|Editar|Suspender|Reactivar|Quitar)\s*<\/button>/g)) bad.push(`${f.rel}: ${m[0]}`);
    expect(bad).toEqual([]);
  });
});
