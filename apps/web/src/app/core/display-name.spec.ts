import { describe, expect, it } from 'vitest';
import { initialsOf } from './display-name';

describe('iniciales del avatar', () => {
  it.each([['Vanessa', 'V'], ['Vanessa S', 'VS'], ['Vanessa Ejemplo', 'VE'], ['Héctor Díaz', 'HD'], ['Héctor Luis Díaz Córdoba', 'HC'], ['  álvaro   ñúñez ', 'ÁÑ'], ['', ''], ['N !', 'N'], ['Nelson !', 'N'], ['¡Vanessa! (jefa)', 'VJ'], ['Vanessa S.', 'VS'], ['!!! 123', ''], ['Ana - Pérez', 'AP']])('«%s» → «%s»', (name, out) => {
    expect(initialsOf(name)).toBe(out);
  });
});
