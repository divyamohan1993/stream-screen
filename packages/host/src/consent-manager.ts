/**
 * consent-manager — the pure decision core for "a human at the host must
 * Accept this viewer" (the 'prompt' and 'pin-and-prompt' modes).
 *
 * This holds NO UI. It exposes a single {@link ConsentManager.request} that
 * returns a Promise resolving to 'accept' or 'reject', plus
 * {@link ConsentManager.accept} / {@link ConsentManager.reject} that the thin UI
 * (or a test) calls to settle a pending request. Keeping the logic here makes
 * the accept/reject/timeout/always-allow behavior unit-testable without an
 * Electron window.
 *
 * FAIL-CLOSED TIMEOUT: every request is bounded by a timeout (default 30s). If
 * the host human does not decide in time the request resolves to 'reject' — the
 * secure default. The timeout is a PER-REQUEST bound, NOT a session time limit:
 * it only governs how long a single pending consent prompt waits for a human.
 *
 * ALWAYS-ALLOW: a host can mark a peer "always allow for this session" (keyed by
 * peerId). Subsequent requests from that peer resolve to 'accept' immediately
 * WITHOUT prompting, until the manager is cleared (e.g. session teardown).
 */

/** What the UI needs to render a consent prompt. */
export interface PeerInfo {
  peerId: string;
  name?: string;
  address?: string;
  channelBinding?: string;
}

/** The outcome of a consent request. */
export type ConsentDecision = 'accept' | 'reject';

/** A request awaiting a human decision, surfaced to the UI. */
export interface PendingConsent {
  /** Monotonic id distinguishing concurrent requests for the same peer. */
  requestId: number;
  peer: PeerInfo;
  /** Epoch ms when this request will auto-reject if undecided. */
  expiresAt: number;
}

/** Tunables for {@link ConsentManager}. */
export interface ConsentOptions {
  /** Per-request timeout in ms (auto-reject). Default 30_000. */
  timeoutMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Injectable timer scheduler (so tests can use fake timers cleanly). Defaults
   * to setTimeout/clearTimeout. Returns an opaque handle.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Optional observer fired whenever the pending set changes (added/settled), so
   * a UI can re-render. Receives the current pending list snapshot.
   */
  onPendingChange?: (pending: PendingConsent[]) => void;
}

/** One in-flight request's bookkeeping. */
interface Inflight {
  requestId: number;
  peer: PeerInfo;
  expiresAt: number;
  resolve: (d: ConsentDecision) => void;
  timer: unknown;
}

export const DEFAULT_CONSENT_TIMEOUT_MS = 30_000;

export class ConsentManager {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onPendingChange?: (pending: PendingConsent[]) => void;

  private seq = 0;
  /** All in-flight requests, keyed by requestId. */
  private readonly inflight = new Map<number, Inflight>();
  /** Peers approved for the lifetime of this session. */
  private readonly alwaysAllow = new Set<string>();

  constructor(opts: ConsentOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onPendingChange = opts.onPendingChange;
  }

  /**
   * Request consent for a viewer. Resolves to:
   *   - 'accept' IMMEDIATELY if the peer is on the always-allow set;
   *   - 'accept'/'reject' when the host human decides via accept()/reject();
   *   - 'reject' if the per-request timeout elapses first (FAIL-CLOSED).
   *
   * Never rejects the Promise — a denial is a resolved 'reject', so callers do
   * not have to distinguish "denied" from "errored".
   */
  request(peer: PeerInfo): Promise<ConsentDecision> {
    if (this.alwaysAllow.has(peer.peerId)) {
      return Promise.resolve('accept');
    }
    const requestId = ++this.seq;
    const expiresAt = this.now() + this.timeoutMs;
    return new Promise<ConsentDecision>((resolve) => {
      const timer = this.setTimer(() => {
        this.settle(requestId, 'reject');
      }, this.timeoutMs);
      this.inflight.set(requestId, { requestId, peer, expiresAt, resolve, timer });
      this.emitPending();
    });
  }

  /** The current pending requests (snapshot) for the UI. */
  get pending(): PendingConsent[] {
    return [...this.inflight.values()].map((r) => ({
      requestId: r.requestId,
      peer: r.peer,
      expiresAt: r.expiresAt,
    }));
  }

  /**
   * Accept a pending request. With a `requestId`, settles exactly that request;
   * without one, accepts the OLDEST pending request (the common single-prompt
   * UI). `alsoAlways` adds the peer to the session's always-allow set. Returns
   * true if a request was settled.
   */
  accept(requestId?: number, alsoAlways = false): boolean {
    const target = this.resolveTarget(requestId);
    if (target === null) return false;
    if (alsoAlways) this.alwaysAllow.add(this.inflight.get(target)!.peer.peerId);
    return this.settle(target, 'accept');
  }

  /**
   * Reject a pending request. With a `requestId`, settles exactly that request;
   * without one, rejects the OLDEST pending request. Returns true if a request
   * was settled.
   */
  reject(requestId?: number): boolean {
    const target = this.resolveTarget(requestId);
    if (target === null) return false;
    return this.settle(target, 'reject');
  }

  /** Add a peer to the session always-allow set (without a pending request). */
  allowAlways(peerId: string): void {
    this.alwaysAllow.add(peerId);
  }

  /** True if a peer is on the always-allow set. */
  isAlwaysAllowed(peerId: string): boolean {
    return this.alwaysAllow.has(peerId);
  }

  /** Reject every pending request (fail-closed) and clear always-allow. */
  clear(): void {
    for (const id of [...this.inflight.keys()]) this.settle(id, 'reject');
    this.alwaysAllow.clear();
  }

  /** Pick the explicit requestId, or the oldest pending one. */
  private resolveTarget(requestId?: number): number | null {
    if (requestId !== undefined) {
      return this.inflight.has(requestId) ? requestId : null;
    }
    // Oldest = smallest requestId among in-flight.
    let oldest: number | null = null;
    for (const id of this.inflight.keys()) {
      if (oldest === null || id < oldest) oldest = id;
    }
    return oldest;
  }

  /** Resolve + clean up a request. Idempotent. Returns true if it was live. */
  private settle(requestId: number, decision: ConsentDecision): boolean {
    const r = this.inflight.get(requestId);
    if (!r) return false;
    this.inflight.delete(requestId);
    this.clearTimer(r.timer);
    r.resolve(decision);
    this.emitPending();
    return true;
  }

  private emitPending(): void {
    this.onPendingChange?.(this.pending);
  }
}
