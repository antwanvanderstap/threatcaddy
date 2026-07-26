import { useCallback, useEffect, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { db } from '../db';
import type { Asset } from '../types';
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
    opts: { source?: string } = {},
  ): Promise<AssetImportResult> => {
    const { getCurrentUserName } = await import('../lib/utils');
    const current = await db.assets.toArray();
    const result = parseAssetCSV(text, current, {
      source: opts.source,
      createdBy: getCurrentUserName(),
    });
    if (result.assets.length > 0) await db.assets.bulkPut(result.assets);
    await loadAssets();
    return result;
  }, [loadAssets]);

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
    assetCounts,
    reload: loadAssets,
  };
}
