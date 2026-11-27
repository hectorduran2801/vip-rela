import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AUDITORÍA de feedback inmediato: todo componente que llama a un servicio que ESCRIBE o dispara algo (guardar, registrar, enviar, aplicar, exportar…)
 * debe (a) usar el mecanismo común `appBusy` (spinner + texto de progreso + aria-busy) en sus botones de acción y (b) tener guard de reentrada
 * (`if (this.xxx()) return` / `createAction`) para ignorar invocaciones mientras la acción está en curso. Si aparece uno que no, esta prueba falla
 * o hay que listarlo en EXCEPCIONES con su justificación.
 */
const ROOT = join(process.cwd(), 'src', 'app');
const WRITE = /\b(?:this\.)?(?:api|data|auth|state)\.(?:save|set|create|register|void|close|generate|apply|confirm|reject|upload|connect|disconnect|send|resolve|cancel|remove|suspend|invite|change|start|end|reassign|delete|download|review|signIn|signOut|request|update|whatsapp(?:Connect|Disconnect|Test(?:Send|Cancel|Resolve)))[A-Za-z]*\(/;
const GUARD = /if \([^\n]*this\.(?:busy|saving|sending|submitting|requesting|uploading|resolveBusy|loggingOut)\(\)[^\n]*\) ?\{? ?return|createAction\(/;
/** Excepciones justificadas (ruta relativa a src/app): no tienen botón propio que bloquear o el guard vive en otro sitio. */
const EXCEPCIONES: Record<string, string> = {
  'features/imports/imports.ts': 'la subida es un campo de archivo deshabilitado mientras sube (guard `uploading`); el botón «Guardar datos» con appBusy está en collection-sync.ts',
  'core/whatsapp-state.ts': 'servicio: el guard (`requesting`) y el estado «solicitud en curso» viven aquí; los botones usan appBusy en features/messaging/whatsapp.html',
  'features/units/unit-agreement.ts': 'guardado automático (clase Autosave): serializa y no reentra; muestra el estado «Guardando…» en el propio campo, sin botón de acción',
  'features/messaging/whatsapp.ts': 'los botones están en whatsapp.html con appBusy; el guard está en WhatsappState.request()',
  'shell/account-switch.ts': 'es un <select> (sin botón): queda deshabilitado mientras cambia de cuenta y tiene guard de reentrada',
};
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'testing' ? [] : files(p)) : /\.ts$/.test(n) && !/\.spec\.ts$/.test(n) ? [p] : []; });
}

describe('Auditoría: toda acción asíncrona usa el mecanismo común de botón ocupado y tiene guard de reentrada', () => {
  const comps = files(ROOT).map((p) => {
    const rel = p.slice(ROOT.length + 1);
    const ts = readFileSync(p, 'utf8');
    const htmlPath = p.replace(/\.ts$/, '.html');
    const all = ts + (existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '');
    return { rel, ts, all };
  }).filter((c) => WRITE.test(c.ts) && !c.rel.startsWith('core/') || c.rel === 'core/whatsapp-state.ts');

  it('hay componentes que auditar', () => expect(comps.length).toBeGreaterThan(18));
  it('cada uno usa [appBusy] en sus botones de acción (o está en EXCEPCIONES)', () => {
    const missing = comps.filter((c) => !EXCEPCIONES[c.rel] && !/\[appBusy\]/.test(c.all)).map((c) => c.rel);
    expect(missing).toEqual([]);
  });
  it('cada uno tiene guard de reentrada a nivel de acción (o está en EXCEPCIONES)', () => {
    const missing = comps.filter((c) => !EXCEPCIONES[c.rel] && !GUARD.test(c.ts)).map((c) => c.rel);
    expect(missing).toEqual([]);
  });
  it('toda excepción está justificada y sigue existiendo', () => {
    for (const [k, why] of Object.entries(EXCEPCIONES)) { expect(existsSync(join(ROOT, k)), k).toBe(true); expect(why.length, k).toBeGreaterThan(20); }
  });
  it('las etiquetas de progreso son verbos en gerundio con puntos suspensivos («Guardando…»)', () => {
    const labels = new Set<string>();
    for (const c of comps) for (const m of c.all.matchAll(/busyLabel="([^"]+)"/g)) labels.add(m[1]!);
    expect(labels.size).toBeGreaterThan(10);
    for (const l of labels) expect(l, l).toMatch(/^[A-ZÁÉÍÓÚ][a-záéíóúñ ]+(ando|iendo|endo)[a-záéíóúñ ]*…$/);
  });
});
