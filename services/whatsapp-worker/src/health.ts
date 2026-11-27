import { createServer, type Server } from 'node:http';

/** Servidor de estado interno: solo 127.0.0.1, solo lectura, sin PII. */
export function startHealthServer(port: number, status: () => unknown): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status()));
    } else { res.writeHead(404).end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
