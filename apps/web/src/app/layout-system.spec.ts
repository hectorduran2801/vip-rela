import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService, AuthService, DataService } from './core/services';
import { FakeAuth, fakeApi, fakeData, settle } from './testing/fakes';
import { DriverForm } from './features/drivers/driver-form';
import { DriverNew } from './features/drivers/driver-new';
import { UnitForm } from './features/units/unit-form';

const ROOT = join(process.cwd(), 'src');
const css = readFileSync(join(ROOT, 'styles.scss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Cuerpos de las reglas cuyo selector contiene `sel` (de forma literal). */
const rules = (sel: string): string[] => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.split(',').some((x) => x.trim() === sel)).map((m) => m[2]!);
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? sources(p) : /\.(ts|html)$/.test(n) && !n.endsWith('.spec.ts') ? [p] : []; });
}

describe('Contenedores sin límite de ancho (el ancho lo decide la tarjeta)', () => {
  it('.page, main y .main-col no tienen max-width ni width fijo', () => {
    for (const sel of ['.page', 'main', '.main-col', '.form-grid', 'form.panel, .panel > form']) {
      for (const body of [...rules(sel), ...rules(sel.split(',')[0]!.trim())]) expect(body, sel).not.toMatch(/max-width|[^-]width:\s*\d+(px|rem)/);
    }
  });
  it('ya no existe la clase .page.narrow (causa del formulario de 640 px) ni se usa en ninguna plantilla', () => {
    expect(css).not.toMatch(/\.page\.narrow|\.page\.medium/);
    const used = sources(join(ROOT, 'app')).filter((f) => /page (narrow|medium)/.test(readFileSync(f, 'utf8')));
    expect(used.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });
  it('no se usa 100vw (provoca desbordamiento horizontal)', () => expect(css).not.toMatch(/100vw/));
  it('.form-grid: CSS Grid con minmax(0-safe), auto-fill, mínimo ≈200 px y tope de 4 columnas', () => {
    const body = rules('.form-grid').join(' ');
    expect(body).toMatch(/display:\s*grid/);
    expect(body).toMatch(/repeat\(auto-fill,\s*minmax\(max\(12\.5rem,\s*calc\(\(100% - 3 \* var\(--form-gap\)\) \/ 4\)\),\s*1fr\)\)/);
    expect(rules('.form-grid > *').join(' ')).toMatch(/min-width:\s*0/);
  });
  it('clases del sistema de formularios definidas: form-section, form-field--full, form-actions (derecha; apiladas en móvil)', () => {
    expect(rules('.form-field--full').join(' ')).toContain('grid-column: 1 / -1');
    expect(rules('.form-section').length).toBeGreaterThan(0);
    expect(rules('.form-actions').join(' ')).toMatch(/justify-content:\s*flex-end/);
    expect(rules('.crm.mobile .form-actions').join(' ')).toMatch(/flex-direction:\s*column-reverse/);
  });
  it('los formularios usan las clases del sistema y no estilos ad hoc de ancho', () => {
    for (const f of ['features/drivers/driver-form.html', 'features/units/unit-form.html']) {
      const h = readFileSync(join(ROOT, 'app', f), 'utf8');
      expect(h, f).toContain('form-grid'); expect(h, f).toContain('form-actions'); expect(h, f).not.toMatch(/style="[^"]*width/);
    }
  });
});

describe('Formulario de conductor: secciones y campos', () => {
  async function mk() {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: fakeData() }, { provide: ApiService, useValue: fakeApi() }] });
    const f = TestBed.createComponent(DriverForm);
    await settle(f);
    return f.nativeElement as HTMLElement;
  }
  it('secciones Identificación, WhatsApp, Licencia y Estado con sus campos', async () => {
    const el = await mk();
    const secs = Array.from(el.querySelectorAll('.form-section')).map((s) => ({ t: s.querySelector('h3')!.textContent!.trim(), l: Array.from(s.querySelectorAll('label')).map((x) => x.textContent!.trim()) }));
    expect(secs.map((s) => s.t)).toEqual(['Identificación', 'WhatsApp', 'Licencia', 'Estado']);
    expect(secs[0]!.l).toEqual(['Código de operario *', 'Cédula (opcional)', 'Nombre completo *']);
    expect(secs[1]!.l).toEqual(['WhatsApp']);
    expect(secs[2]!.l).toEqual(['Número de licencia', 'Vencimiento de licencia']);
    expect(secs[3]!.l).toEqual(['Estado del conductor', 'Observaciones']);
  });
  it('Observaciones ocupa toda la fila; no hay campo de código de unidad', async () => {
    const el = await mk();
    expect(el.querySelector('#df-notes')!.closest('.field')!.classList.contains('form-field--full')).toBe(true);
    expect(el.querySelector('[id*=unit], [name*=unit]')).toBeNull();
    expect(el.textContent!.toLowerCase()).not.toContain('código de unidad');
  });
  it('Cancelar y Guardar al final, dentro de .form-actions (Guardar último = a la derecha)', async () => {
    const el = await mk();
    const btns = Array.from(el.querySelectorAll('.form-actions > button')).map((b) => b.textContent!.trim());
    expect(btns).toEqual(['Cancelar', 'Guardar']);
  });
  it('la página /drivers/new usa .page sin .narrow', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: new FakeAuth().login('admin') }, { provide: DataService, useValue: fakeData() }, { provide: ApiService, useValue: fakeApi() }] });
    const f = TestBed.createComponent(DriverNew);
    await settle(f);
    const page = (f.nativeElement as HTMLElement).querySelector('.page')!;
    expect(page.classList.contains('narrow')).toBe(false);
    expect(page.querySelector('app-driver-form')).not.toBeNull();
  });
});

describe('Formulario de unidad: secciones', () => {
  it('Identificación, Estado, Acuerdo / condición especial y Observaciones; notas y comentario a toda la fila', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: DataService, useValue: fakeData({ listUnits: vi.fn(async () => []) }) }] });
    const f = TestBed.createComponent(UnitForm);
    await settle(f);
    const el = f.nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('.form-section > h3')).map((h) => h.textContent!.trim())).toEqual(['Identificación', 'Estado', 'Acuerdo / condición especial', 'Observaciones']);
    expect(el.querySelector('#uf-notes')!.closest('.field')!.classList.contains('form-field--full')).toBe(true);
    expect(Array.from(el.querySelectorAll('.form-actions > button')).map((b) => b.textContent!.trim())).toEqual(['Cancelar', 'Guardar']);
  });
});
