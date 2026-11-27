import { describe, expect, it } from 'vitest';
import { poolOptions } from './pool-options.js';

const remote = (q = '') => `postgresql://postgres.abc:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres${q}`;
describe('poolOptions (semántica de sslmode como libpq)', () => {
  it('require/prefer/sin sslmode en host remoto: TLS sin verificar la cadena (el pooler de Supabase no está en la CA de Node)', () => {
    for (const q of ['?sslmode=require', '?sslmode=prefer', '']) expect(poolOptions(remote(q), {}).ssl).toEqual({ rejectUnauthorized: false });
  });
  it('verify-ca / verify-full verifican el certificado', () => {
    for (const m of ['verify-ca', 'verify-full']) expect(poolOptions(remote(`?sslmode=${m}`), {}).ssl).toMatchObject({ rejectUnauthorized: true });
  });
  it('disable o una base local sin sslmode: sin TLS', () => {
    expect(poolOptions(remote('?sslmode=disable'), {}).ssl).toBe(false);
    expect(poolOptions('postgresql://postgres@localhost:5432/vip', {}).ssl).toBe(false);
  });
  it('no deja sslmode en la cadena (para que pg no lo reinterprete) y conserva usuario y contraseña con caracteres especiales', () => {
    const o = poolOptions('postgresql://postgres.abc:Cad%2329@host.example.com:5432/postgres?sslmode=require', {});
    expect(o.connectionString).not.toMatch(/sslmode/);
    expect(new URL(o.connectionString!).password).toBe('Cad%2329');
  });
});
