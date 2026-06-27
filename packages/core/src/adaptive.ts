import type { AdaptiveDecision, AdaptiveStats } from './protocol.js';

/** Tuning knobs for the {@link AdaptiveController}. */
export interface AdaptiveOptions {
  minKbps?: number;
  maxKbps?: number;
  targetRttMs?: number;
}

/**
 * Research-grade adaptive bitrate/quality controller.
 *
 * Implements an AIMD scheme (additive-increase, multiplicative-decrease) that
 * is aware of RTT, packet loss, and jitter: it ramps the target bitrate up
 * gently while RTT stays under target and loss is low, and backs off fast when
 * congestion signals rise. The chosen bitrate, framerate, and
 * `scaleResolutionDownBy` are derived from the available headroom and clamped
 * to `[minKbps, maxKbps]`.
 *
 * No bitrate ceiling is imposed beyond the caller-supplied `maxKbps`, and there
 * are no time-based session limits — this is the "auto-negotiate lag" engine.
 *
 * NOTE: stub — full implementation lands in the core implementation phase.
 */
export class AdaptiveController {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(opts?: AdaptiveOptions) {
    void opts;
  }

  /**
   * Ingest the latest {@link AdaptiveStats} and produce the next
   * {@link AdaptiveDecision}.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(s: AdaptiveStats): AdaptiveDecision {
    void s;
    throw new Error('not-implemented');
  }
}
