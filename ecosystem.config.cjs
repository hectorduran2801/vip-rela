// Producción / servidor: un administrador de procesos (PM2) supervisa la API (Fastify) y el worker de WhatsApp (OpenWA) como servicios
// INDEPENDIENTES. Nadie abre terminales: `pm2 start ecosystem.config.cjs` los levanta, los reinicia si caen (con límite) y `pm2 save` +
// `pm2 startup` los arrancan al encender la máquina. Las credenciales llegan por variables de entorno del servidor, nunca en este archivo.
//
//   pnpm -r build                      (compila api, worker y paquetes)
//   pm2 start ecosystem.config.cjs
//   pm2 logs vip-worker                (registros; el worker no escribe secretos ni el QR)
//
// Una sola instancia de cada servicio (instances: 1, sin cluster): el worker usa UNA sesión de WhatsApp y un bloqueo por archivo impide duplicarla.
module.exports = {
  apps: [
    {
      name: 'vip-api',
      cwd: './apps/api',
      script: 'dist/server.js',
      node_args: '--env-file-if-exists=../../.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,          // reintentos limitados: ante un fallo persistente se detiene en lugar de reiniciar sin fin
      min_uptime: '20s',
      restart_delay: 3000,
      env: { NODE_ENV: 'production', PORT: '3100', HOST: '127.0.0.1' },
    },
    {
      name: 'vip-worker',
      cwd: './services/whatsapp-worker',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s',
      restart_delay: 5000,
      kill_timeout: 15000,       // tiempo para cerrar Chrome/OpenWA ordenadamente y conservar el archivo de sesión
      watch: false,              // NUNCA reiniciar por cambios de código: cada reinicio reconecta la sesión de WhatsApp
      env: { NODE_ENV: 'production', HEALTH_PORT: '3199', OPENWA_SESSION_PATH: '/var/lib/vip/openwa-sessions' },   // ruta persistente, fuera del directorio de compilación
    },
  ],
};
