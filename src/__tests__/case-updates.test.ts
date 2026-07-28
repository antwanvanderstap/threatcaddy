import { describe, it, expect } from 'vitest';
import {
  sortUpdates,
  chronological,
  filterUpdates,
  applyEdit,
  isEdited,
  advancePhase,
  incidentDurations,
  severityRank,
  isIncident,
  triageQueue,
} from '../lib/case-updates';
import { sanitizeCaseUpdate } from '../lib/export';
import type { CaseUpdate, Folder } from '../types';

function makeUpdate(p: Partial<CaseUpdate> & { id: string }): CaseUpdate {
  return {
    folderId: 'f1', type: 'status', body: 'body',
    createdAt: 1000, updatedAt: 1000, ...p,
  };
}

function makeFolder(p: Partial<Folder> & { id: string }): Folder {
  return { name: p.name ?? p.id, order: 0, createdAt: 0, ...p };
}

const HOUR = 3_600_000;

// ── Ordering and filtering ──────────────────────────────────────────

describe('ordering', () => {
  const updates = [
    makeUpdate({ id: 'a', createdAt: 100 }),
    makeUpdate({ id: 'c', createdAt: 300 }),
    makeUpdate({ id: 'b', createdAt: 200 }),
  ];

  it('reads newest first during a live response', () => {
    expect(sortUpdates(updates).map((u) => u.id)).toEqual(['c', 'b', 'a']);
  });

  it('reads oldest first for the write-up', () => {
    expect(chronological(updates).map((u) => u.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const original = [...updates];
    sortUpdates(updates);
    chronological(updates);
    expect(updates).toEqual(original);
  });
});

describe('filterUpdates', () => {
  const updates = [
    makeUpdate({ id: 'a', type: 'finding', body: 'Found beaconing to 10.0.0.5', phase: 'detection' }),
    makeUpdate({ id: 'b', type: 'action', body: 'Isolated the host', phase: 'containment', authorName: 'Antwan' }),
    makeUpdate({ id: 'c', type: 'status', body: 'Handed to day shift', phase: 'containment' }),
  ];

  it('separates what we did from what we found', () => {
    expect(filterUpdates(updates, { types: ['action'] }).map((u) => u.id)).toEqual(['b']);
    expect(filterUpdates(updates, { types: ['finding', 'status'] }).map((u) => u.id)).toEqual(['a', 'c']);
  });

  it('filters by phase', () => {
    expect(filterUpdates(updates, { phase: 'containment' }).map((u) => u.id)).toEqual(['b', 'c']);
  });

  it('searches body and author', () => {
    expect(filterUpdates(updates, { query: 'beaconing' }).map((u) => u.id)).toEqual(['a']);
    expect(filterUpdates(updates, { query: 'antwan' }).map((u) => u.id)).toEqual(['b']);
  });

  it('treats an empty type list as no filter', () => {
    expect(filterUpdates(updates, { types: [] })).toHaveLength(3);
  });

  it('combines filters', () => {
    expect(filterUpdates(updates, { types: ['status'], phase: 'containment' }).map((u) => u.id)).toEqual(['c']);
  });
});

// ── Edit history ────────────────────────────────────────────────────

describe('applyEdit', () => {
  const original = makeUpdate({ id: 'a', body: 'Initial assessment', createdAt: 1000, updatedAt: 1000 });

  it('keeps the superseded text so the record stays auditable', () => {
    const edited = applyEdit(original, 'Corrected assessment', { editedBy: 'Antwan', now: 2000 });
    expect(edited.body).toBe('Corrected assessment');
    expect(edited.updatedAt).toBe(2000);
    expect(edited.revisions).toEqual([{ body: 'Initial assessment', editedAt: 2000, editedBy: 'Antwan' }]);
    expect(isEdited(edited)).toBe(true);
  });

  it('accumulates revisions oldest first', () => {
    const first = applyEdit(original, 'Second', { now: 2000 });
    const second = applyEdit(first, 'Third', { now: 3000 });
    expect(second.revisions!.map((r) => r.body)).toEqual(['Initial assessment', 'Second']);
  });

  it('is a no-op when the body is unchanged, so history is not padded', () => {
    expect(applyEdit(original, 'Initial assessment', { now: 2000 })).toBe(original);
    expect(applyEdit(original, '  Initial assessment  ', { now: 2000 })).toBe(original);
  });

  it('refuses to blank an entry', () => {
    expect(applyEdit(original, '   ', { now: 2000 })).toBe(original);
  });

  it('reports an unedited entry as such', () => {
    expect(isEdited(original)).toBe(false);
  });
});

// ── Incident clock ──────────────────────────────────────────────────

describe('advancePhase', () => {
  it('stamps the milestone for the phase entered', () => {
    const folder = makeFolder({ id: 'f' });
    const patch = advancePhase(folder, 'containment', 5000);
    expect(patch.irPhase).toBe('containment');
    expect(patch.containedAt).toBe(5000);
  });

  it('backfills skipped milestones so the clock has no gaps', () => {
    const folder = makeFolder({ id: 'f' });
    const patch = advancePhase(folder, 'recovery', 5000);
    expect(patch.detectedAt).toBe(5000);
    expect(patch.containedAt).toBe(5000);
    expect(patch.eradicatedAt).toBe(5000);
    expect(patch.recoveredAt).toBe(5000);
  });

  it('never overwrites an existing stamp', () => {
    const folder = makeFolder({ id: 'f', detectedAt: 1000, containedAt: 2000 });
    const patch = advancePhase(folder, 'recovery', 5000);
    expect(patch.detectedAt).toBeUndefined();
    expect(patch.containedAt).toBeUndefined();
    expect(patch.recoveredAt).toBe(5000);
  });

  it('stamps nothing for phases with no milestone', () => {
    expect(advancePhase(makeFolder({ id: 'f' }), 'triage', 5000)).toEqual({ irPhase: 'triage' });
  });

  it('does not mutate the folder', () => {
    const folder = makeFolder({ id: 'f' });
    advancePhase(folder, 'recovery', 5000);
    expect(folder.detectedAt).toBeUndefined();
  });
});

describe('incidentDurations', () => {
  it('computes time to contain and recover from detection', () => {
    const folder = makeFolder({
      id: 'f', createdAt: 0,
      detectedAt: HOUR, containedAt: 3 * HOUR, recoveredAt: 9 * HOUR,
    });
    const d = incidentDurations(folder, 10 * HOUR);
    expect(d.timeToContain).toBe(2 * HOUR);
    expect(d.timeToRecover).toBe(8 * HOUR);
    expect(d.age).toBe(10 * HOUR);
  });

  it('leaves durations undefined until both ends are stamped', () => {
    const d = incidentDurations(makeFolder({ id: 'f', detectedAt: HOUR }), 5 * HOUR);
    expect(d.timeToContain).toBeUndefined();
    expect(d.timeToRecover).toBeUndefined();
  });

  it('freezes age at closure', () => {
    const folder = makeFolder({ id: 'f', createdAt: 0, closedAt: 4 * HOUR });
    expect(incidentDurations(folder, 100 * HOUR).age).toBe(4 * HOUR);
  });
});

// ── Triage ──────────────────────────────────────────────────────────

describe('severity and triage', () => {
  it('ranks most urgent first, untriaged last', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('low')).toBeLessThan(severityRank('none'));
    expect(severityRank(undefined)).toBe(severityRank('none'));
  });

  it('treats an untriaged case as not an incident', () => {
    expect(isIncident(makeFolder({ id: 'f' }))).toBe(false);
    expect(isIncident(makeFolder({ id: 'f', severity: 'none' }))).toBe(false);
    expect(isIncident(makeFolder({ id: 'f', severity: 'low' }))).toBe(true);
  });

  it('orders the queue by severity, then oldest first', () => {
    const queue = triageQueue([
      makeFolder({ id: 'newHigh', severity: 'high', createdAt: 200 }),
      makeFolder({ id: 'crit', severity: 'critical', createdAt: 300 }),
      makeFolder({ id: 'oldHigh', severity: 'high', createdAt: 100 }),
      makeFolder({ id: 'plain' }),
    ]);
    expect(queue.map((f) => f.id)).toEqual(['crit', 'oldHigh', 'newHigh']);
  });

  it('excludes closed and archived incidents', () => {
    const queue = triageQueue([
      makeFolder({ id: 'open', severity: 'high' }),
      makeFolder({ id: 'closed', severity: 'critical', status: 'closed' }),
      makeFolder({ id: 'archived', severity: 'critical', status: 'archived' }),
    ]);
    expect(queue.map((f) => f.id)).toEqual(['open']);
  });
});

// ── Import sanitization ─────────────────────────────────────────────

describe('sanitizeCaseUpdate', () => {
  it('accepts a well-formed update', () => {
    const result = sanitizeCaseUpdate({
      id: 'u1', folderId: 'f1', type: 'finding', body: 'text',
      phase: 'containment', authorName: 'Antwan', createdAt: 1000, updatedAt: 2000,
      revisions: [{ body: 'old', editedAt: 1500, editedBy: 'Antwan' }],
    });
    expect(result).toMatchObject({
      id: 'u1', type: 'finding', phase: 'containment', body: 'text',
    });
    expect(result!.revisions).toHaveLength(1);
  });

  it('drops an update with no investigation rather than importing an orphan', () => {
    expect(sanitizeCaseUpdate({ id: 'u1', body: 'x' })).toBeNull();
  });

  it('falls back to a safe type and drops an unknown phase', () => {
    const result = sanitizeCaseUpdate({ id: 'u1', folderId: 'f1', type: 'bogus', phase: 'bogus', body: 'x' });
    expect(result!.type).toBe('status');
    expect(result!.phase).toBeUndefined();
  });

  it('rejects non-objects', () => {
    expect(sanitizeCaseUpdate(null)).toBeNull();
    expect(sanitizeCaseUpdate('nope')).toBeNull();
  });

  it('discards malformed revision entries', () => {
    const result = sanitizeCaseUpdate({
      id: 'u1', folderId: 'f1', body: 'x', revisions: [null, 'bad', { body: 'ok', editedAt: 1 }],
    });
    expect(result!.revisions).toHaveLength(1);
  });
});
