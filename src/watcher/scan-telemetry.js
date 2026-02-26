export function mergeScanTelemetrySnapshot(current, telemetry) {
  if (!telemetry) return { ...current };
  return {
    filesIngested: (current.filesIngested || 0) + (telemetry.filesIngested || 0),
    assetsIngested: (current.assetsIngested || 0) + (telemetry.assetsIngested || 0),
    deletesProcessed: (current.deletesProcessed || 0) + (telemetry.deletesProcessed || 0),
    errorsCount: (current.errorsCount || 0) + (telemetry.errorsCount || 0),
    lastIngestAt: telemetry.lastIngestAt || current.lastIngestAt || null
  };
}

export function reconcileFinalTelemetry({ streamedTelemetry, streamedTotals, finalTelemetry }) {
  if (!streamedTelemetry) return finalTelemetry || null;
  if (!finalTelemetry) return null;

  return {
    filesIngested: Math.max(0, (finalTelemetry.filesIngested || 0) - (streamedTotals?.filesIngested || 0)),
    assetsIngested: Math.max(0, (finalTelemetry.assetsIngested || 0) - (streamedTotals?.assetsIngested || 0)),
    deletesProcessed: Math.max(0, (finalTelemetry.deletesProcessed || 0) - (streamedTotals?.deletesProcessed || 0)),
    errorsCount: Math.max(0, (finalTelemetry.errorsCount || 0) - (streamedTotals?.errorsCount || 0)),
    lastIngestAt: finalTelemetry.lastIngestAt || null
  };
}

export function getConfigReloadAction(projectsChanged, hasActiveWatcher) {
  if (!projectsChanged) return 'none';
  return hasActiveWatcher ? 'restart' : 'defer';
}
