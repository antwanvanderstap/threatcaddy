import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, WifiOff, Briefcase, Search } from 'lucide-react';
import type { Folder, InvestigationSummary, InvestigationDataMode, Note, Task, TimelineEvent, Whiteboard, StandaloneIOC, ChatThread } from '../../types';
import { cn } from '../../lib/utils';
import { InvestigationTable, type InvestigationRow } from './InvestigationTable';
import { SupervisorSummary } from '../Agent/SupervisorSummary';

const ZERO_COUNTS = { notes: 0, tasks: 0, iocs: 0, events: 0, whiteboards: 0, chats: 0 };

type RowStatus = InvestigationRow['status'];

/** The ticket that opened the case: ConnectWise first, as the system of record. */
export function ticketLabel(refs?: Record<string, string> | null): string | undefined {
  if (!refs) return undefined;
  if (refs.connectwise) return `CW #${refs.connectwise}`;
  if (refs.stellar) return `Stellar #${refs.stellar}`;
  const [system, id] = Object.entries(refs)[0] ?? [];
  return system ? `${system} #${id}` : undefined;
}

function localRow(f: Folder, dataMode: 'local' | 'synced', entityCounts: InvestigationRow['entityCounts'], remote?: InvestigationSummary, alertCount?: number): InvestigationRow {
  return {
    folderId: f.id,
    caseNumber: f.caseNumber ?? remote?.folder.caseNumber ?? undefined,
    ticket: ticketLabel(f.externalRefs ?? remote?.folder.externalRefs),
    alertCount: remote?.alertCount ?? alertCount,
    name: f.name,
    status: (f.status || 'active') as RowStatus,
    color: f.color,
    icon: f.icon,
    description: f.description,
    clsLevel: f.clsLevel,
    severity: f.severity,
    irPhase: f.irPhase,
    entityCounts,
    memberCount: remote?.memberCount,
    role: remote?.role,
    dataMode,
    updatedAt: f.updatedAt ?? f.createdAt,
  };
}

function remoteRow(r: InvestigationSummary): InvestigationRow {
  return {
    folderId: r.folderId,
    caseNumber: r.folder.caseNumber ?? undefined,
    ticket: ticketLabel(r.folder.externalRefs),
    alertCount: r.alertCount,
    name: r.folder.name,
    status: (r.folder.status || 'active') as RowStatus,
    color: r.folder.color,
    icon: r.folder.icon,
    description: r.folder.description,
    clsLevel: r.folder.clsLevel,
    severity: r.folder.severity ?? undefined,
    irPhase: r.folder.irPhase ?? undefined,
    entityCounts: r.entityCounts,
    memberCount: r.memberCount,
    role: r.role,
    dataMode: 'remote',
    updatedAt: r.folder.updatedAt,
  };
}

export interface InvestigationsHubProps {
  localFolders: Folder[];
  remoteInvestigations: InvestigationSummary[];
  syncedFolderIds: Set<string>;
  serverConnected: boolean;
  localLoading: boolean;
  remoteLoading: boolean;
  onOpenInvestigation: (folderId: string, mode: InvestigationDataMode) => void;
  onSyncLocally: (folderId: string) => void;
  onUnsync: (folderId: string) => void;
  onCreateInvestigation: () => void;
  onEditInvestigation?: (folderId: string) => void;
  onArchiveInvestigation?: (folderId: string) => void;
  onUnarchiveInvestigation?: (folderId: string) => void;
  onDeleteInvestigation?: (folderId: string) => void;
  allNotes?: Note[];
  allTasks?: Task[];
  allEvents?: TimelineEvent[];
  allWhiteboards?: Whiteboard[];
  allIOCs?: StandaloneIOC[];
  allChats?: ChatThread[];
  syncingFolderId?: string | null;
}

function EmptyState({ message, showCreate, onCreate }: { message: string; showCreate?: boolean; onCreate?: () => void }) {
  const { t } = useTranslation('investigations');
  return (
    <div className="flex flex-col items-center justify-center py-10 text-text-muted">
      <Briefcase size={28} className="mb-2 opacity-40" />
      <p className="text-sm">{message}</p>
      {showCreate && onCreate && (
        <button
          onClick={onCreate}
          className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple text-white hover:brightness-110 transition-all"
        >
          <Plus size={14} />
          {t('hub.createInvestigation')}
        </button>
      )}
    </div>
  );
}

function SectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">{title}</h3>
      {count != null && (
        <span className="px-1.5 py-px rounded-full bg-bg-deep text-[9px] font-mono text-text-muted">
          {count}
        </span>
      )}
    </div>
  );
}

function DisconnectedBanner() {
  const { t } = useTranslation('investigations');
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border-subtle bg-bg-deep/50 text-text-muted text-xs mb-3">
      <WifiOff size={14} />
      <span>{t('hub.disconnected')}</span>
    </div>
  );
}

export function InvestigationsHub({
  localFolders,
  remoteInvestigations,
  syncedFolderIds,
  serverConnected,
  localLoading,
  remoteLoading,
  onOpenInvestigation,
  onSyncLocally,
  onUnsync,
  onCreateInvestigation,
  onEditInvestigation,
  onArchiveInvestigation,
  onUnarchiveInvestigation,
  onDeleteInvestigation,
  allNotes,
  allTasks,
  allEvents,
  allWhiteboards,
  allIOCs,
  allChats,
  syncingFolderId,
}: InvestigationsHubProps) {
  const { t } = useTranslation('investigations');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'closed' | 'archived'>('all');

  const matchesSearch = (name: string) => {
    if (!searchQuery.trim()) return true;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  };

  const matchesStatus = (status?: string) => {
    if (statusFilter === 'all') return true;
    return (status || 'active') === statusFilter;
  };

  // Partition local folders
  const pureLocalFolders = localFolders.filter((f) => !syncedFolderIds.has(f.id) && f.status !== 'archived' && matchesSearch(f.name) && matchesStatus(f.status));
  const archivedLocalFolders = localFolders.filter((f) => !syncedFolderIds.has(f.id) && f.status === 'archived' && matchesSearch(f.name) && matchesStatus(f.status));
  const syncedLocalFolders = localFolders.filter((f) => syncedFolderIds.has(f.id) && f.status !== 'archived' && matchesSearch(f.name) && matchesStatus(f.status));

  // Compute entity counts for local folders
  const localCountsMap = useMemo(() => {
    const map = new Map<string, { notes: number; tasks: number; iocs: number; events: number; whiteboards: number; chats: number }>();
    for (const f of localFolders) map.set(f.id, { notes: 0, tasks: 0, iocs: 0, events: 0, whiteboards: 0, chats: 0 });
    for (const n of (allNotes ?? [])) { if (!n.trashed && !n.archived && n.folderId) { const c = map.get(n.folderId); if (c) c.notes++; } }
    for (const t of (allTasks ?? [])) { if (!t.trashed && !t.archived && t.folderId) { const c = map.get(t.folderId); if (c) c.tasks++; } }
    for (const e of (allEvents ?? [])) { if (!e.trashed && !e.archived && e.folderId) { const c = map.get(e.folderId); if (c) c.events++; } }
    for (const w of (allWhiteboards ?? [])) { if (!w.trashed && !w.archived && w.folderId) { const c = map.get(w.folderId); if (c) c.whiteboards++; } }
    for (const i of (allIOCs ?? [])) { if (!i.trashed && !i.archived && i.folderId) { const c = map.get(i.folderId); if (c) c.iocs++; } }
    for (const ch of (allChats ?? [])) { if (!ch.trashed && !ch.archived && ch.folderId) { const c = map.get(ch.folderId); if (c) c.chats++; } }
    return map;
  }, [localFolders, allNotes, allTasks, allEvents, allWhiteboards, allIOCs, allChats]);

  // Alert notes per local folder (webhook ingest tags them 'alert')
  const localAlertsMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of (allNotes ?? [])) {
      if (!n.trashed && n.folderId && n.tags?.includes('alert')) map.set(n.folderId, (map.get(n.folderId) ?? 0) + 1);
    }
    return map;
  }, [allNotes]);

  // Remote-only investigations (not synced locally)
  const remoteOnlyInvestigations = remoteInvestigations.filter((r) => !syncedFolderIds.has(r.folderId) && matchesSearch(r.folder.name) && matchesStatus(r.folder.status));

  // Build a lookup for remote data to merge with synced local folders
  const remoteByFolderId = new Map<string, InvestigationSummary>();
  for (const r of remoteInvestigations) {
    remoteByFolderId.set(r.folderId, r);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold text-text-primary">{t('hub.title')}</h1>
          <button
            onClick={onCreateInvestigation}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-purple text-white hover:brightness-110 transition-all"
          >
            <Plus size={16} />
            {t('hub.newInvestigation')}
          </button>
        </div>

        {/* Search & Filter Bar */}
        <div className="flex items-center gap-3 mb-8">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              placeholder={t('hub.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full ps-8 pe-3 py-1.5 rounded-lg border border-border-subtle bg-bg-deep text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-purple/50"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'active', 'closed', 'archived'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                  statusFilter === s
                    ? 'bg-purple/20 text-purple'
                    : 'text-text-muted hover:bg-bg-deep hover:text-text-secondary'
                )}
              >
                {t(`hub.${s}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Supervisor summary */}
        <SupervisorSummary onOpenSupervisor={(folderId) => onOpenInvestigation(folderId, 'local')} />

        {/* Section 1: My Investigations (purely local) */}
        <section className="mb-8">
          <SectionHeading title={t('hub.myInvestigations')} count={pureLocalFolders.length} />
          {localLoading || pureLocalFolders.length > 0 ? (
            <InvestigationTable
              rows={pureLocalFolders.map((f) => localRow(f, 'local', localCountsMap.get(f.id) ?? ZERO_COUNTS, undefined, localAlertsMap.get(f.id)))}
              loading={localLoading}
              onOpen={onOpenInvestigation}
              onSettings={onEditInvestigation}
              onArchive={onArchiveInvestigation}
              onUnarchive={onUnarchiveInvestigation}
              onDelete={onDeleteInvestigation}
            />
          ) : (
            <EmptyState
              message={t('hub.noLocal')}
              showCreate
              onCreate={onCreateInvestigation}
            />
          )}
        </section>

        {/* Section: Archived (local-only) */}
        {archivedLocalFolders.length > 0 && (
          <section className="mb-8">
            <SectionHeading title={t('hub.archivedSection')} count={archivedLocalFolders.length} />
            <InvestigationTable
              rows={archivedLocalFolders.map((f) => localRow(f, 'local', localCountsMap.get(f.id) ?? ZERO_COUNTS, undefined, localAlertsMap.get(f.id)))}
              onOpen={onOpenInvestigation}
              onSettings={onEditInvestigation}
              onUnarchive={onUnarchiveInvestigation}
              onDelete={onDeleteInvestigation}
            />
          </section>
        )}

        {/* Section 2: Synced Investigations */}
        <section className="mb-8">
          <SectionHeading title={t('hub.syncedInvestigations')} count={syncedLocalFolders.length} />
          {localLoading || syncedLocalFolders.length > 0 ? (
            <InvestigationTable
              rows={syncedLocalFolders.map((f) => {
                const remote = remoteByFolderId.get(f.id);
                return localRow(f, 'synced', remote?.entityCounts ?? localCountsMap.get(f.id) ?? ZERO_COUNTS, remote, localAlertsMap.get(f.id));
              })}
              loading={localLoading}
              skeletonRows={1}
              onOpen={onOpenInvestigation}
              onUnsync={onUnsync}
              onSettings={onEditInvestigation}
              onArchive={onArchiveInvestigation}
              onUnarchive={onUnarchiveInvestigation}
              onDelete={onDeleteInvestigation}
              syncingFolderId={syncingFolderId}
            />
          ) : (
            <EmptyState message={t('hub.noSynced')} />
          )}
        </section>

        {/* Section 3: Shared With Me (remote only) */}
        <section className="mb-8">
          <SectionHeading title={t('hub.sharedWithMe')} count={serverConnected ? remoteOnlyInvestigations.length : undefined} />
          {!serverConnected ? (
            <DisconnectedBanner />
          ) : remoteLoading || remoteOnlyInvestigations.length > 0 ? (
            <InvestigationTable
              rows={remoteOnlyInvestigations.map(remoteRow)}
              loading={remoteLoading}
              skeletonRows={3}
              onOpen={onOpenInvestigation}
              onSync={onSyncLocally}
              onSettings={onEditInvestigation}
              syncingFolderId={syncingFolderId}
            />
          ) : (
            <EmptyState message={t('hub.noShared')} />
          )}
        </section>
      </div>
    </div>
  );
}
