import type { ClientMsg, ServerMsg, Slot } from '../shared/protocol';
import { parseCode } from '../shared/rules';
import type { Entry, Rooms } from './rooms';

/** The little a connection needs from a socket, so Node's `ws` and Cloudflare's WebSocket both fit. */
export interface Socket {
  send(data: string): void;
  isOpen(): boolean;
}

export interface ConnectionOptions {
  /** This host's address on the local network, for share links. Only the Node server knows it. */
  lan?: () => string | undefined;
  /** On Cloudflare each room lives in its own object, which already knows its code. */
  code?: string;
}

/**
 * One player's connection: the first message creates or joins a room, and
 * everything after it goes to that room. Shared by the Node server and the
 * Cloudflare worker so they behave the same.
 */
export function connect(rooms: Rooms, socket: Socket, opts: ConnectionOptions = {}) {
  let entry: Entry | null = null;
  let slot: Slot = 0;
  const send = (m: ServerMsg) => {
    if (socket.isOpen()) socket.send(JSON.stringify(m));
  };

  const enter = (e: Entry, place: { slot: Slot; token: string }, rejoined: boolean) => {
    entry = e;
    slot = place.slot;
    e.sends[slot] = send;
    send({ type: 'joined', code: e.room.code, token: place.token, you: slot, lan: opts.lan?.() });
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

  return {
    onMessage(raw: string): void {
      let m: ClientMsg;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!m || typeof m.type !== 'string') return;

      if (m.type === 'create_room') {
        if (entry) return;
        const e = rooms.create(opts.code);
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
    },

    onClose(): void {
      const e = detach();
      if (!e) return;
      e.room.disconnect(slot);
      rooms.touch(e);
    },
  };
}
