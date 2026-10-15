import type { ClientMsg, ServerMsg } from '../shared/protocol';

/** Only ball messages are dropped by the loss slider; the protocol is built to survive that. */
const LOSSY = new Set(['handoff', 'handoff_ack', 'handoff_ok', 'ball_preview']);

/** WebSocket wrapper with auto-reconnect, a ping for the signal icon, and test knobs. */
export class Net {
  connected = false;
  /** Round trip to the server in ms, or null before the first reply. */
  rtt: number | null = null;
  /** Artificial delay added to every message, each way. */
  delayMs = 0;
  /** Share of ball messages thrown away, 0..1. */
  loss = 0;
  private ws: WebSocket | null = null;
  private closed = false;
  private pinger: ReturnType<typeof setInterval>;

  constructor(
    private url: string,
    private onMessage: (m: ServerMsg) => void,
    private onOpen: () => void,
  ) {
    this.connect();
    this.pinger = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 2000);
  }

  /** Hang up for good: no more reconnecting. */
  close(): void {
    this.closed = true;
    clearInterval(this.pinger);
    this.ws?.close();
  }

  send(m: ClientMsg): void {
    this.impair(m.type, () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    });
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onOpen();
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as ServerMsg;
      this.impair(m.type, () => {
        if (this.closed) return;
        if (m.type === 'pong') this.rtt = performance.now() - m.t;
        else this.onMessage(m);
      });
    };
    ws.onclose = () => {
      this.connected = false;
      this.rtt = null;
      if (!this.closed) setTimeout(() => this.connect(), 1000);
    };
  }

  private impair(type: string, deliver: () => void): void {
    if (this.loss > 0 && LOSSY.has(type) && Math.random() < this.loss) return;
    if (this.delayMs > 0) setTimeout(deliver, this.delayMs);
    else deliver();
  }
}
