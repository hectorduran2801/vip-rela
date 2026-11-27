import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error('\n✖ Falta DATABASE_URL: la API no puede arrancar sin base de datos.\n  Ejecuta una sola vez:  pnpm dev:setup   (te pide la contraseña en privado y la guarda en .env)\n  y luego arranca todo con:  pnpm dev\n');
  process.exit(1);
}
const app = await buildApp(config);
app.listen({ port: config.PORT, host: config.HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
