import { useEffect, useMemo, useState } from 'react';
import { Check, History, Link2, PencilLine, RotateCcw, Server, Trash2, X } from 'lucide-react';
import type { Asset, OverridableAssetField } from '../../types';
import { cn, formatDate } from '../../lib/utils';
import { formatMac, normalizeMac } from '../../lib/asset-correlation';
import {
  OVERRIDABLE_ASSET_FIELDS,
  MATCH_AFFECTING_FIELDS,
  resolveAsset,
  originalValue,
  overriddenFields,
} from '../../lib/asset-overrides';

interface AssetDetailPanelProps {
  asset: Asset;
  folderId?: string;
  onSetField: (field: OverridableAssetField, value: string | null, reason?: string) => Promise<void>;
  onRevertField: (field: OverridableAssetField) => Promise<void>;
  onSetAnalystNotes: (notes: string) => Promise<void>;
  onTrash: () => Promise<void>;
  onLinkToFolder?: () => Promise<void>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/** Fields rendered as a wide textarea rather than a single-line input. */
const MULTILINE_FIELDS: readonly OverridableAssetField[] = ['notes', 'osNotes'];

/** Read-only rows, shown after the editable ones. */
const READONLY_ROWS: { key: keyof Asset; labelKey: string; format?: (v: unknown) => string }[] = [
  { key: 'warrantyExpiresAt', labelKey: 'detail.warranty', format: (v) => formatDate(v as number) },
  { key: 'source', labelKey: 'detail.source' },
  { key: 'importedAt', labelKey: 'detail.imported', format: (v) => formatDate(v as number) },
];

export function AssetDetailPanel({
  asset, folderId, onSetField, onRevertField, onSetAnalystNotes, onTrash, onLinkToFolder, t,
}: AssetDetailPanelProps) {
  const [editing, setEditing] = useState(false);
  const resolved = useMemo(() => resolveAsset(asset), [asset]);
  const corrected = useMemo(() => overriddenFields(asset), [asset]);

  // Leaving edit mode when the selection changes avoids carrying a half-typed
  // correction over to a different asset.
  useEffect(() => { setEditing(false); }, [asset.id]);

  const [analystNotes, setAnalystNotes] = useState(asset.analystNotes ?? '');
  useEffect(() => { setAnalystNotes(asset.analystNotes ?? ''); }, [asset.id, asset.analystNotes]);

  return (
    <aside className="w-96 shrink-0 border-l border-border-subtle overflow-auto">
      <div className="p-3 border-b border-border-subtle flex items-start gap-2">
        <Server size={15} className="text-accent-blue mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{resolved.name}</p>
          <p className="text-xs text-text-muted">{resolved.assetType ?? t('detail.unknownType')}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-xs rounded border shrink-0',
            editing
              ? 'border-accent-blue text-accent-blue'
              : 'border-border-subtle hover:bg-bg-hover',
          )}
        >
          {editing ? <Check size={12} /> : <PencilLine size={12} />}
          {editing ? t('detail.done') : t('detail.edit')}
        </button>
      </div>

      {corrected.length > 0 && (
        <div className="px-3 py-2 border-b border-border-subtle flex items-start gap-1.5 text-xs text-accent-blue">
          <History size={12} className="mt-0.5 shrink-0" />
          <span>{t('detail.correctedCount', { count: corrected.length })}</span>
        </div>
      )}

      <dl className="p-3 space-y-2 text-xs">
        {OVERRIDABLE_ASSET_FIELDS.map((field) => (
          <FieldRow
            key={field}
            field={field}
            asset={asset}
            resolved={resolved}
            editing={editing}
            onSetField={onSetField}
            onRevertField={onRevertField}
            t={t}
          />
        ))}

        {READONLY_ROWS.map(({ key, labelKey, format }) => {
          const value = resolved[key];
          if (value == null || value === '') return null;
          return (
            <div key={String(key)} className="flex gap-2">
              <dt className="text-text-muted shrink-0 w-28">{t(labelKey)}</dt>
              <dd className="min-w-0 break-words">{format ? format(value) : String(value)}</dd>
            </div>
          );
        })}
      </dl>

      {/* Analyst notes — always analyst-owned, never overwritten by an import */}
      <div className="px-3 pb-3 space-y-1">
        <label className="text-xs text-text-muted" htmlFor="asset-analyst-notes">
          {t('detail.analystNotes')}
        </label>
        <textarea
          id="asset-analyst-notes"
          value={analystNotes}
          onChange={(e) => setAnalystNotes(e.target.value)}
          onBlur={() => {
            if (analystNotes !== (asset.analystNotes ?? '')) onSetAnalystNotes(analystNotes);
          }}
          rows={3}
          placeholder={t('detail.analystNotesPlaceholder')}
          className="w-full text-xs rounded border border-border-subtle bg-bg-input p-2 resize-y"
        />
      </div>

      <div className="p-3 border-t border-border-subtle flex items-center gap-1.5">
        {folderId && onLinkToFolder && (
          <button
            type="button"
            onClick={onLinkToFolder}
            disabled={asset.linkedFolderIds?.includes(folderId)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover disabled:opacity-50"
          >
            <Link2 size={13} />
            {asset.linkedFolderIds?.includes(folderId) ? t('detail.linked') : t('detail.linkToCase')}
          </button>
        )}
        <button
          type="button"
          onClick={onTrash}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover text-accent-red ml-auto"
        >
          <Trash2 size={13} />
          {t('detail.trash')}
        </button>
      </div>
    </aside>
  );
}

function FieldRow({
  field, asset, resolved, editing, onSetField, onRevertField, t,
}: {
  field: OverridableAssetField;
  asset: Asset;
  resolved: Asset;
  editing: boolean;
  onSetField: (field: OverridableAssetField, value: string | null, reason?: string) => Promise<void>;
  onRevertField: (field: OverridableAssetField) => Promise<void>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const override = asset.overrides?.[field];
  const imported = originalValue(asset, field);
  const displayRaw = resolved[field] as string | undefined;

  // MACs are stored as imported but shown in a single canonical form.
  const display = field === 'macAddress' && displayRaw
    ? formatMac(normalizeMac(displayRaw) ?? displayRaw)
    : displayRaw;

  const [draft, setDraft] = useState(displayRaw ?? '');
  useEffect(() => { setDraft(displayRaw ?? ''); }, [displayRaw, editing]);

  const label = t(`field.${field}`);
  const affectsMatching = MATCH_AFFECTING_FIELDS.includes(field);

  if (!editing) {
    if (!display) return null;
    return (
      <div className="flex gap-2">
        <dt className="text-text-muted shrink-0 w-28">{label}</dt>
        <dd className="min-w-0 break-words flex-1">
          <span className={cn(field === 'macAddress' || field === 'primaryIp' ? 'font-mono' : undefined)}>
            {display}
          </span>
          {override && (
            <span
              className="ml-1.5 text-accent-blue"
              title={t('detail.correctedTitle', {
                original: imported ?? t('detail.wasEmpty'),
                by: override.updatedBy ?? '—',
                when: formatDate(override.updatedAt),
              })}
            >
              ●
            </span>
          )}
        </dd>
      </div>
    );
  }

  const commit = () => {
    if (draft === (displayRaw ?? '')) return;
    onSetField(field, draft);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label className="text-text-muted w-28 shrink-0" htmlFor={`asset-field-${field}`}>
          {label}
        </label>
        {override && (
          <button
            type="button"
            onClick={() => onRevertField(field)}
            className="flex items-center gap-1 text-accent-blue hover:underline"
            title={t('detail.revertTitle', { value: imported ?? t('detail.wasEmpty') })}
          >
            <RotateCcw size={10} />
            {t('detail.revert')}
          </button>
        )}
        {affectsMatching && (
          <span className="text-text-muted" title={t('detail.affectsMatching')}>⁂</span>
        )}
      </div>
      {MULTILINE_FIELDS.includes(field) ? (
        <textarea
          id={`asset-field-${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          rows={2}
          className="w-full text-xs rounded border border-border-subtle bg-bg-input p-1.5 resize-y"
        />
      ) : (
        <input
          id={`asset-field-${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') setDraft(displayRaw ?? '');
          }}
          className={cn(
            'w-full text-xs rounded border bg-bg-input px-1.5 py-1',
            override ? 'border-accent-blue/50' : 'border-border-subtle',
          )}
        />
      )}
      {override && imported !== undefined && imported !== draft && (
        <p className="text-text-muted flex items-center gap-1">
          <X size={9} />
          {t('detail.importedWas', { value: imported })}
        </p>
      )}
    </div>
  );
}
