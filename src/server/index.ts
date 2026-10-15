import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { SERVER_PORT } from '../shared/constants';
import { connect } from './connection';
import type { RoomOptions } from './room';
import { Rooms } from './rooms';

/**
 * This computer's address on the local network, so a player who opened the
 * game as "localhost" can still hand a friend a link that works.
 */
export function lanAddress(): string | undefined {
  const found: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // Skip virtual adapters (WSL, Hyper-V, VPN tunnels and the like).
    if (/vEthernet|WSL|Loopback|VirtualBox|VMware|Tailscale|ZeroTier/i.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) found.push(a.address);
  }
  const home = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
  return found.find((a) => home.test(a)) ?? found[0];
}

/** The game server as a plain Node process: for local play, the tests and the soak run. */
export function startServer(port = SERVER_PORT, opts: RoomOptions = {}) {
  // A plain web address as well as the socket, so a hosting service can check the server is up.
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(req.url === '/health' ? 'ok' : 'split-screen football game server');
  });
  // Any path is accepted, so the client's Cloudflare-style addresses work here too.
  const wss = new WebSocketServer({ server: http });
  http.listen(port);
  const rooms = new Rooms(opts);

  wss.on('connection', (ws) => {
    const socket = { send: (d: string) => ws.send(d), isOpen: () => ws.readyState === WebSocket.OPEN };
    const conn = connect(rooms, socket, { lan: lanAddress });
    ws.on('message', (raw) => conn.onMessage(raw.toString()));
    ws.on('close', () => conn.onClose());
  });

  return {
    rooms,
    close: () => {
      rooms.close();
      for (const c of wss.clients) c.terminate();
      wss.close();
      http.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Hosting services say which port to use; locally it is the usual one.
  const port = Number(process.env.PORT) || SERVER_PORT;
  startServer(port);
  console.log(`game server listening on port ${port}`);
  const lan = lanAddress();
  if (lan) console.log(`players on the same network open  http://${lan}:5190`);
}
