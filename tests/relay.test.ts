import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BallRelay } from '../src/server/relay';
import type { ServerMsg } from '../src/shared/protocol';
import type { Side } from '../src/shared/types';

function setup() {
  const sent: { to: Side; m: ServerMsg }[] = [];
  const relay = new BallRelay((to, m) => sent.push({ to, m }), { resendMs: 500, maxSpeed: 35 });
  relay.spawn('A');
  const of = (to: Side, type: ServerMsg['type']) => sent.filter((s) => s.to === to && s.m.type === type);
  return { relay, sent, of, first: relay.seq };
}

const shot = (seq: number, vx = 20) => ({ type: 'handoff', seq, y: 5, vx, vy: 0, t: 0 }) as const;

describe('ball relay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts a handoff from the owner and forwards it', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    expect(relay.owner).toBe('B');
    expect(relay.seq).toBe(first + 1);
    expect(of('A', 'handoff_ok')).toHaveLength(1);
    expect(of('B', 'handoff')).toHaveLength(1);
    relay.close();
  });

  it('resends until the receiver confirms, then stops', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    vi.advanceTimersByTime(1100);
    expect(of('B', 'handoff')).toHaveLength(3);
    relay.onAck('B', first + 1);
    vi.advanceTimersByTime(2000);
    expect(of('B', 'handoff')).toHaveLength(3);
  });

  it('tells a player who does not own the ball to drop its copy', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('B', shot(first + 1, -20));
    expect(relay.owner).toBe('A');
    expect(relay.seq).toBe(first);
    expect(of('B', 'drop_ball')).toHaveLength(1);
    expect(of('A', 'handoff')).toHaveLength(0);
  });

  it('confirms a repeated handoff again without moving the ball twice', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    relay.onHandoff('A', shot(first + 1));
    expect(relay.seq).toBe(first + 1);
    expect(relay.owner).toBe('B');
    expect(of('A', 'handoff_ok')).toHaveLength(2);
    relay.close();
  });

  it('ignores a stale repeat that arrives after the ball has come back', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    relay.onHandoff('B', shot(first + 2, -20));
    relay.onHandoff('A', shot(first + 1));
    expect(relay.owner).toBe('A');
    expect(relay.seq).toBe(first + 2);
    expect(of('A', 'drop_ball')).toHaveLength(0);
    relay.close();
  });

  it('treats the return shot as confirmation of the one before', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    relay.onHandoff('B', shot(first + 2, -20));
    relay.onAck('A', first + 2);
    vi.advanceTimersByTime(2000);
    expect(of('B', 'handoff')).toHaveLength(1);
  });

  it('rejects a shot faster than the cap and restarts the ball with the sender', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1, 200));
    expect(relay.owner).toBe('A');
    expect(relay.stats.rejected).toBe(1);
    expect(of('B', 'handoff')).toHaveLength(0);
    expect(of('A', 'spawn')).toHaveLength(2);
  });

  it('rejects a ball above the roof', () => {
    const { relay, first } = setup();
    relay.onHandoff('A', { ...shot(first + 1), y: 80 });
    expect(relay.stats.rejected).toBe(1);
  });

  it('nothing about a dead ball is accepted', () => {
    const { relay, of, first } = setup();
    relay.kill();
    relay.onHandoff('A', shot(first + 1));
    expect(relay.owner).toBe('A');
    expect(of('B', 'handoff')).toHaveLength(0);
  });

  it('passes position previews from the owner only', () => {
    const { relay, of } = setup();
    const p = { type: 'ball_preview', x: 40, y: 5, vx: 10, vy: 0 } as const;
    relay.onPreview('A', p);
    relay.onPreview('B', p);
    expect(of('B', 'ball_preview')).toHaveLength(1);
    expect(of('A', 'ball_preview')).toHaveLength(0);
  });

  it('repeats an unconfirmed handoff to a receiver who comes back', () => {
    const { relay, of, first } = setup();
    relay.onHandoff('A', shot(first + 1));
    expect(relay.resendTo('B')).toBe(true);
    expect(relay.resendTo('A')).toBe(false);
    expect(of('B', 'handoff')).toHaveLength(2);
    relay.close();
  });
});
