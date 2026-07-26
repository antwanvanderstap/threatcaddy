import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Papa from 'papaparse';
import {
  AlertTriangle,
  CheckCircle2,
  Crosshair,
  HardDrive,
  Link2,
  Loader2,
  Network,
  Search,
  Server,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Asset, AssetCorrelation, AssetCorrelationReport } from '../../types';
import { cn, formatDate } from '../../lib/utils';
import { correlateEventRows, formatMac, normalizeMac } from '../../lib/asset-correlation';
import type { AssetImportResult } from '../../lib/asset-import';

interface AssetViewProps {
  assets: Asset[];
  folderId?: string;
  folderName?: string;
  onImportCSV: (text: string, opts: { source?: string }) => Promise<AssetImportResult>;
  onTrashAsset: (id: string) => Promise<void>;
  onLinkAssetToFolder?: (assetId: string, folderId: string) => Promise<void>;
  onOpenChat: () => void;
}

type Tab = 'inventory' | 'correlate';

const TIER_STYLES = {
  exact: {
    icon: CheckCircle2,
    chip: 'bg-accent-green/15 text-accent-green border-accent-green/30',
    dot: 'bg-accent-green',
  },
  subnet: {
    icon: Network,
    chip: 'bg-accent-amber/15 text-accent-amber border-accent-amber/30',
    dot: 'bg-accent-amber',
  },
  gap: {
    icon: AlertTriangle,
    chip: 'bg-accent-red/15 text-accent-red border-accent-red/30',
    dot: 'bg-accent-red',
  },
} as const;

export function AssetView({
  assets,
  folderId,
  folderName,
  onImportCSV,
  onTrashAsset,
  onLinkAssetToFolder,
  onOpenChat,
}: AssetViewProps) {
  const { t } = useTranslation('assets');
  const [tab, setTab] = useState<Tab>('inventory');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [importError, setImportError] = useState('');

  const [eventFileName, setEventFileName] = useState('');
  const [report, setReport] = useState<AssetCorrelationReport | null>(null);
  const [correlating, setCorrelating] = useState(false);
  const [correlationError, setCorrelationError] = useState('');

  const cmdbInputRef = useRef<HTMLInputElement>(null);
  const eventInputRef = useRef<HTMLInputElement>(null);

  const activeAssets = useMemo(
    () => assets.filter((a) => !a.trashed && !a.archived),
    [assets],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return activeAssets;
    return activeAssets.filter((a) => [
      a.name, a.hostname, a.primaryIp, a.macAddress, a.serialNumber,
      a.assetTag, a.assetType, a.operatingSystem, a.location, a.contactName, a.model,
    ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [activeAssets, query]);

  const selected = useMemo(
    () => activeAssets.find((a) => a.id === selectedId) ?? null,
    [activeAssets, selectedId],
  );

  const stats = useMemo(() => ({
    total: activeAssets.length,
    servers: activeAssets.filter((a) => /server/i.test(a.assetType ?? '')).length,
    workstations: activeAssets.filter((a) => /workstation|endpoint|laptop/i.test(a.assetType ?? '')).length,
    withIp: activeAssets.filter((a) => a.primaryIp).length,
  }), [activeAssets]);

  // ── Import ────────────────────────────────────────────────────────

  const handleCMDBFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    setImportError('');
    setImportMessage('');
    try {
      const text = await file.text();
      const result = await onImportCSV(text, { source: file.name });
      if (result.errors.length > 0) setImportError(result.errors.join(' · '));
      setImportMessage(t('import.result', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
      }));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [onImportCSV, t]);

  // ── Correlate ─────────────────────────────────────────────────────

  const handleEventFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setCorrelating(true);
    setCorrelationError('');
    setReport(null);
    try {
      const text = await file.text();
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim(),
      });
      const rows = parsed.data ?? [];
      if (rows.length === 0) {
        setCorrelationError(t('correlate.noRows'));
        return;
      }
      setEventFileName(file.name);
      setReport(correlateEventRows(rows, activeAssets));
    } catch (err) {
      setCorrelationError(err instanceof Error ? err.message : String(err));
    } finally {
      setCorrelating(false);
    }
  }, [activeAssets, t]);

  const assetById = useMemo(
    () => new Map(activeAssets.map((a) => [a.id, a])),
    [activeAssets],
  );

  const openAsset = useCallback((id: string) => {
    setSelectedId(id);
    setTab('inventory');
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <input
        ref={cmdbInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleCMDBFile}
      />
      <input
        ref={eventInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleEventFile}
      />

      {/* Header */}
      <div className="shrink-0 border-b border-border-subtle px-4 py-3 flex items-center gap-3 flex-wrap">
        <HardDrive size={18} className="text-accent-blue shrink-0" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">{t('header.title')}</h1>
          <p className="text-xs text-text-muted truncate">
            {folderName ? t('header.scopeInvestigation', { name: folderName }) : t('header.scopeGlobal')}
          </p>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => cmdbInputRef.current?.click()}
            disabled={importing}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover disabled:opacity-50"
          >
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {importing ? t('import.importing') : t('import.button')}
          </button>
          <button
            type="button"
            onClick={onOpenChat}
            className="px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover"
          >
            {t('actions.caddyAI')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="shrink-0 border-b border-border-subtle px-4 flex items-center gap-1">
        {(['inventory', 'correlate'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              'px-3 py-2 text-xs border-b-2 -mb-px transition-colors',
              tab === value
                ? 'border-accent-blue text-text-primary font-medium'
                : 'border-transparent text-text-muted hover:text-text-primary',
            )}
          >
            {value === 'inventory'
              ? t('tabs.inventory', { count: stats.total })
              : t('tabs.correlate')}
          </button>
        ))}
      </div>

      {(importMessage || importError) && (
        <div className="shrink-0 px-4 py-2 text-xs flex items-center gap-2 border-b border-border-subtle">
          {importError
            ? <span className="text-accent-red">{importError}</span>
            : <span className="text-accent-green">{importMessage}</span>}
          <button
            type="button"
            onClick={() => { setImportMessage(''); setImportError(''); }}
            className="ml-auto text-text-muted hover:text-text-primary"
            aria-label={t('actions.dismiss')}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {tab === 'inventory' ? (
        <InventoryTab
          assets={filtered}
          totalCount={activeAssets.length}
          stats={stats}
          query={query}
          onQueryChange={setQuery}
          selected={selected}
          onSelect={setSelectedId}
          onTrash={onTrashAsset}
          onImportClick={() => cmdbInputRef.current?.click()}
          folderId={folderId}
          onLinkToFolder={onLinkAssetToFolder}
          t={t}
        />
      ) : (
        <CorrelateTab
          report={report}
          eventFileName={eventFileName}
          correlating={correlating}
          error={correlationError}
          inventoryEmpty={activeAssets.length === 0}
          assetById={assetById}
          onPickFile={() => eventInputRef.current?.click()}
          onOpenAsset={openAsset}
          t={t}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface InventoryTabProps {
  assets: Asset[];
  totalCount: number;
  stats: { total: number; servers: number; workstations: number; withIp: number };
  query: string;
  onQueryChange: (value: string) => void;
  selected: Asset | null;
  onSelect: (id: string) => void;
  onTrash: (id: string) => Promise<void>;
  onImportClick: () => void;
  folderId?: string;
  onLinkToFolder?: (assetId: string, folderId: string) => Promise<void>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function InventoryTab({
  assets, totalCount, stats, query, onQueryChange,
  selected, onSelect, onTrash, onImportClick, folderId, onLinkToFolder, t,
}: InventoryTabProps) {
  if (totalCount === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
        <HardDrive size={32} className="text-text-muted" />
        <div>
          <p className="text-sm font-medium">{t('empty.noAssets')}</p>
          <p className="text-xs text-text-muted mt-1 max-w-md">{t('empty.noAssetsDesc')}</p>
        </div>
        <button
          type="button"
          onClick={onImportClick}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent-blue text-white hover:opacity-90"
        >
          <Upload size={13} />
          {t('import.button')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Stat strip + search */}
        <div className="shrink-0 px-4 py-2 border-b border-border-subtle flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span><strong className="text-text-primary">{stats.total}</strong> {t('stats.total')}</span>
            <span><strong className="text-text-primary">{stats.servers}</strong> {t('stats.servers')}</span>
            <span><strong className="text-text-primary">{stats.workstations}</strong> {t('stats.workstations')}</span>
            <span><strong className="text-text-primary">{stats.withIp}</strong> {t('stats.withIp')}</span>
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              className="pl-7 pr-2 py-1 text-xs rounded border border-border-subtle bg-bg-input w-56"
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {assets.length === 0 ? (
            <p className="text-xs text-text-muted p-4">{t('search.noResults')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-secondary border-b border-border-subtle">
                <tr className="text-left text-text-muted">
                  <th className="px-3 py-2 font-medium">{t('table.name')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.type')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.ip')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.mac')}</th>
                  <th className="px-3 py-2 font-medium">{t('table.status')}</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr
                    key={asset.id}
                    onClick={() => onSelect(asset.id)}
                    className={cn(
                      'border-b border-border-subtle cursor-pointer hover:bg-bg-hover',
                      selected?.id === asset.id && 'bg-bg-hover',
                    )}
                  >
                    <td className="px-3 py-1.5 font-medium truncate max-w-[16rem]">{asset.name}</td>
                    <td className="px-3 py-1.5 text-text-muted truncate max-w-[12rem]">{asset.assetType ?? '—'}</td>
                    <td className="px-3 py-1.5 font-mono">{asset.primaryIp ?? '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-text-muted">
                      {asset.macAddress ? formatMac(normalizeMac(asset.macAddress) ?? asset.macAddress) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-text-muted">{asset.status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <aside className="w-80 shrink-0 border-l border-border-subtle overflow-auto">
          <div className="p-3 border-b border-border-subtle flex items-start gap-2">
            <Server size={15} className="text-accent-blue mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{selected.name}</p>
              <p className="text-xs text-text-muted">{selected.assetType ?? t('detail.unknownType')}</p>
            </div>
          </div>

          <dl className="p-3 space-y-2 text-xs">
            <DetailRow label={t('table.status')} value={selected.status} />
            <DetailRow label={t('detail.hostname')} value={selected.hostname} />
            <DetailRow label={t('table.ip')} value={selected.primaryIp} mono />
            <DetailRow
              label={t('table.mac')}
              value={selected.macAddress ? formatMac(normalizeMac(selected.macAddress) ?? selected.macAddress) : undefined}
              mono
            />
            <DetailRow label={t('detail.serial')} value={selected.serialNumber} mono />
            <DetailRow label={t('detail.assetTag')} value={selected.assetTag} mono />
            <DetailRow label={t('detail.os')} value={selected.operatingSystem} />
            <DetailRow label={t('detail.manufacturer')} value={selected.manufacturer} />
            <DetailRow label={t('detail.model')} value={selected.model} />
            <DetailRow label={t('detail.location')} value={selected.location} />
            <DetailRow label={t('detail.contact')} value={selected.contactName} />
            <DetailRow
              label={t('detail.warranty')}
              value={selected.warrantyExpiresAt ? formatDate(selected.warrantyExpiresAt) : undefined}
            />
            <DetailRow label={t('detail.source')} value={selected.source} />
            <DetailRow label={t('detail.imported')} value={formatDate(selected.importedAt)} />
          </dl>

          {selected.notes && (
            <div className="px-3 pb-3">
              <p className="text-xs text-text-muted mb-1">{t('detail.notes')}</p>
              <p className="text-xs whitespace-pre-wrap break-words bg-bg-secondary rounded p-2">{selected.notes}</p>
            </div>
          )}

          <div className="p-3 border-t border-border-subtle flex items-center gap-1.5">
            {folderId && onLinkToFolder && (
              <button
                type="button"
                onClick={() => onLinkToFolder(selected.id, folderId)}
                disabled={selected.linkedFolderIds?.includes(folderId)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover disabled:opacity-50"
              >
                <Link2 size={13} />
                {selected.linkedFolderIds?.includes(folderId)
                  ? t('detail.linked')
                  : t('detail.linkToCase')}
              </button>
            )}
            <button
              type="button"
              onClick={() => onTrash(selected.id)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover text-accent-red ml-auto"
            >
              <Trash2 size={13} />
              {t('detail.trash')}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="text-text-muted shrink-0 w-24">{label}</dt>
      <dd className={cn('min-w-0 break-words', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Correlate
// ---------------------------------------------------------------------------

interface CorrelateTabProps {
  report: AssetCorrelationReport | null;
  eventFileName: string;
  correlating: boolean;
  error: string;
  inventoryEmpty: boolean;
  assetById: Map<string, Asset>;
  onPickFile: () => void;
  onOpenAsset: (id: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function CorrelateTab({
  report, eventFileName, correlating, error, inventoryEmpty,
  assetById, onPickFile, onOpenAsset, t,
}: CorrelateTabProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="p-4 space-y-4">
        {/* Control bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={onPickFile}
            disabled={correlating || inventoryEmpty}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
          >
            {correlating ? <Loader2 size={13} className="animate-spin" /> : <Crosshair size={13} />}
            {t('correlate.importEvent')}
          </button>
          {eventFileName && (
            <span className="text-xs text-text-muted truncate">{eventFileName}</span>
          )}
        </div>

        {inventoryEmpty && (
          <p className="text-xs text-accent-amber">{t('correlate.needInventory')}</p>
        )}
        {error && <p className="text-xs text-accent-red">{error}</p>}

        {!report && !inventoryEmpty && !error && (
          <div className="text-xs text-text-muted space-y-2 max-w-2xl">
            <p>{t('correlate.intro')}</p>
            <ul className="space-y-1 pl-1">
              <li className="flex gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green mt-1.5 shrink-0" />
                <span>{t('correlate.legendExact')}</span>
              </li>
              <li className="flex gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-amber mt-1.5 shrink-0" />
                <span>{t('correlate.legendSubnet')}</span>
              </li>
              <li className="flex gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-red mt-1.5 shrink-0" />
                <span>{t('correlate.legendGap')}</span>
              </li>
            </ul>
          </div>
        )}

        {report && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <TierChip tier="exact" count={report.exactCount} label={t('correlate.tierExact')} />
              <TierChip tier="subnet" count={report.subnetCount} label={t('correlate.tierSubnet')} />
              <TierChip tier="gap" count={report.gapCount} label={t('correlate.tierGap')} />
            </div>

            {report.correlations.length === 0 ? (
              <p className="text-xs text-text-muted">{t('correlate.noObservables')}</p>
            ) : (
              <div className="space-y-2">
                {report.correlations.map((correlation, i) => (
                  <CorrelationCard
                    key={`${correlation.observable.kind}-${correlation.observable.value}-${i}`}
                    correlation={correlation}
                    assetById={assetById}
                    onOpenAsset={onOpenAsset}
                    t={t}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TierChip({ tier, count, label }: { tier: keyof typeof TIER_STYLES; count: number; label: string }) {
  const style = TIER_STYLES[tier];
  const Icon = style.icon;
  return (
    <span className={cn('flex items-center gap-1.5 px-2 py-1 text-xs rounded border', style.chip)}>
      <Icon size={12} />
      <strong>{count}</strong>
      {label}
    </span>
  );
}

function CorrelationCard({
  correlation, assetById, onOpenAsset, t,
}: {
  correlation: AssetCorrelation;
  assetById: Map<string, Asset>;
  onOpenAsset: (id: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const style = TIER_STYLES[correlation.tier];
  return (
    <div className="border border-border-subtle rounded p-3">
      <div className="flex items-start gap-2">
        <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', style.dot)} />
        <div className="min-w-0 flex-1">
          <p className="text-xs">
            <span className="text-text-muted">{correlation.observable.label}</span>
            <span className="mx-1.5 text-text-muted">·</span>
            <span className="font-mono font-medium break-all">{correlation.observable.value}</span>
          </p>
          <p className="text-xs text-text-muted mt-1 break-words">{correlation.rationale}</p>

          {correlation.assetIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {correlation.assetIds.map((id) => {
                const asset = assetById.get(id);
                if (!asset) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onOpenAsset(id)}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border-subtle hover:bg-bg-hover"
                    title={t('correlate.openAsset')}
                  >
                    <Server size={11} />
                    {asset.name}
                    {asset.primaryIp && <span className="font-mono text-text-muted">{asset.primaryIp}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
