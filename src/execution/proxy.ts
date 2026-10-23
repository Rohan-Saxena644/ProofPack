import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';
import { allowedUrl, safeUrl } from './boundaries';

// Chromium's proxy sees every HTTP request / HTTPS tunnel, including redirect hops
// that Playwright routing can omit. Never follow redirects in the proxy itself.
export async function boundaryProxy(origins: string[], blocked: (url: string) => void) {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const raw = req.url ?? '';
    if (!allowedUrl(raw, origins)) { blocked(safeUrl(raw)); res.writeHead(403); res.end('ProofPack: destination blocked'); return; }
    const url = new URL(raw);
    if (url.protocol !== 'http:') { res.writeHead(403); res.end(); return; }
    const headers = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request(url, { method: req.method, headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    upstream.on('socket', socket => { if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); } });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('ProofPack: target unavailable'); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connect', (req, client, head) => {
    const raw = `https://${req.url}`;
    if (!allowedUrl(raw, origins)) { blocked(safeUrl(raw)); client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const url = new URL(raw);
    const upstream = net.connect(Number(url.port || 443), url.hostname, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address() as net.AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
