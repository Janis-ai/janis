import { describe, expect, it } from 'vitest';
import {
  reconcilePoll,
  timelineItems,
  type ChatMsg,
  type OutEntry,
} from './chatTimeline';

const msg = (id: string, direction: string, text: string, ts: string): ChatMsg => ({
  id,
  direction,
  text,
  created_at: ts,
});

const pending = (text: string, ts: string): OutEntry => ({
  localId: `l-${text}`,
  text,
  attachments: [],
  status: 'pending',
  ts,
});

const order = (msgs: ChatMsg[], outbox: OutEntry[]) =>
  timelineItems(msgs, outbox).map((i) =>
    i.kind === 'msg' ? `${i.m.direction}:${i.m.text}` : `echo:${i.o.text}`,
  );

describe('reconcilePoll + timelineItems', () => {
  // Regression: the optimistic bubble carries the client send-time, which
  // precedes the server-inserted greeting row — the greeting rendered below
  // the visitor's first message in test mode.
  it('renders the stored greeting before the echoed first message', () => {
    const outbox = [pending('who are you?', '2026-02-01T00:00:00.000Z')];
    const batch = [
      msg('g1', 'out', 'Hi! How can we help?', '2026-02-01T00:00:00.050Z'),
      msg('m1', 'in', 'who are you?', '2026-02-01T00:00:00.100Z'),
      msg('r1', 'out', "I'm borg, the Janis concierge.", '2026-02-01T00:00:02.000Z'),
    ];

    const { outbox: next, fresh } = reconcilePoll(outbox, batch, new Set());

    expect(next[0].status).toBe('delivered');
    // the echo adopts the server timestamp — after the greeting's
    expect(next[0].ts).toBe('2026-02-01T00:00:00.100Z');
    expect(fresh.map((m) => m.id)).toEqual(['g1', 'r1']);

    expect(order(fresh, next)).toEqual([
      'out:Hi! How can we help?',
      'echo:who are you?',
      "out:I'm borg, the Janis concierge.",
    ]);
  });

  it('keeps a pending entry at client time until its echo lands', () => {
    const outbox = [pending('still flying', '2026-02-01T00:00:05.000Z')];
    const msgs = [msg('g1', 'out', 'Hi!', '2026-02-01T00:00:04.000Z')];
    expect(order(msgs, outbox)).toEqual(['out:Hi!', 'echo:still flying']);
  });

  it('swallows only the matching echo; a different inbound stays a message', () => {
    const outbox = [pending('hello', '2026-02-01T00:00:00.000Z')];
    const batch = [
      msg('m1', 'in', 'someone else', '2026-02-01T00:00:01.000Z'),
      msg('m2', 'in', 'hello', '2026-02-01T00:00:02.000Z'),
    ];
    const { outbox: next, fresh } = reconcilePoll(outbox, batch, new Set());
    expect(next[0].status).toBe('delivered');
    expect(fresh.map((m) => m.id)).toEqual(['m1']);
  });

  it('dedupes rows already seen by id', () => {
    const seen = new Set(['g1']);
    const { fresh } = reconcilePoll(
      [],
      [msg('g1', 'out', 'Hi!', '2026-02-01T00:00:00.000Z'), msg('m1', 'in', 'yo', '2026-02-01T00:00:01.000Z')],
      seen,
    );
    expect(fresh.map((m) => m.id)).toEqual(['m1']);
    expect(seen.has('m1')).toBe(true);
  });

  it('demotes the previous delivered receipt when a new echo lands', () => {
    const outbox = [
      { ...pending('first', '2026-02-01T00:00:00.000Z'), status: 'delivered' as const },
      pending('second', '2026-02-01T00:00:01.000Z'),
    ];
    const { outbox: next } = reconcilePoll(
      outbox,
      [msg('m2', 'in', 'second', '2026-02-01T00:00:02.000Z')],
      new Set(['m1']),
    );
    expect(next.map((o) => o.status)).toEqual(['sent', 'delivered']);
  });

  // Regression: a POST that lost its response still stored the row — the
  // entry showed "failed to send" and the late echo rendered the message a
  // second time. The sender's client_id reconciles it exactly.
  it('matches an echo by client_id even when the entry was marked failed', () => {
    const outbox: OutEntry[] = [
      { localId: 'l-1', text: 'hi', attachments: [], status: 'failed', ts: '2026-02-01T00:00:00.000Z' },
    ];
    const echo: ChatMsg = {
      ...msg('m1', 'in', 'hi', '2026-02-01T00:00:01.000Z'),
      client_id: 'l-1',
    };
    const { outbox: next, fresh } = reconcilePoll(outbox, [echo], new Set());
    expect(next[0].status).toBe('delivered');
    expect(fresh).toHaveLength(0);
  });

  it('client_id disambiguates two identical pending sends', () => {
    const outbox: OutEntry[] = [
      { localId: 'l-a', text: 'same', attachments: [], status: 'pending', ts: '2026-02-01T00:00:00.000Z' },
      { localId: 'l-b', text: 'same', attachments: [], status: 'pending', ts: '2026-02-01T00:00:01.000Z' },
    ];
    const echo: ChatMsg = {
      ...msg('m1', 'in', 'same', '2026-02-01T00:00:02.000Z'),
      client_id: 'l-b',
    };
    const { outbox: next, fresh } = reconcilePoll(outbox, [echo], new Set());
    expect(next[0].status).toBe('pending');
    expect(next[1].status).toBe('delivered');
    expect(fresh).toHaveLength(0);
  });

  it('tracks batch extremes for the poll cursors', () => {
    const { maxTs, minTs } = reconcilePoll(
      [],
      [
        msg('a', 'out', 'b', '2026-02-01T00:00:03.000Z'),
        msg('b', 'in', 'a', '2026-02-01T00:00:01.000Z'),
      ],
      new Set(),
    );
    expect(maxTs).toBe('2026-02-01T00:00:03.000Z');
    expect(minTs).toBe('2026-02-01T00:00:01.000Z');
  });
});
