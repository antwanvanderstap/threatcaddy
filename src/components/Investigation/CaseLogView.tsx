import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ClipboardList,
  Eye,
  History,
  Pencil,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import type { CaseUpdate, CaseUpdateType, Folder, IncidentPhase } from '../../types';
import { CASE_UPDATE_TYPES, INCIDENT_PHASES } from '../../types';
import { cn, formatDate } from '../../lib/utils';
import { filterUpdates, isEdited, incidentDurations } from '../../lib/case-updates';

interface CaseLogViewProps {
  folder?: Folder;
  updates: CaseUpdate[];
  onAdd: (input: { type: CaseUpdateType; body: string; phase?: IncidentPhase }) => Promise<unknown>;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAdvancePhase: (phase: IncidentPhase) => Promise<void>;
  now: number;
}

const TYPE_STYLE: Record<CaseUpdateType, { icon: typeof ClipboardList; chip: string }> = {
  status: { icon: ClipboardList, chip: 'bg-bg-secondary text-text-secondary border-border-subtle' },
  finding: { icon: Eye, chip: 'bg-accent-blue/15 text-accent-blue border-accent-blue/30' },
  action: { icon: ShieldCheck, chip: 'bg-accent-green/15 text-accent-green border-accent-green/30' },
  escalation: { icon: AlertTriangle, chip: 'bg-accent-red/15 text-accent-red border-accent-red/30' },
  containment: { icon: ShieldCheck, chip: 'bg-accent-amber/15 text-accent-amber border-accent-amber/30' },
  handover: { icon: UserCheck, chip: 'bg-accent-purple/15 text-accent-purple border-accent-purple/30' },
};

function formatDuration(ms: number | undefined, t: (k: string, o?: Record<string, unknown>) => string): string | undefined {
  if (ms == null) return undefined;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('duration.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('duration.hours', { count: hours });
  return t('duration.days', { count: Math.round(hours / 24) });
}

export function CaseLogView({
  folder, updates, onAdd, onEdit, onDelete, onAdvancePhase, now,
}: CaseLogViewProps) {
  const { t } = useTranslation('incident');
  const [type, setType] = useState<CaseUpdateType>('status');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<CaseUpdateType[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const visible = useMemo(
    () => filterUpdates(updates, { types: typeFilter, query }),
    [updates, typeFilter, query],
  );

  const durations = useMemo(
    () => (folder ? incidentDurations(folder, now) : undefined),
    [folder, now],
  );

  if (!folder) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <ClipboardList size={32} className="text-text-muted" />
        <p className="text-sm font-medium">{t('empty.noInvestigation')}</p>
        <p className="text-xs text-text-muted max-w-md">{t('empty.noInvestigationDesc')}</p>
      </div>
    );
  }

  const submit = async () => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onAdd({ type, body, phase: folder.irPhase });
      setBody('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header: phase + incident clock */}
      <div className="shrink-0 border-b border-border-subtle px-4 py-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <ClipboardList size={18} className="text-accent-blue shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate">{t('header.title')}</h1>
            <p className="text-xs text-text-muted truncate">{folder.name}</p>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-text-muted mr-1">{t('phase.label')}</span>
          {INCIDENT_PHASES.map((phase) => (
            <button
              key={phase}
              type="button"
              onClick={() => onAdvancePhase(phase)}
              className={cn(
                'px-2 py-1 text-xs rounded border',
                folder.irPhase === phase
                  ? 'border-accent-blue text-accent-blue bg-accent-blue/10'
                  : 'border-border-subtle hover:bg-bg-hover',
              )}
            >
              {t(`phase.${phase}`)}
            </button>
          ))}
        </div>

        {durations && (durations.timeToContain != null || durations.timeToRecover != null) && (
          <p className="text-xs text-text-muted">
            {durations.timeToContain != null && (
              <span>{t('clock.timeToContain')} <strong className="text-text-primary">{formatDuration(durations.timeToContain, t)}</strong></span>
            )}
            {durations.timeToRecover != null && (
              <span className="ml-3">{t('clock.timeToRecover')} <strong className="text-text-primary">{formatDuration(durations.timeToRecover, t)}</strong></span>
            )}
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-b border-border-subtle px-4 py-3 space-y-2">
        <div className="flex items-center gap-1 flex-wrap">
          {CASE_UPDATE_TYPES.map((value) => {
            const style = TYPE_STYLE[value];
            const Icon = style.icon;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setType(value)}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 text-xs rounded border',
                  type === value ? style.chip : 'border-border-subtle text-text-muted hover:bg-bg-hover',
                )}
              >
                <Icon size={11} />
                {t(`type.${value}`)}
              </button>
            );
          })}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter posts — during a live response the keyboard
              // matters more than the mouse.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
            }}
            rows={2}
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            className="flex-1 text-xs rounded border border-border-subtle bg-bg-input p-2 resize-y"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!body.trim() || submitting}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
          >
            <Send size={13} />
            {t('composer.post')}
          </button>
        </div>
      </div>

      {/* Filters */}
      {updates.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-border-subtle flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {CASE_UPDATE_TYPES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTypeFilter((prev) =>
                  prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value])}
                className={cn(
                  'px-1.5 py-0.5 text-xs rounded border',
                  typeFilter.includes(value)
                    ? 'border-accent-blue text-accent-blue'
                    : 'border-border-subtle text-text-muted hover:bg-bg-hover',
                )}
              >
                {t(`type.${value}`)}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filter.search')}
              aria-label={t('filter.search')}
              className="pl-7 pr-2 py-1 text-xs rounded border border-border-subtle bg-bg-input w-52"
            />
          </div>
        </div>
      )}

      {/* Log */}
      <div className="flex-1 overflow-auto">
        {updates.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm font-medium">{t('empty.noUpdates')}</p>
            <p className="text-xs text-text-muted mt-1">{t('empty.noUpdatesDesc')}</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-xs text-text-muted p-4">{t('filter.noResults')}</p>
        ) : (
          <ol className="p-3 space-y-2">
            {visible.map((update) => (
              <UpdateEntry
                key={update.id}
                update={update}
                editing={editingId === update.id}
                onStartEdit={() => setEditingId(update.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={async (next) => { await onEdit(update.id, next); setEditingId(null); }}
                onDelete={() => onDelete(update.id)}
                t={t}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function UpdateEntry({
  update, editing, onStartEdit, onCancelEdit, onSaveEdit, onDelete, t,
}: {
  update: CaseUpdate;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (body: string) => Promise<void>;
  onDelete: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [draft, setDraft] = useState(update.body);
  const [showRevisions, setShowRevisions] = useState(false);
  const style = TYPE_STYLE[update.type];
  const Icon = style.icon;

  return (
    <li className="border border-border-subtle rounded p-3">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded border', style.chip)}>
          <Icon size={11} />
          {t(`type.${update.type}`)}
        </span>
        {update.phase && (
          <span className="text-text-muted">{t(`phase.${update.phase}`)}</span>
        )}
        <span className="text-text-muted">{update.authorName ?? '—'}</span>
        <span className="text-text-muted">{formatDate(update.createdAt)}</span>
        {isEdited(update) && (
          <button
            type="button"
            onClick={() => setShowRevisions((v) => !v)}
            className="flex items-center gap-1 text-accent-amber hover:underline"
            title={t('entry.editedTitle', { count: update.revisions?.length ?? 0 })}
          >
            <History size={10} />
            {t('entry.edited')}
          </button>
        )}
        <span className="ml-auto flex items-center gap-1">
          {!editing && (
            <button type="button" onClick={onStartEdit} className="text-text-muted hover:text-text-primary" title={t('entry.edit')}>
              <Pencil size={12} />
            </button>
          )}
          <button type="button" onClick={onDelete} className="text-text-muted hover:text-accent-red" title={t('entry.delete')}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full text-xs rounded border border-border-subtle bg-bg-input p-2 resize-y"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onSaveEdit(draft)}
              className="px-2.5 py-1 text-xs rounded bg-accent-blue text-white hover:opacity-90"
            >
              {t('entry.save')}
            </button>
            <button
              type="button"
              onClick={() => { setDraft(update.body); onCancelEdit(); }}
              className="px-2.5 py-1 text-xs rounded border border-border-subtle hover:bg-bg-hover"
            >
              {t('entry.cancel')}
            </button>
            <span className="text-xs text-text-muted">{t('entry.editKeepsHistory')}</span>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 text-xs whitespace-pre-wrap break-words">{update.body}</p>
      )}

      {showRevisions && update.revisions && (
        <div className="mt-2 pt-2 border-t border-border-subtle space-y-1.5">
          <p className="text-xs text-text-muted flex items-center gap-1">
            <History size={10} />
            {t('entry.revisionHistory')}
          </p>
          {[...update.revisions].reverse().map((revision, i) => (
            <div key={`${revision.editedAt}-${i}`} className="text-xs">
              <p className="text-text-muted">
                {formatDate(revision.editedAt)}
                {revision.editedBy ? ` · ${revision.editedBy}` : ''}
              </p>
              <p className="whitespace-pre-wrap break-words text-text-muted line-through decoration-1">
                {revision.body}
              </p>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setShowRevisions(false)}
            className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1"
          >
            <X size={10} />
            {t('entry.hideHistory')}
          </button>
        </div>
      )}
    </li>
  );
}
