import type {
  CaseUpdate,
  CaseUpdateType,
  Folder,
  IncidentPhase,
  IncidentSeverity,
} from '../types';
import { INCIDENT_PHASES } from '../types';

/** Newest first — how a case log is read during a live response. */
export function sortUpdates(updates: CaseUpdate[]): CaseUpdate[] {
  return [...updates].sort((a, b) => b.createdAt - a.createdAt);
}

/** Oldest first — how a case log is read when writing the incident report. */
export function chronological(updates: CaseUpdate[]): CaseUpdate[] {
  return [...updates].sort((a, b) => a.createdAt - b.createdAt);
}

export function filterUpdates(
  updates: CaseUpdate[],
  filter: { types?: CaseUpdateType[]; phase?: IncidentPhase; query?: string },
): CaseUpdate[] {
  const needle = filter.query?.trim().toLowerCase();
  return updates.filter((update) => {
    if (filter.types && filter.types.length > 0 && !filter.types.includes(update.type)) return false;
    if (filter.phase && update.phase !== filter.phase) return false;
    if (needle && !`${update.body} ${update.authorName ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Apply an edit, preserving the superseded text.
 *
 * A case log is a contemporaneous record; an edit that silently replaced the
 * original would destroy its value as evidence. Returns the update unchanged
 * when the body has not actually changed, so a no-op save cannot pad the
 * history with identical revisions.
 */
export function applyEdit(
  update: CaseUpdate,
  body: string,
  options: { editedBy?: string; now?: number } = {},
): CaseUpdate {
  const next = body.trim();
  if (!next || next === update.body) return update;
  const now = options.now ?? Date.now();
  return {
    ...update,
    body: next,
    updatedAt: now,
    revisions: [
      ...(update.revisions ?? []),
      { body: update.body, editedAt: now, editedBy: options.editedBy },
    ],
  };
}

export function isEdited(update: CaseUpdate): boolean {
  return (update.revisions?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Incident clock
// ---------------------------------------------------------------------------

/** Folder timestamp field that a phase completion stamps. */
const PHASE_TIMESTAMP: Partial<Record<IncidentPhase, keyof Folder>> = {
  detection: 'detectedAt',
  containment: 'containedAt',
  eradication: 'eradicatedAt',
  recovery: 'recoveredAt',
};

/**
 * The folder patch for moving an incident to a new phase.
 *
 * Entering a phase stamps the *previous* milestones that have not been recorded
 * yet, so a responder who jumps straight from triage to recovery still gets a
 * usable clock rather than gaps. Existing stamps are never overwritten — the
 * first time something was contained is the fact worth keeping.
 */
export function advancePhase(
  folder: Folder,
  phase: IncidentPhase,
  now: number,
): Partial<Folder> {
  const patch: Partial<Folder> = { irPhase: phase };
  const targetIndex = INCIDENT_PHASES.indexOf(phase);

  for (let i = 0; i <= targetIndex; i++) {
    const field = PHASE_TIMESTAMP[INCIDENT_PHASES[i]];
    if (field && folder[field] == null) {
      (patch as Record<string, unknown>)[field] = now;
    }
  }
  return patch;
}

export interface IncidentDurations {
  /** Detection to containment, ms. Undefined until both are stamped. */
  timeToContain?: number;
  /** Detection to recovery, ms. */
  timeToRecover?: number;
  /** Case open to now (or to closure), ms. */
  age: number;
}

export function incidentDurations(folder: Folder, now: number): IncidentDurations {
  const { detectedAt, containedAt, recoveredAt } = folder;
  return {
    timeToContain: detectedAt != null && containedAt != null ? containedAt - detectedAt : undefined,
    timeToRecover: detectedAt != null && recoveredAt != null ? recoveredAt - detectedAt : undefined,
    age: (folder.closedAt ?? now) - folder.createdAt,
  };
}

/** Sort weight for a severity, most urgent first. Untriaged sorts last. */
export function severityRank(severity: IncidentSeverity | undefined): number {
  switch (severity) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
    default: return 4;
  }
}

/** True when a folder has been triaged as an incident rather than a plain case. */
export function isIncident(folder: Folder): boolean {
  return folder.severity != null && folder.severity !== 'none';
}

/** Open incidents, most urgent first, then oldest first within a severity. */
export function triageQueue(folders: Folder[]): Folder[] {
  return folders
    .filter((f) => isIncident(f) && f.status !== 'closed' && f.status !== 'archived')
    .sort((a, b) => {
      const rank = severityRank(a.severity) - severityRank(b.severity);
      return rank !== 0 ? rank : a.createdAt - b.createdAt;
    });
}
