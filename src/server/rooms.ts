import type { ServerMsg, Slot } from '../shared/protocol';
import { RULES, makeCode } from '../shared/rules';
import { Room, type RoomOptions } from './room';

export type Send = (m: ServerMsg) => void;

export interface Entry {
  room: Room;
  /** How to reach each player right now; null while they are not connected. */
  sends: (Send | null)[];
  expiry: ReturnType<typeof setTimeout> | null;
}

/** All open rooms, by join code. */
export class Rooms {
  private rooms = new Map<string, Entry>();

  constructor(private opts: RoomOptions = {}) {}

  get size(): number {
    return this.rooms.size;
  }

  create(): Entry {
    let code = makeCode(this.opts.rng);
    while (this.rooms.has(code)) code = makeCode();
    const entry: Entry = { room: null as unknown as Room, sends: [], expiry: null };
    entry.room = new Room(code, (slot: Slot, m) => entry.sends[slot]?.(m), this.opts);
    this.rooms.set(code, entry);
    return entry;
  }

  get(code: string): Entry | undefined {
    return this.rooms.get(code);
  }

  /** Call after anyone joins or leaves: an empty room is closed after a while. */
  touch(entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = null;
    if (!entry.room.empty) return;
    entry.expiry = setTimeout(() => {
      if (!entry.room.empty) return;
      entry.room.close();
      this.rooms.delete(entry.room.code);
    }, this.opts.rules?.emptyRoomMs ?? RULES.emptyRoomMs);
  }

  close(): void {
    for (const e of this.rooms.values()) {
      if (e.expiry) clearTimeout(e.expiry);
      e.room.close();
    }
    this.rooms.clear();
  }
}
