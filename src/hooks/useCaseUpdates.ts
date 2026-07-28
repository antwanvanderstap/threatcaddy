import { useCallback, useEffect, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { db } from '../db';
import type { CaseUpdate, CaseUpdateType, IncidentPhase } from '../types';
import { applyEdit, sortUpdates } from '../lib/case-updates';

/**
 * Case log for one investigation.
 *
 * Scoped by folderId rather than loading globally: a long-running incident can
 * accumulate hundreds of updates, and the composite [folderId+createdAt] index
 * makes the scoped read cheap.
 */
export function useCaseUpdates(folderId?: string) {
  const [updates, setUpdates] = useState<CaseUpdate[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!folderId) {
      setUpdates([]);
      setLoading(false);
      return;
    }
    try {
      const rows = await db.caseUpdates.where('folderId').equals(folderId).toArray();
      setUpdates(sortUpdates(rows));
    } catch (err) {
      console.error('Failed to load case updates:', err);
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => { load(); }, [load]);

  const addUpdate = useCallback(async (input: {
    type: CaseUpdateType;
    body: string;
    phase?: IncidentPhase;
  }): Promise<CaseUpdate | undefined> => {
    if (!folderId) return undefined;
    const body = input.body.trim();
    if (!body) return undefined;

    const { getCurrentUserName } = await import('../lib/utils');
    const now = Date.now();
    const author = getCurrentUserName();
    const update: CaseUpdate = {
      id: nanoid(),
      folderId,
      type: input.type,
      body,
      phase: input.phase,
      authorName: author,
      createdBy: author,
      createdAt: now,
      updatedAt: now,
    };
    await db.caseUpdates.add(update);
    setUpdates((prev) => [update, ...prev]);
    return update;
  }, [folderId]);

  /** Edit an entry, keeping the superseded text in its revision history. */
  const editUpdate = useCallback(async (id: string, body: string) => {
    const existing = await db.caseUpdates.get(id);
    if (!existing) return;
    const { getCurrentUserName } = await import('../lib/utils');
    const next = applyEdit(existing, body, { editedBy: getCurrentUserName() });
    if (next === existing) return;
    await db.caseUpdates.put(next);
    setUpdates((prev) => prev.map((u) => (u.id === id ? next : u)));
  }, []);

  const deleteUpdate = useCallback(async (id: string) => {
    await db.caseUpdates.delete(id);
    setUpdates((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const countsByType = useMemo(() => {
    const counts: Partial<Record<CaseUpdateType, number>> = {};
    for (const update of updates) counts[update.type] = (counts[update.type] ?? 0) + 1;
    return counts;
  }, [updates]);

  return {
    updates,
    loading,
    addUpdate,
    editUpdate,
    deleteUpdate,
    countsByType,
    reload: load,
  };
}
