import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText, CheckSquare, Search, Clock, Layout, MessageSquare,
  Download, CloudOff, MoreVertical, Settings, Archive, Trash2, Loader2,
  ChevronUp, ChevronDown,
} from 'lucide-react';
import type { InvestigationDataMode, IncidentSeverity, IncidentPhase } from '../../types';
import { severityRank } from '../../lib/case-updates';
import { formatDate, cn } from '../../lib/utils';

export interface InvestigationEntityCounts {
  notes: number;
  tasks: number;
  iocs: number;
  events: number;
  whiteboards: number;
  chats: number;
}

export interface InvestigationRow {
  folderId: string;
  name: string;
  status: 'active' | 'closed' | 'archived';
  color?: string;
  icon?: string;
  description?: string;
  clsLevel?: string;
  severity?: IncidentSeverity;
  irPhase?: IncidentPhase;
  entityCounts: InvestigationEntityCounts;
  memberCount?: number;
  role?: 'owner' | 'editor' | 'viewer';
  dataMode: InvestigationDataMode;
  updatedAt?: string | number;
}

export interface InvestigationTableProps {
  rows: InvestigationRow[];
  loading?: boolean;
  skeletonRows?: number;
  onOpen: (folderId: string, mode: InvestigationDataMode) => void;
  onSync?: (folderId: string) => void;
  onUnsync?: (folderId: string) => void;
  onSettings?: (folderId: string) => void;
  onArchive?: (folderId: string) => void;
  onUnarchive?: (folderId: string) => void;
  onDelete?: (folderId: string) => void;
  syncingFolderId?: string | null;
}

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  active:   { dot: 'bg-accent-green', text: 'text-accent-green' },
  closed:   { dot: 'bg-text-muted',   text: 'text-text-muted' },
  archived: { dot: 'bg-accent-amber', text: 'text-accent-amber' },
};

const STATUS_ORDER: Record<string, number> = { active: 0, closed: 1, archived: 2 };

const SEVERITY_CLASSES: Record<IncidentSeverity, string> = {
  critical: 'bg-red-600/20 text-red-400',
  high:     'bg-orange-600/20 text-orange-400',
  medium:   'bg-yellow-600/20 text-yellow-400',
  low:      'bg-blue-600/20 text-blue-400',
  none:     '',
};

const DATA_MODE_CLASSES: Record<InvestigationDataMode, string> = {
  local:  'bg-blue-500/15 text-blue-400',
  synced: 'bg-green-500/15 text-green-400',
  remote: 'bg-amber-500/15 text-amber-400',
};

const ENTITY_STATS = [
  { key: 'notes'       as const, labelKey: 'card.entity.notes',       icon: FileText,      color: 'text-accent-blue' },
  { key: 'tasks'       as const, labelKey: 'card.entity.tasks',       icon: CheckSquare,   color: 'text-accent-amber' },
  { key: 'iocs'        as const, labelKey: 'card.entity.iocs',        icon: Search,        color: 'text-accent-green' },
  { key: 'events'      as const, labelKey: 'card.entity.events',      icon: Clock,         color: 'text-purple' },
  { key: 'whiteboards' as const, labelKey: 'card.entity.whiteboards', icon: Layout,        color: 'text-accent-pink' },
  { key: 'chats'       as const, labelKey: 'card.entity.chats',       icon: MessageSquare, color: 'text-purple' },
];

type SortKey = 'name' | 'severity' | 'status' | 'updated';
type SortDir = 'asc' | 'desc';

function toMillis(v: string | number | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : new Date(v).getTime() || 0;
}

function compareRows(a: InvestigationRow, b: InvestigationRow, key: SortKey): number {
  switch (key) {
    case 'name': return a.name.localeCompare(b.name);
    case 'severity': return severityRank(a.severity) - severityRank(b.severity);
    case 'status': return (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
    case 'updated': return toMillis(a.updatedAt) - toMillis(b.updatedAt);
  }
}

function SortHeader({
  k, label, className, sortKey, sortDir, onSort,
}: {
  k: SortKey;
  label: string;
  className?: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const activeSort = sortKey === k;
  const Icon = sortDir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th
      scope="col"
      aria-sort={activeSort ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-3 py-2 font-semibold', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn('inline-flex items-center gap-0.5 uppercase tracking-wider hover:text-text-secondary', activeSort && 'text-text-secondary')}
      >
        {label}
        {activeSort && <Icon size={11} />}
      </button>
    </th>
  );
}

function RowMenu({
  row,
  onSettings,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  row: InvestigationRow;
  onSettings?: (folderId: string) => void;
  onArchive?: (folderId: string) => void;
  onUnarchive?: (folderId: string) => void;
  onDelete?: (folderId: string) => void;
}) {
  const { t } = useTranslation('investigations');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen, closeMenu]);

  const { folderId, status, dataMode } = row;
  const isLocalOrSynced = dataMode === 'local' || dataMode === 'synced';
  if (!isLocalOrSynced && !onSettings) return null;

  const handleMenuItemClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
    closeMenu();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        className="p-1 rounded hover:bg-bg-deep transition-colors text-text-muted hover:text-text-secondary"
        title={t('card.actions')}
        aria-label={t('card.actions')}
      >
        <MoreVertical size={14} />
      </button>
      {menuOpen && (
        <div className="absolute end-0 top-full mt-1 z-50 w-40 rounded-lg border border-border-subtle bg-bg-raised shadow-xl py-1 text-start">
          {onSettings && (
            <button
              onClick={(e) => handleMenuItemClick(e, () => onSettings(folderId))}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-deep hover:text-text-primary transition-colors"
            >
              <Settings size={12} />
              {t('card.settings')}
            </button>
          )}
          {isLocalOrSynced && status !== 'archived' && onArchive && (
            <button
              onClick={(e) => handleMenuItemClick(e, () => onArchive(folderId))}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-deep hover:text-text-primary transition-colors"
            >
              <Archive size={12} />
              {t('card.archive')}
            </button>
          )}
          {isLocalOrSynced && status === 'archived' && onUnarchive && (
            <button
              onClick={(e) => handleMenuItemClick(e, () => onUnarchive(folderId))}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-deep hover:text-text-primary transition-colors"
            >
              <Archive size={12} />
              {t('card.unarchive')}
            </button>
          )}
          {isLocalOrSynced && onDelete && (
            <button
              onClick={(e) => handleMenuItemClick(e, () => onDelete(folderId))}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={12} />
              {t('card.delete')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function InvestigationTable({
  rows,
  loading,
  skeletonRows = 2,
  onOpen,
  onSync,
  onUnsync,
  onSettings,
  onArchive,
  onUnarchive,
  onDelete,
  syncingFolderId,
}: InvestigationTableProps) {
  const { t } = useTranslation('investigations');
  const { t: tIncident } = useTranslation('incident');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => compareRows(a, b, sortKey) * dir || a.name.localeCompare(b.name));
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Newest first for dates; most urgent first for severity; A→Z otherwise
      setSortDir(key === 'updated' ? 'desc' : 'asc');
    }
  };

  const sortProps = { sortKey, sortDir, onSort: toggleSort };

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-raised">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] text-text-muted text-start border-b border-border-subtle">
            <SortHeader {...sortProps} k="name" label={t('table.name')} className="text-start" />
            <SortHeader {...sortProps} k="severity" label={tIncident('severity.label')} className="text-start hidden md:table-cell" />
            <th scope="col" className="px-3 py-2 font-semibold uppercase tracking-wider text-start hidden lg:table-cell">{tIncident('phase.label')}</th>
            <SortHeader {...sortProps} k="status" label={t('table.status')} className="text-start" />
            <th scope="col" className="px-3 py-2 font-semibold uppercase tracking-wider text-start hidden md:table-cell">{t('table.mode')}</th>
            <th scope="col" className="px-3 py-2 font-semibold uppercase tracking-wider text-start hidden xl:table-cell">{t('table.contents')}</th>
            <SortHeader {...sortProps} k="updated" label={t('table.updated')} className="text-end hidden sm:table-cell" />
            <th scope="col" className="px-3 py-2"><span className="sr-only">{t('card.actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-b border-border-subtle last:border-0 animate-pulse">
                  <td className="px-3 py-3" colSpan={8}>
                    <div className="h-4 bg-bg-deep rounded w-1/3" />
                  </td>
                </tr>
              ))
            : sorted.map((row) => {
                const sty = STATUS_STYLES[row.status] ?? STATUS_STYLES.active;
                const severity = row.severity && row.severity !== 'none' ? row.severity : undefined;
                const syncing = syncingFolderId === row.folderId;
                return (
                  <tr
                    key={row.folderId}
                    onClick={() => onOpen(row.folderId, row.dataMode)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onOpen(row.folderId, row.dataMode);
                      }
                    }}
                    tabIndex={0}
                    className="border-b border-border-subtle last:border-0 cursor-pointer hover:bg-bg-deep/60 focus:outline-none focus-visible:bg-bg-deep/60 transition-colors"
                  >
                    {/* Name */}
                    <td className="px-3 py-2 max-w-0 w-[40%]">
                      <div className="flex items-center gap-2 min-w-0">
                        {row.color && (
                          <span className="w-1 h-5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
                        )}
                        {row.icon && (
                          <span className="text-base shrink-0" role="img" aria-hidden="true">{row.icon}</span>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium text-text-primary truncate">{row.name}</span>
                            {row.clsLevel && (
                              <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                                {row.clsLevel}
                              </span>
                            )}
                          </div>
                          {row.description && (
                            <p className="text-xs text-text-muted truncate">{row.description}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Severity */}
                    <td className="px-3 py-2 hidden md:table-cell whitespace-nowrap">
                      {severity ? (
                        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', SEVERITY_CLASSES[severity])}>
                          {tIncident(`severity.${severity}`)}
                        </span>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>

                    {/* Phase */}
                    <td className="px-3 py-2 hidden lg:table-cell whitespace-nowrap text-xs text-text-secondary">
                      {severity && row.irPhase ? tIncident(`phase.${row.irPhase}`) : <span className="text-text-muted">—</span>}
                    </td>

                    {/* Status */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', sty.text)}>
                        <span className={cn('w-2 h-2 rounded-full', sty.dot)} />
                        {t(`card.status.${row.status}`)}
                      </span>
                    </td>

                    {/* Data mode + role + members */}
                    <td className="px-3 py-2 hidden md:table-cell whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', DATA_MODE_CLASSES[row.dataMode])}>
                          {t(`card.dataMode.${row.dataMode}`)}{row.dataMode === 'synced' ? ' ↕' : ''}
                        </span>
                        {row.role && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-bg-deep text-text-secondary">
                            {t(`card.role.${row.role}`)}
                          </span>
                        )}
                        {row.memberCount != null && row.memberCount > 0 && (
                          <span className="text-[10px] font-mono text-text-muted">
                            {t('card.members', { count: row.memberCount })}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Entity counts */}
                    <td className="px-3 py-2 hidden xl:table-cell whitespace-nowrap">
                      <div className="flex items-center gap-2.5">
                        {ENTITY_STATS.map((s) => {
                          const Icon = s.icon;
                          const val = row.entityCounts[s.key];
                          return (
                            <span
                              key={s.key}
                              title={t(s.labelKey)}
                              className={cn('inline-flex items-center gap-0.5 text-xs font-mono', val > 0 ? s.color : 'text-text-muted/60')}
                            >
                              <Icon size={11} />
                              {val}
                            </span>
                          );
                        })}
                      </div>
                    </td>

                    {/* Updated */}
                    <td className="px-3 py-2 hidden sm:table-cell whitespace-nowrap text-end text-[11px] font-mono text-text-muted">
                      {row.updatedAt ? formatDate(toMillis(row.updatedAt)) : ''}
                    </td>

                    {/* Actions */}
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        {syncing ? (
                          <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple/15 text-purple">
                            <Loader2 size={10} className="animate-spin" />
                            {t('card.syncing')}
                          </span>
                        ) : row.dataMode === 'remote' && onSync ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onSync(row.folderId); }}
                            className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors"
                            title={t('card.syncLocally')}
                            aria-label={t('card.syncLocally')}
                          >
                            <Download size={10} />
                            {t('card.sync')}
                          </button>
                        ) : row.dataMode === 'synced' && onUnsync ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onUnsync(row.folderId); }}
                            className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-text-muted/15 text-text-secondary hover:bg-text-muted/25 transition-colors"
                            title={t('card.removeLocalCopy')}
                            aria-label={t('card.removeLocalCopy')}
                          >
                            <CloudOff size={10} />
                            {t('card.unsync')}
                          </button>
                        ) : null}
                        <RowMenu
                          row={row}
                          onSettings={onSettings}
                          onArchive={onArchive}
                          onUnarchive={onUnarchive}
                          onDelete={onDelete}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}
