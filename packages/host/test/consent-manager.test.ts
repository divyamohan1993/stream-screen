/**
 * Unit tests for {@link ConsentManager} — the pure human-Accept decision core.
 *
 * Covers: accept, reject, fail-closed timeout, always-allow (immediate accept,
 * no prompt), targeting a specific request vs the oldest, and pending snapshots.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConsentManager } from '../src/consent-manager.js';

const PEER = { peerId: 'viewer-1', name: 'Alice', channelBinding: 'fp-a|fp-b' };

describe('ConsentManager', () => {
  it('resolves accept() to "accept"', async () => {
    const cm = new ConsentManager();
    const p = cm.request(PEER);
    expect(cm.pending).toHaveLength(1);
    expect(cm.accept()).toBe(true);
    await expect(p).resolves.toBe('accept');
    expect(cm.pending).toHaveLength(0);
  });

  it('resolves reject() to "reject"', async () => {
    const cm = new ConsentManager();
    const p = cm.request(PEER);
    expect(cm.reject()).toBe(true);
    await expect(p).resolves.toBe('reject');
  });

  it('fails CLOSED on timeout (auto-rejects with no decision)', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConsentManager({ timeoutMs: 30_000 });
      const p = cm.request(PEER);
      vi.advanceTimersByTime(30_000);
      await expect(p).resolves.toBe('reject');
      expect(cm.pending).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out early', async () => {
    vi.useFakeTimers();
    try {
      const cm = new ConsentManager({ timeoutMs: 30_000 });
      const p = cm.request(PEER);
      vi.advanceTimersByTime(29_999);
      let settled = false;
      void p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      cm.accept();
      await expect(p).resolves.toBe('accept');
    } finally {
      vi.useRealTimers();
    }
  });

  it('always-allow makes subsequent requests resolve "accept" immediately', async () => {
    const cm = new ConsentManager();
    const p1 = cm.request(PEER);
    expect(cm.accept(undefined, /* alsoAlways */ true)).toBe(true);
    await expect(p1).resolves.toBe('accept');

    // Second request from the SAME peer resolves immediately, no pending entry.
    const p2 = cm.request(PEER);
    await expect(p2).resolves.toBe('accept');
    expect(cm.pending).toHaveLength(0);
    expect(cm.isAlwaysAllowed(PEER.peerId)).toBe(true);
  });

  it('allowAlways() pre-authorizes a peer without a pending request', async () => {
    const cm = new ConsentManager();
    cm.allowAlways('viewer-9');
    await expect(cm.request({ peerId: 'viewer-9' })).resolves.toBe('accept');
  });

  it('targets a specific requestId; accept(other) leaves the first pending', async () => {
    const cm = new ConsentManager();
    const p1 = cm.request({ peerId: 'a' });
    const p2 = cm.request({ peerId: 'b' });
    const [r1, r2] = cm.pending;
    expect(cm.accept(r2.requestId)).toBe(true);
    await expect(p2).resolves.toBe('accept');
    // p1 still pending.
    expect(cm.pending).toHaveLength(1);
    cm.reject(r1.requestId);
    await expect(p1).resolves.toBe('reject');
  });

  it('accept() with no id settles the OLDEST request', async () => {
    const cm = new ConsentManager();
    const p1 = cm.request({ peerId: 'a' });
    const p2 = cm.request({ peerId: 'b' });
    cm.accept();
    await expect(p1).resolves.toBe('accept');
    expect(cm.pending).toHaveLength(1);
    expect(cm.pending[0].peer.peerId).toBe('b');
    cm.reject();
    await expect(p2).resolves.toBe('reject');
  });

  it('clear() rejects all pending (fail-closed) and clears always-allow', async () => {
    const cm = new ConsentManager();
    const p = cm.request(PEER);
    cm.allowAlways('viewer-x');
    cm.clear();
    await expect(p).resolves.toBe('reject');
    expect(cm.isAlwaysAllowed('viewer-x')).toBe(false);
  });

  it('accept/reject return false when there is nothing to settle', () => {
    const cm = new ConsentManager();
    expect(cm.accept()).toBe(false);
    expect(cm.reject(999)).toBe(false);
  });

  it('notifies onPendingChange when the pending set changes', async () => {
    const seen: number[] = [];
    const cm = new ConsentManager({ onPendingChange: (p) => seen.push(p.length) });
    const p = cm.request(PEER);
    cm.accept();
    await p;
    expect(seen).toEqual([1, 0]);
  });
});
