import { useCallback, useEffect, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { db } from '../db';
import type { Asset, AssetOwnerType, OverridableAssetField } from '../types';
import { normalizeOwnership } from '../lib/asset-ownership';
import { setOverride, clearOverride, type SetOverrideOptions } from '../lib/asset-overrides';
import { purgeOldTrash } from '../lib/trash-purge';
import { parseAssetCSV, type AssetImportResult } from '../lib/asset-import';

/**
 * Manages the org-wide asset inventory (CMDB).
 *
 * Unlike Notes/Tasks/Evidence this is deliberately not folder-scoped: one
 * import serves every investigation. Use `linkedFolderIds` to record which
 * cases an asset has been correlated into.
 */
export function useAssets() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAssets = useCallback(async () => {
    try {
      const all = await db.assets.toArray();
      const remaining = await purgeOldTrash(all, db.assets);
      setAssets(remaining.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      console.error('Failed to load assets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const createAsset = useCallback(async (partial?: Partial<Asset>): Promise<Asset> => {
    const { getCurrentUserName } = await import('../lib/utils');
    const now = Date.now();
    const asset: Asset = {
      id: nanoid(),
      name: 'Untitled Asset',
      importedAt: now,
      tags: [],
      linkedFolderIds: [],
      trashed: false,
      archived: false,
      createdBy: partial?.createdBy || getCurrentUserName(),
      createdAt: now,
      updatedAt: now,
      ...partial,
    };
    await db.assets.add(asset);
    setAssets((prev) => [...prev, asset].sort((a, b) => a.name.localeCompare(b.name)));
    return asset;
  }, []);

  const updateAsset = useCallback(async (id: string, updates: Partial<Asset>) => {
    const patched = { ...updates, updatedAt: Date.now() };
    await db.assets.update(id, patched);
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, ...patched } : a)));
  }, []);

  const deleteAsset = useCallback(async (id: string) => {
    await db.assets.delete(id);
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const trashAsset = useCallback(async (id: string) => {
    await updateAsset(id, { trashed: true, trashedAt: Date.now() });
  }, [updateAsset]);

  const restoreAsset = useCallback(async (id: string) => {
    await updateAsset(id, { trashed: false, trashedAt: undefined });
  }, [updateAsset]);

  const emptyTrashAssets = useCallback(async () => {
    const trashedIds = assets.filter((a) => a.trashed).map((a) => a.id);
    if (trashedIds.length === 0) return;
    await db.assets.bulkDelete(trashedIds);
    setAssets((prev) => prev.filter((a) => !a.trashed));
  }, [assets]);

  /** Import a CMDB CSV export, upserting against the existing inventory. */
  const importAssetCSV = useCallback(async (
    text: string,
    opts: { source?: string; owner?: AssetOwnerType; customerName?: string } = {},
  ): Promise<AssetImportResult> => {
    const { getCurrentUserName } = await import('../lib/utils');
    const current = await db.assets.toArray();
    const result = parseAssetCSV(text, current, {
      source: opts.source,
      createdBy: getCurrentUserName(),
      owner: opts.owner,
      customerName: opts.customerName,
    });
    if (result.assets.length > 0) await db.assets.bulkPut(result.assets);
    await loadAssets();
    return result;
  }, [loadAssets]);

  /**
   * Correct a single asset field. Stored as an override rather than written
   * over the imported value, so a later CMDB re-import cannot destroy it.
   */
  const setAssetField = useCallback(async (
    assetId: string,
    field: OverridableAssetField,
    value: string | null,
    options: Omit<SetOverrideOptions, 'updatedBy'> = {},
  ) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return;
    const { getCurrentUserName } = await import('../lib/utils');
    const overrides = setOverride(asset, field, value, { ...options, updatedBy: getCurrentUserName() });
    await updateAsset(assetId, { overrides, updatedBy: getCurrentUserName() });
  }, [assets, updateAsset]);

  /** Drop a correction, reverting the field to its imported value. */
  const revertAssetField = useCallback(async (assetId: string, field: OverridableAssetField) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return;
    await updateAsset(assetId, { overrides: clearOverride(asset, field) });
  }, [assets, updateAsset]);

  /**
   * Assign ownership to many assets at once.
   *
   * Ownership is analyst-declared rather than imported, so it is written
   * directly rather than through the correction overlay — there is no CMDB
   * value underneath for it to be layered over.
   */
  const assignOwnership = useCallback(async (
    assetIds: string[],
    owner: AssetOwnerType,
    customerName?: string,
  ): Promise<number> => {
    if (assetIds.length === 0) return 0;
    const patch = { ...normalizeOwnership(owner, customerName), updatedAt: Date.now() };
    await db.transaction('rw', db.assets, async () => {
      for (const id of assetIds) await db.assets.update(id, patch);
    });
    setAssets((prev) => prev.map((a) => (assetIds.includes(a.id) ? { ...a, ...patch } : a)));
    return assetIds.length;
  }, []);

  /** Analyst commentary — never touched by an import, so stored directly. */
  const setAnalystNotes = useCallback(async (assetId: string, notes: string) => {
    await updateAsset(assetId, { analystNotes: notes.trim() || undefined });
  }, [updateAsset]);

  /** Record that an asset was correlated into an investigation. */
  const linkAssetToFolder = useCallback(async (assetId: string, folderId: string) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return;
    const linked = asset.linkedFolderIds ?? [];
    if (linked.includes(folderId)) return;
    await updateAsset(assetId, { linkedFolderIds: [...linked, folderId] });
  }, [assets, updateAsset]);

  const unlinkAssetFromFolder = useCallback(async (assetId: string, folderId: string) => {
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) return;
    const linked = asset.linkedFolderIds ?? [];
    if (!linked.includes(folderId)) return;
    await updateAsset(assetId, { linkedFolderIds: linked.filter((id) => id !== folderId) });
  }, [assets, updateAsset]);

  const activeAssets = useMemo(
    () => assets.filter((a) => !a.trashed && !a.archived),
    [assets],
  );

  const assetCounts = useMemo(() => ({
    total: activeAssets.length,
    trashed: assets.filter((a) => a.trashed).length,
    archived: assets.filter((a) => a.archived && !a.trashed).length,
  }), [assets, activeAssets]);

  return {
    assets,
    activeAssets,
    loading,
    createAsset,
    updateAsset,
    deleteAsset,
    trashAsset,
    restoreAsset,
    emptyTrashAssets,
    importAssetCSV,
    linkAssetToFolder,
    unlinkAssetFromFolder,
    setAssetField,
    revertAssetField,
    assignOwnership,
    setAnalystNotes,
    assetCounts,
    reload: loadAssets,
  };
}
