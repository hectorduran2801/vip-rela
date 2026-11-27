import { describe, expect, it } from 'vitest';
import { explainDbError, mapDbError } from './errors.js';

describe('mapDbError', () => {
  it('un esquema desactualizado (columna, tabla o función inexistente) es un 503 controlado, no un 500 genérico', () => {
    for (const code of ['42703', '42P01', '42883']) expect(mapDbError(Object.assign(new Error('x'), { code }))).toEqual({ status: 503, error: 'schema_outdated' });
  });
  it('un error desconocido sigue sin mapearse (500 interno)', () => { expect(mapDbError(new Error('otro'))).toBeNull(); });
  it('códigos de negocio nuevos', () => { expect(mapDbError(new Error('role_deprecated'))).toEqual({ status: 422, error: 'role_deprecated' }); });
  it('guardas de plantillas y horarios', () => {
    expect(mapDbError(new Error('template_required'))).toEqual({ status: 422, error: 'template_required' });
    expect(mapDbError(new Error('template_in_use'))).toEqual({ status: 409, error: 'template_in_use' });
    expect(mapDbError(new Error('schedule_not_found'))).toEqual({ status: 404, error: 'schedule_not_found' });
  });
  it('activación explícita de horarios', () => {
    expect(mapDbError(new Error('activation_not_confirmed'))).toEqual({ status: 422, error: 'activation_not_confirmed' });
    expect(mapDbError(new Error('template_has_unresolved_variables'))).toEqual({ status: 422, error: 'template_has_unresolved_variables' });
    expect(mapDbError(new Error('already_active'))).toEqual({ status: 409, error: 'already_active' });
    expect(mapDbError(new Error('direct_activation_forbidden'))).toEqual({ status: 403, error: 'direct_activation_forbidden' });
  });
  it('explainDbError devuelve detalle y la lista de variables desconocidas', () => {
    const e = Object.assign(new Error('template_has_unresolved_variables'), { detail: 'La plantilla usa variables desconocidas: {{foo}}, {{bar}}.', hint: 'h' });
    expect(explainDbError(e, 'template_has_unresolved_variables')).toEqual({ detail: e.detail, hint: 'h', unknown_variables: ['foo', 'bar'] });
    expect(explainDbError(e, 'forbidden')).toEqual({});
  });
});
