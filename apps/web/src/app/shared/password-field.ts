import { Component, ElementRef, forwardRef, input, signal, viewChild } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Icon } from './ui';

/**
 * Campo de contraseña reutilizable: input + botón de icono (ojo / ojo tachado) DENTRO del campo, a la derecha.
 * Funciona con ngModel. El botón es type=button (no envía el formulario), mide 36×36 px, lleva aria-label dinámico, aria-pressed y title,
 * y al alternar conserva valor, foco y posición del cursor. Úsalo en TODA contraseña de la app.
 */
@Component({
  selector: 'app-password-field',
  imports: [Icon],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => PasswordField), multi: true }],
  template: `<div class="pw-wrap">
    <input #inp [id]="inputId()" [attr.name]="name()" [type]="visible() ? 'text' : 'password'" [attr.autocomplete]="autocomplete()" spellcheck="false" autocapitalize="off"
           [attr.aria-invalid]="invalid() ? 'true' : null" [attr.aria-describedby]="describedBy() || null" [attr.required]="required() ? '' : null"
           [value]="value()" [disabled]="disabled()" (input)="onInput($any($event.target).value)" (blur)="touched()" />
    <button type="button" class="pw-toggle" [attr.aria-label]="visible() ? 'Ocultar contraseña' : 'Mostrar contraseña'" [attr.aria-pressed]="visible()"
            [title]="visible() ? 'Ocultar contraseña' : 'Mostrar contraseña'" [disabled]="disabled()" (mousedown)="$event.preventDefault()" (click)="toggle()">
      <app-icon [name]="visible() ? 'eyeoff' : 'eye'" />
    </button>
  </div>`,
})
export class PasswordField implements ControlValueAccessor {
  readonly inputId = input<string>('', { alias: 'inputId' });
  readonly name = input<string | null>(null);
  readonly autocomplete = input<string>('current-password');
  readonly describedBy = input<string>('');
  readonly invalid = input<boolean>(false);
  readonly required = input<boolean>(false);
  protected readonly visible = signal(false);
  protected readonly value = signal('');
  protected readonly disabled = signal(false);
  private readonly inp = viewChild.required<ElementRef<HTMLInputElement>>('inp');
  private onChange: (v: string) => void = () => undefined;
  protected touched: () => void = () => undefined;

  /** Un valor vacío escrito desde fuera (limpieza tras cerrar o tras un intento fallido) también vuelve a ocultar la contraseña. */
  writeValue(v: string | null): void { this.value.set(v ?? ''); if (!v) this.visible.set(false); }
  registerOnChange(fn: (v: string) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.touched = fn; }
  setDisabledState(d: boolean): void { this.disabled.set(d); }
  protected onInput(v: string): void { this.value.set(v); this.onChange(v); }

  /** Alterna tipo y conserva valor, foco (si lo tenía) y selección. */
  protected toggle(): void {
    const el = this.inp().nativeElement;
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const hadFocus = document.activeElement === el;
    this.visible.update((v) => !v);
    queueMicrotask(() => {
      if (hadFocus) el.focus();
      if (s !== null && e !== null) { try { el.setSelectionRange(s, e); } catch { /* algunos tipos no admiten selección */ } }
    });
  }
}
