import { AdaptiveController, type AdaptiveStats, type AdaptiveDecision } from '@stream-screen/core';

/**
 * Viewer-selectable quality presets. `Auto` lets the {@link AdaptiveController}
 * negotiate freely (the default "auto-negotiate lag" behaviour); the others pin
 * a bitrate ceiling for users who want to bias toward sharpness or low latency.
 *
 * Even the manual presets impose NO time limit and NO hard cap below what the
 * link can carry — they only adjust the adaptive ceiling.
 */
export type QualityPreset = 'Auto' | 'High' | 'Balanced' | 'Low';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['Auto', 'High', 'Balanced', 'Low'] as const;

/** Per-preset ceiling (kbps). `Auto` uses the controller's full range. */
const PRESET_MAX_KBPS: Record<QualityPreset, number> = {
  Auto: 40_000,
  High: 40_000,
  Balanced: 8_000,
  Low: 2_000,
};

/**
 * Build an {@link AdaptiveController} configured for the chosen preset. This is
 * the engine the viewer can optionally run to advise the host (the host runs
 * its own authoritative controller, but mirroring it client-side lets the
 * viewer display the live decision reason in the stats panel).
 */
export function controllerForPreset(preset: QualityPreset): AdaptiveController {
  return new AdaptiveController({ maxKbps: PRESET_MAX_KBPS[preset] });
}

/** Convenience: run one tick of the preset's controller over a stats sample. */
export function decideForPreset(
  controller: AdaptiveController,
  stats: AdaptiveStats,
): AdaptiveDecision {
  return controller.update(stats);
}
