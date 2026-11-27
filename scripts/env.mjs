// Lectura mínima de .env (KEY=VALUE, comentarios con #, comillas opcionales). Sin dependencias.
import { existsSync, readFileSync } from 'node:fs';

export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '');           // comentario al final de línea
    out[line.slice(0, i).trim()] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}
