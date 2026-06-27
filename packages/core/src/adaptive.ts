import type { AdaptiveDecision, AdaptiveStats } from './protocol.js';

/** Tuning knobs for the {@link AdaptiveController}. */
export interface AdaptiveOptions {
  /** Floor for the negotiated bitrate, in kbps. Default 300. */
  minKbps?: number;
  /** Ceiling for the negotiated bitrate, in kbps. Default 40000 (40 Mbps). */
  maxKbps?: number;
  /** RTT we aim to stay under, in ms. Default 120. */
  targetRttMs?: number;
}

/** Internal phase of the AIMD state machine. */
type Phase = 'INCREASE' | 'HOLD' | 'DECREASE';

const DEFAULTS = {
  minKbps: 300,
  maxKbps: 40_000,
  targetRttMs: 120,
} as const;

/** Additive-increase step as a fraction of current bitrate. */
const INCREASE_FACTOR = 0.08;
/** Loss percentage above which we treat the link as congested. */
const LOSS_HIGH = 5;
/** Loss percentage under which the link is considered clean. */
const LOSS_LOW = 2;
/** Jitter (ms) above which we hold/decrease even if RTT is fine. */
const JITTER_HIGH = 30;

/**
 * Research-grade adaptive bitrate/quality controller.
 *
 * Implements a congestion-aware AIMD scheme (additive-increase,
 * multiplicative-decrease) over RTT, packet loss, and jitter:
 *
 *  - INCREASE: when RTT < target, loss < {@link LOSS_LOW}%, and jitter is low,
 *    grow the target bitrate by {@link INCREASE_FACTOR} (gentle ramp-up). The
 *    increase is also limited so we never overshoot the measured
 *    `availableKbps` headroom.
 *  - DECREASE: when loss > {@link LOSS_HIGH}%, RTT > target * 1.6, or jitter
 *    spikes, multiplicatively back off. The multiplier scales with severity
 *    (0.6 for a hard congestion signal, up to 0.85 for a mild one) so the
 *    response is fast but proportionate.
 *  - HOLD: ambiguous region (e.g. mild loss, RTT near target) — keep the
 *    current bitrate steady to avoid oscillation.
 *
 * The result is clamped to `[minKbps, maxKbps]`. Framerate (15..60) and
 * `scaleResolutionDownBy` (1 / 1.5 / 2 / 3 / 4) are then derived from how much
 * of `maxKbps` the chosen bitrate represents, so low-bandwidth links shed
 * resolution and framerate gracefully instead of stalling.
 *
 * The controller is fully deterministic and pure (no timers, no randomness):
 * the same sequence of {@link AdaptiveStats} always yields the same decisions,
 * which makes it unit-testable. There are no time-based session limits and no
 * bitrate ceiling beyond the caller-supplied `maxKbps` — this is the
 * "auto-negotiate lag" engine.
 */
export class AdaptiveController {
  private readonly minKbps: number;
  private readonly maxKbps: number;
  private readonly targetRttMs: number;

  /** Current negotiated bitrate (kbps). Starts conservative. */
  private current: number;

  constructor(opts?: AdaptiveOptions) {
    this.minKbps = opts?.minKbps ?? DEFAULTS.minKbps;
    this.maxKbps = opts?.maxKbps ?? DEFAULTS.maxKbps;
    this.targetRttMs = opts?.targetRttMs ?? DEFAULTS.targetRttMs;
    if (this.minKbps <= 0 || this.maxKbps < this.minKbps) {
      throw new RangeError('AdaptiveController: require 0 < minKbps <= maxKbps');
    }
    if (this.targetRttMs <= 0) {
      throw new RangeError('AdaptiveController: targetRttMs must be positive');
    }
    // Start conservatively: 2x the floor, clamped to bounds. This gives a
    // safe baseline that ramps up quickly on a healthy link.
    this.current = this.clamp(Math.max(this.minKbps * 2, this.minKbps));
  }

  private clamp(kbps: number): number {
    return Math.min(this.maxKbps, Math.max(this.minKbps, kbps));
  }

  /**
   * Classify the link and choose the next phase + multiplicative severity.
   * Returns the back-off factor (1 = no decrease) and whether to increase.
   */
  private classify(s: AdaptiveStats): { phase: Phase; factor: number; reason: string } {
    const rttHard = this.targetRttMs * 1.6;
    const congested =
      s.lossPct > LOSS_HIGH || s.rttMs > rttHard || s.jitterMs > JITTER_HIGH * 1.5;

    if (congested) {
      // Severity in [0,1]: combine the worst of the three signals.
      const lossSev = Math.min(1, Math.max(0, (s.lossPct - LOSS_LOW) / (20 - LOSS_LOW)));
      const rttSev = Math.min(1, Math.max(0, (s.rttMs - this.targetRttMs) / (this.targetRttMs * 2)));
      const jitterSev = Math.min(1, Math.max(0, (s.jitterMs - JITTER_HIGH) / (JITTER_HIGH * 2)));
      const sev = Math.max(lossSev, rttSev, jitterSev);
      // Map severity to a 0.85 (mild) .. 0.60 (severe) multiplier.
      const factor = 0.85 - 0.25 * sev;
      const why: string[] = [];
      if (s.lossPct > LOSS_HIGH) why.push(`loss ${s.lossPct.toFixed(1)}%`);
      if (s.rttMs > rttHard) why.push(`rtt ${Math.round(s.rttMs)}ms`);
      if (s.jitterMs > JITTER_HIGH * 1.5) why.push(`jitter ${Math.round(s.jitterMs)}ms`);
      return { phase: 'DECREASE', factor, reason: `back off (${why.join(', ')})` };
    }

    // Guard against degenerate all-zero snapshots (pc null, empty stats report,
    // or media not yet flowing): an all-zero stat trivially passes every "clean"
    // threshold (0 < target, 0 < LOSS_LOW, 0 < JITTER_HIGH) and would ramp the
    // bitrate toward maxKbps on no real measurement. Require a real signal —
    // a measured RTT or an active frame rate / reported headroom — before
    // increasing; otherwise HOLD.
    const hasSignal = s.rttMs > 0 || s.fps > 0 || s.availableKbps > 0;
    const clean = s.rttMs < this.targetRttMs && s.lossPct < LOSS_LOW && s.jitterMs < JITTER_HIGH;
    if (clean && hasSignal) {
      return { phase: 'INCREASE', factor: 1 + INCREASE_FACTOR, reason: 'healthy link, ramping up' };
    }
    if (!hasSignal) {
      return { phase: 'HOLD', factor: 1, reason: 'no telemetry yet, holding steady' };
    }

    return { phase: 'HOLD', factor: 1, reason: 'ambiguous signals, holding steady' };
  }

  /**
   * Derive a max framerate from how much of the ceiling we are using.
   * Plenty of bandwidth → full 60fps; squeezed → drop toward 15fps.
   */
  private frameRateFor(kbps: number): number {
    const ratio = kbps / this.maxKbps;
    if (ratio >= 0.5) return 60;
    if (ratio >= 0.25) return 45;
    if (ratio >= 0.12) return 30;
    if (ratio >= 0.05) return 24;
    return 15;
  }

  /**
   * Derive a resolution downscale factor from the chosen bitrate. We only shed
   * resolution once framerate alone can't absorb the squeeze.
   */
  private scaleFor(kbps: number): number {
    if (kbps >= 8_000) return 1;
    if (kbps >= 3_000) return 1.5;
    if (kbps >= 1_200) return 2;
    if (kbps >= 600) return 3;
    return 4;
  }

  /**
   * Ingest the latest {@link AdaptiveStats} and produce the next
   * {@link AdaptiveDecision}. Pure with respect to inputs given internal state;
   * call once per measurement tick.
   */
  update(s: AdaptiveStats): AdaptiveDecision {
    const { phase, factor, reason } = this.classify(s);

    let next = this.current;
    if (phase === 'INCREASE') {
      next = this.current * factor;
      // Don't sprint past measured headroom: if the link reports an available
      // outgoing bitrate, cap the increase a little above it.
      if (s.availableKbps > 0) {
        next = Math.min(next, Math.max(this.current, s.availableKbps * 1.05));
      }
    } else if (phase === 'DECREASE') {
      next = this.current * factor;
      // If the link explicitly reports lower headroom, respect it immediately.
      if (s.availableKbps > 0) {
        next = Math.min(next, Math.max(this.minKbps, s.availableKbps));
      }
    }

    this.current = this.clamp(next);

    const maxFramerate = this.frameRateFor(this.current);
    const scaleResolutionDownBy = this.scaleFor(this.current);

    return {
      targetKbps: Math.round(this.current),
      maxFramerate,
      scaleResolutionDownBy,
      reason: `${phase}: ${reason} → ${Math.round(this.current)}kbps @ ${maxFramerate}fps /${scaleResolutionDownBy}`,
    };
  }
}
