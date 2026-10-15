import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { SERVER_PORT } from '../shared/constants';
import type { ClientMsg, ServerMsg, Slot } from '../shared/protocol';
import { parseCode } from '../shared/rules';
import type { RoomOptions } from './room';
import { Rooms, type Entry } from './rooms';

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

export function startServer(port = SERVER_PORT, opts: RoomOptions = {}) {
  // A plain web address as well as the socket, so a hosting service can check the server is up.
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(req.url === '/health' ? 'ok' : 'split-screen football game server');
  });
  const wss = new WebSocketServer({ server: http });
  http.listen(port);
  const rooms = new Rooms(opts);

  wss.on('connection', (ws) => {
    let entry: Entry | null = null;
    let slot: Slot = 0;
    const send = (m: ServerMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    const enter = (e: Entry, place: { slot: Slot; token: string }, rejoined: boolean) => {
      entry = e;
      slot = place.slot;
      e.sends[slot] = send;
      send({ type: 'joined', code: e.room.code, token: place.token, you: slot, lan: lanAddress() });
      e.room.sync(slot, rejoined);
      rooms.touch(e);
    };

    const detach = () => {
      if (!entry) return;
      const e = entry;
      entry = null;
      // A newer socket may already have taken this place over.
      if (e.sends[slot] !== send) return;
      e.sends[slot] = null;
      return e;
    };

    ws.on('message', (raw) => {
      let m: ClientMsg;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || typeof m.type !== 'string') return;

      if (m.type === 'create_room') {
        if (entry) return;
        const e = rooms.create();
        enter(e, e.room.add(m)!, false);
      } else if (m.type === 'join_room') {
        if (entry) return;
        const code = typeof m.code === 'string' ? parseCode(m.code) : null;
        const e = code ? rooms.get(code) : undefined;
        if (!e) return send({ type: 'error', reason: 'not_found' });
        const back = typeof m.token === 'string' ? e.room.rejoin(m.token) : null;
        if (back !== null) return enter(e, { slot: back, token: m.token! }, true);
        const place = e.room.add(m);
        if (!place) return send({ type: 'error', reason: 'full' });
        enter(e, place, false);
      } else if (entry) {
        entry.room.onMessage(slot, m);
        if (m.type === 'leave') {
          const e = detach();
          if (e) rooms.touch(e);
        }
      } else if (m.type === 'ping') {
        send({ type: 'pong', t: m.t });
      }
    });

    ws.on('close', () => {
      const e = detach();
      if (!e) return;
      e.room.disconnect(slot);
      rooms.touch(e);
    });
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
