/**
 * Turn ConnectWise service tickets into incident work.
 *
 * Pure planning: decide what a pull would do, without doing it. The UI shows
 * the plan before anything is written, because a mis-scoped board condition
 * can otherwise open a few hundred investigations in one click.
 */

import type { CaseUpdate, Folder, IncidentSeverity } from '../types';
import { CW_SOURCE, ticketToIncident, type CWTicket, type TicketIncidentDraft } from './connectwise';

export interface TicketIntakeItem {
  ticketId: string;
  draft: TicketIncidentDraft;
  /** The investigation this ticket already opened, when there is one. */
  existing?: Folder;
  /** What a pull would do to it. */
  action: 'create' | 'update' | 'unchanged';
  /** Fields that differ from the existing investigation, for `update`. */
  changes: TicketChange[];
}

export interface TicketChange {
  field: 'severity' | 'status' | 'name';
  from?: string;
  to?: string;
}

export interface TicketIntakePlan {
  items: TicketIntakeItem[];
  toCreate: number;
  toUpdate: number;
  unchanged: number;
}

/** Index investigations by the external ticket id they came from. */
function byExternalRef(folders: Folder[]): Map<string, Folder> {
  const map = new Map<string, Folder>();
  for (const folder of folders) {
    const ref = folder.externalRefs?.[CW_SOURCE];
    if (ref) map.set(ref, folder);
  }
  return map;
}

/**
 * Decide what pulling these tickets would do.
 *
 * A ticket that already has an investigation is only reported as `update` when
 * something an analyst would care about actually moved — severity, closure, or
 * the summary. Re-running a pull on an unchanged board must be a no-op, or the
 * case log fills with noise that buries the real entries.
 */
export function planTicketIntake(
  tickets: CWTicket[],
  folders: Folder[],
  opts: { minSeverity?: IncidentSeverity } = {},
): TicketIntakePlan {
  const existingByRef = byExternalRef(folders);
  const items: TicketIntakeItem[] = [];

  const severityFloor = opts.minSeverity ? SEVERITY_ORDER.indexOf(opts.minSeverity) : -1;

  for (const ticket of tickets) {
    const draft = ticketToIncident(ticket);
    if (!draft) continue;

    if (severityFloor >= 0) {
      const rank = SEVERITY_ORDER.indexOf(draft.severity);
      // Below the floor is not an incident for our purposes — skip entirely
      // rather than creating a case nobody will triage.
      if (rank < 0 || rank > severityFloor) continue;
    }

    const existing = existingByRef.get(draft.externalRef);
    if (!existing) {
      items.push({ ticketId: draft.externalRef, draft, action: 'create', changes: [] });
      continue;
    }

    const changes = diffTicket(draft, existing);
    items.push({
      ticketId: draft.externalRef,
      draft,
      existing,
      action: changes.length > 0 ? 'update' : 'unchanged',
      changes,
    });
  }

  return {
    items,
    toCreate: items.filter((i) => i.action === 'create').length,
    toUpdate: items.filter((i) => i.action === 'update').length,
    unchanged: items.filter((i) => i.action === 'unchanged').length,
  };
}

const SEVERITY_ORDER: IncidentSeverity[] = ['critical', 'high', 'medium', 'low', 'none'];

/** What moved on the ticket since the investigation was last synced. */
export function diffTicket(draft: TicketIncidentDraft, folder: Folder): TicketChange[] {
  const changes: TicketChange[] = [];

  if (draft.severity !== (folder.severity ?? 'none')) {
    changes.push({ field: 'severity', from: folder.severity ?? 'none', to: draft.severity });
  }

  const ticketClosed = draft.closedAt != null;
  const folderClosed = folder.status === 'closed';
  if (ticketClosed !== folderClosed) {
    changes.push({
      field: 'status',
      from: folderClosed ? 'closed' : 'active',
      to: ticketClosed ? 'closed' : 'active',
    });
  }

  if (draft.name !== folder.name) {
    changes.push({ field: 'name', from: folder.name, to: draft.name });
  }

  return changes;
}

/**
 * The investigation fields a ticket supplies when it first opens a case.
 *
 * `detectedAt` comes from the ticket's own entry time rather than now — the
 * incident clock should measure the response, not how long it took someone to
 * run the sync.
 */
export function folderFieldsFromTicket(draft: TicketIncidentDraft): Partial<Folder> {
  return {
    name: draft.name,
    description: draft.description,
    severity: draft.severity,
    detectedAt: draft.detectedAt,
    incidentCommander: draft.incidentCommander,
    externalRefs: { [CW_SOURCE]: draft.externalRef },
    ...(draft.closedAt ? { status: 'closed' as const, closedAt: draft.closedAt } : {}),
  };
}

/** The investigation fields an already-synced ticket updates. */
export function folderUpdatesFromTicket(
  draft: TicketIncidentDraft,
  changes: TicketChange[],
): Partial<Folder> {
  const updates: Partial<Folder> = {};
  for (const change of changes) {
    if (change.field === 'severity') updates.severity = draft.severity;
    if (change.field === 'name') updates.name = draft.name;
    if (change.field === 'status') {
      if (draft.closedAt) {
        updates.status = 'closed';
        updates.closedAt = draft.closedAt;
      } else {
        // A ticket reopening reopens the case, but the closure timestamp is
        // left alone — it records that a first closure happened.
        updates.status = 'active';
      }
    }
  }
  return updates;
}

/**
 * The case log entry recording what a sync did.
 *
 * Written as `status` and attributed to ConnectWise rather than to the analyst
 * running the sync — the case log is a record of who said what, and crediting a
 * person for a machine's observation would corrupt that.
 */
export function caseUpdateFromTicket(
  item: TicketIntakeItem,
  folderId: string,
  now: number,
): Omit<CaseUpdate, 'id'> {
  const body =
    item.action === 'create'
      ? describeOpen(item.draft)
      : `ConnectWise ticket #${item.ticketId} changed: ${item.changes
          .map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`)
          .join('; ')}`;

  return {
    folderId,
    type: 'status',
    body,
    authorName: 'ConnectWise',
    createdAt: now,
    updatedAt: now,
  };
}

function describeOpen(draft: TicketIncidentDraft): string {
  const parts = [`Opened from ConnectWise ticket #${draft.externalRef}.`];
  if (draft.boardName) parts.push(`Board: ${draft.boardName}.`);
  if (draft.companyName) parts.push(`Company: ${draft.companyName}.`);
  parts.push(`Severity: ${draft.severity}.`);
  return parts.join(' ');
}
