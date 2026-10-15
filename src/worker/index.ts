// The game server on Cloudflare. Each room is one Durable Object, found by its
// join code, which holds that room's players' WebSocket connections and runs
// exactly the same referee code as the Node server.
import { DurableObject } from 'cloudflare:workers';
import { parseCode, makeCode } from '../shared/rules';
import { connect } from '../server/connection';
import { Rooms } from '../server/rooms';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomObject>;
}

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });

/** One room. Its state lives in memory while anyone is connected, which keeps it running. */
export class RoomObject extends DurableObject<Env> {
  private rooms = new Rooms();
  private code = '';

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? '';

    // A new room asks first whether this code is free, so two rooms never share one.
    if (url.pathname === '/claim') {
      if (this.code) return text('taken', 409);
      this.code = code;
      return text('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') return text('expected a WebSocket', 426);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const conn = connect(
      this.rooms,
      { send: (d) => server.send(d), isOpen: () => server.readyState === WebSocket.OPEN },
      { code: this.code || code },
    );
    server.addEventListener('message', (e) => conn.onMessage(typeof e.data === 'string' ? e.data : ''));
    const gone = () => {
      conn.onClose();
      // Once the room has been closed for good, its code is free again.
      if (!this.rooms.size) this.code = '';
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return text('ok');
    if (request.headers.get('Upgrade') !== 'websocket') return text('split-screen football game server');

    const room = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));
    const forward = (code: string) => room(code).fetch(new Request(`https://room/ws?code=${code}`, request));

    // Creating a match: find a code nobody is using, then join its room.
    if (url.pathname === '/ws/new') {
      for (let tries = 0; tries < 8; tries++) {
        const code = makeCode();
        const claim = await room(code).fetch(`https://room/claim?code=${code}`);
        if (claim.ok) return forward(code);
      }
      return text('no free room codes, try again', 503);
    }

    // Joining, or coming back to, a match by its code.
    const match = /^\/ws\/room\/([A-Za-z]+)$/.exec(url.pathname);
    const code = match ? parseCode(match[1]) : null;
    if (code) return forward(code);
    return text('unknown address', 404);
  },
};
