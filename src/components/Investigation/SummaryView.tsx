import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Briefcase, ExternalLink, LayoutTemplate, Pencil, SlidersHorizontal } from 'lucide-react';
import type {
  CaseUpdate, Folder, IncidentPhase, IncidentSeverity, IncidentType, InvestigationStatus,
  LayoutSection, Note, StandaloneIOC, Task, TimelineEvent, ViewMode,
} from '../../types';
import { INCIDENT_PHASES, INCIDENT_SEVERITIES } from '../../types';
import { cn, formatDate, formatFullDate } from '../../lib/utils';
import { renderMarkdown } from '../../lib/markdown';
import { formatDuration, incidentDurations } from '../../lib/case-updates';
import { attackTechniquesOf, isSummarySection, resolveLayout, type SummarySectionId } from '../../lib/incident-layout';
import { ObservedStixObjects } from './ObservedStixObjects';

export interface SummaryViewProps {
  folder?: Folder;
  types: IncidentType[];
  /** Admins edit layouts; everyone else only sees them. */
  canEditLayouts: boolean;
  observables: StandaloneIOC[];
  notes: Note[];
  tasks: Task[];
  events: TimelineEvent[];
  caseUpdates: CaseUpdate[];
  onUpdate: (id: string, updates: Partial<Folder>) => void;
  onAdvancePhase: (phase: IncidentPhase) => Promise<void>;
  onOpenView: (view: ViewMode) => void;
  onOpenNote: (id: string) => void;
  onOpenDetails: () => void;
  onEditLayout: (typeId?: string) => void;
}

const STATUSES: InvestigationStatus[] = ['active', 'closed', 'archived'];

const SEVERITY_ACTIVE: Record<IncidentSeverity, string> = {
  critical: 'bg-red-600/20 text-red-400 border-red-600/40',
  high: 'bg-orange-600/20 text-orange-400 border-orange-600/40',
  medium: 'bg-yellow-600/20 text-yellow-400 border-yellow-600/40',
  low: 'bg-blue-600/20 text-blue-400 border-blue-600/40',
  none: 'bg-gray-600/20 text-gray-300 border-gray-600/40',
};

const chip = 'px-2 py-1 text-xs rounded border transition-colors';
const chipIdle = 'border-border-subtle text-text-muted hover:bg-bg-hover hover:text-text-primary';

function attackUrl(id: string): string {
  const [technique, sub] = id.split('.');
  return `https://attack.mitre.org/techniques/${technique}/${sub ? `${sub}/` : ''}`;
}

function Card({ title, action, width, children }: { title: string; action?: ReactNode; width: LayoutSection['width']; children: ReactNode }) {
  return (
    <section className={cn('rounded-lg border border-border-subtle bg-bg-secondary p-3 min-w-0', width === 'full' && 'md:col-span-2')}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] text-accent hover:text-accent-hover">
      {children}
    </button>
  );
}

/**
 * An investigation at a glance, laid out by its incident type: the type's tabs
 * and sections, or the default layout for investigations without a type.
 */
export function SummaryView(props: SummaryViewProps) {
  const { folder, types, canEditLayouts, onUpdate, onEditLayout, onOpenDetails } = props;
  const { t } = useTranslation('investigations');
  const { type, layout } = useMemo(() => resolveLayout(folder, types), [folder, types]);
  const [tabId, setTabId] = useState(layout.tabs[0]?.id);
  // Durations only need minute precision; fixed while the view is open.
  const [now] = useState(() => Date.now());

  // Another investigation or another type: start on its first tab.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabId((current) => (layout.tabs.some((tab) => tab.id === current) ? current : layout.tabs[0]?.id));
  }, [layout]);

  if (!folder) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <LayoutTemplate size={32} className="text-text-muted" />
        <p className="text-sm font-medium">{t('summary.noInvestigation')}</p>
        <p className="text-xs text-text-muted max-w-md">{t('summary.noInvestigationDesc')}</p>
      </div>
    );
  }

  const tab = layout.tabs.find((x) => x.id === tabId) ?? layout.tabs[0];
  const unknownType = !!folder.incidentType && !type;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="shrink-0 border-b border-border-subtle px-4 py-3 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Briefcase size={18} style={{ color: folder.color || undefined }} className="shrink-0 text-accent-blue" />
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold truncate">
              {folder.caseNumber && <span className="font-mono text-text-muted me-2">{folder.caseNumber}</span>}
              {folder.name}
            </h1>
            {folder.customerCode && <p className="text-xs text-text-muted">{t('summary.customer', { code: folder.customerCode })}</p>}
          </div>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            {t('summary.typeLabel')}
            <select
              aria-label={t('summary.typeLabel')}
              value={type ? type.id : ''}
              onChange={(e) => onUpdate(folder.id, { incidentType: e.target.value || undefined })}
              className="bg-bg-primary border border-border-subtle rounded px-2 py-1 text-xs text-text-primary"
            >
              <option value="">{unknownType ? t('summary.typeUnknown', { id: folder.incidentType }) : t('summary.typeDefault')}</option>
              {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={onOpenDetails} className={cn(chip, chipIdle, 'flex items-center gap-1')}>
            <SlidersHorizontal size={12} /> {t('summary.details')}
          </button>
          {canEditLayouts && (
            <button type="button" onClick={() => onEditLayout(type?.id)} className={cn(chip, chipIdle, 'flex items-center gap-1')}>
              <Pencil size={12} /> {t('summary.editLayout')}
            </button>
          )}
        </div>
        {layout.tabs.length > 1 && (
          <div role="tablist" className="flex gap-1 flex-wrap">
            {layout.tabs.map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={x.id === tab?.id}
                onClick={() => setTabId(x.id)}
                className={cn(chip, x.id === tab?.id ? 'border-accent-blue text-accent-blue bg-accent-blue/10' : chipIdle)}
              >
                {x.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab && tab.sections.some((s) => isSummarySection(s.id)) ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {tab.sections.map((s) => isSummarySection(s.id)
              ? <SummarySection key={s.id} id={s.id} width={s.width} folder={folder} now={now} {...props} />
              : null)}
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('summary.emptyTab')}</p>
        )}
      </div>
    </div>
  );
}

function SummarySection({ id, width, folder, now, ...props }: Omit<SummaryViewProps, 'folder'> & { id: SummarySectionId; width: LayoutSection['width']; folder: Folder; now: number }) {
  const { t } = useTranslation('investigations');
  const { t: tIncident } = useTranslation('incident');
  const { onUpdate, onOpenView, onOpenNote, onOpenDetails, onAdvancePhase } = props;
  const title = t(`summary.section.${id}`);
  const empty = <p className="text-xs text-text-muted">{t('summary.nothingYet')}</p>;

  switch (id) {
    case 'details': {
      const status = folder.status || 'active';
      return (
        <Card title={title} width={width}>
          <div className="space-y-2">
            <div className="flex gap-1 flex-wrap" aria-label={tIncident('severity.label')}>
              {INCIDENT_SEVERITIES.map((value) => (
                <button key={value} type="button" onClick={() => onUpdate(folder.id, { severity: value })}
                  className={cn(chip, (folder.severity ?? 'none') === value ? SEVERITY_ACTIVE[value] : chipIdle)}>
                  {tIncident(`severity.${value}`)}
                </button>
              ))}
            </div>
            <div className="flex gap-1 flex-wrap">
              {STATUSES.map((value) => (
                <button key={value} type="button"
                  onClick={() => onUpdate(folder.id, value === 'closed'
                    ? { status: value, closedAt: Date.now() }
                    : { status: value, closureResolution: undefined, closedReason: undefined, closedAt: undefined })}
                  className={cn(chip, status === value ? 'border-accent-green text-accent-green bg-accent-green/10' : chipIdle)}>
                  {t(`detail.${value}`)}
                </button>
              ))}
            </div>
            <div className="flex gap-1 flex-wrap" aria-label={tIncident('phase.label')}>
              {INCIDENT_PHASES.map((phase) => (
                <button key={phase} type="button" onClick={() => { void onAdvancePhase(phase); }}
                  className={cn(chip, folder.irPhase === phase ? 'border-accent-blue text-accent-blue bg-accent-blue/10' : chipIdle)}>
                  {tIncident(`phase.${phase}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted">{t('detail.created', { date: formatFullDate(folder.createdAt) })}</p>
          </div>
        </Card>
      );
    }

    case 'incident-clock': {
      const durations = incidentDurations(folder, now);
      const rows: [string, number | undefined][] = [
        [t('summary.clock.detected'), folder.detectedAt],
        [t('summary.clock.contained'), folder.containedAt],
        [t('summary.clock.eradicated'), folder.eradicatedAt],
        [t('summary.clock.recovered'), folder.recoveredAt],
      ];
      return (
        <Card title={title} width={width}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {rows.map(([label, at]) => (
              <div key={label} className="contents">
                <dt className="text-text-muted">{label}</dt>
                <dd>{at != null ? formatFullDate(at) : '—'}</dd>
              </div>
            ))}
            {durations.timeToContain != null && (<><dt className="text-text-muted">{tIncident('clock.timeToContain')}</dt><dd>{formatDuration(durations.timeToContain, tIncident)}</dd></>)}
            {durations.timeToRecover != null && (<><dt className="text-text-muted">{tIncident('clock.timeToRecover')}</dt><dd>{formatDuration(durations.timeToRecover, tIncident)}</dd></>)}
          </dl>
        </Card>
      );
    }

    case 'stix-observables':
      return (
        <Card title={title} width={width} action={props.observables.length > 0 && <LinkButton onClick={() => onOpenView('ioc-stats')}>{t('detail.observablesOpen')}</LinkButton>}>
          <ObservedStixObjects observables={props.observables} />
        </Card>
      );

    case 'description':
      return <DescriptionSection folder={folder} title={title} width={width} onUpdate={onUpdate} />;

    case 'attack-techniques': {
      const ids = attackTechniquesOf(folder.tags, props.observables.filter((i) => i.type === 'mitre-attack').map((i) => i.value));
      return (
        <Card title={title} width={width}>
          {ids.length === 0 ? empty : (
            <div className="flex flex-wrap gap-1.5">
              {ids.map((id) => (
                <a key={id} href={attackUrl(id)} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-teal-600/40 bg-teal-600/10 text-xs font-mono text-teal-300 hover:bg-teal-600/20">
                  {id} <ExternalLink size={10} />
                </a>
              ))}
            </div>
          )}
        </Card>
      );
    }

    case 'external-refs': {
      const refs = Object.entries(folder.externalRefs ?? {});
      return (
        <Card title={title} width={width}>
          {refs.length === 0 ? empty : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {refs.map(([system, ref]) => (
                <div key={system} className="contents">
                  <dt className="text-text-muted">{system}</dt>
                  <dd className="font-mono truncate">{ref}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      );
    }

    case 'tags':
      return (
        <Card title={title} width={width} action={<LinkButton onClick={onOpenDetails}>{t('summary.edit')}</LinkButton>}>
          {(folder.tags ?? []).length === 0 ? empty : (
            <div className="flex flex-wrap gap-1">
              {(folder.tags ?? []).map((tag) => (
                <span key={tag} className="px-2 py-0.5 rounded-full bg-purple/10 border border-purple/30 text-[11px] text-text-secondary">{tag}</span>
              ))}
            </div>
          )}
        </Card>
      );

    case 'classification':
      return (
        <Card title={title} width={width} action={<LinkButton onClick={onOpenDetails}>{t('summary.edit')}</LinkButton>}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-text-muted">{t('detail.classificationLabel')}</dt><dd>{folder.clsLevel || '—'}</dd>
            <dt className="text-text-muted">{t('detail.papLabel')}</dt><dd>{folder.papLevel || '—'}</dd>
          </dl>
        </Card>
      );

    case 'alerts': {
      const alerts = props.notes.filter((n) => n.tags.includes('alert')).sort((a, b) => b.createdAt - a.createdAt);
      return (
        <Card title={t('summary.countTitle', { title, count: alerts.length })} width={width}>
          {alerts.length === 0 ? empty : (
            <ul className="space-y-1">
              {alerts.slice(0, 10).map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => onOpenNote(n.id)} className="w-full flex gap-2 text-start text-xs hover:text-accent">
                    <span className="text-text-muted shrink-0">{formatDate(n.createdAt)}</span>
                    <span className="truncate">{n.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }

    case 'open-tasks': {
      const open = props.tasks.filter((x) => x.status !== 'done' && !x.completed).sort((a, b) => a.order - b.order);
      return (
        <Card title={t('summary.countTitle', { title, count: open.length })} width={width} action={<LinkButton onClick={() => onOpenView('tasks')}>{t('summary.openAll')}</LinkButton>}>
          {open.length === 0 ? empty : (
            <ul className="space-y-1">
              {open.slice(0, 8).map((x) => (
                <li key={x.id} className="flex gap-2 text-xs">
                  <span className={cn('shrink-0 px-1.5 rounded text-[10px] border', x.status === 'in-progress' ? 'border-accent-amber/40 text-accent-amber' : 'border-border-subtle text-text-muted')}>{x.status}</span>
                  <span className="truncate">{x.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }

    case 'recent-notes': {
      const recent = props.notes.filter((n) => !n.tags.includes('alert')).sort((a, b) => b.updatedAt - a.updatedAt);
      return (
        <Card title={title} width={width} action={<LinkButton onClick={() => onOpenView('notes')}>{t('summary.openAll')}</LinkButton>}>
          {recent.length === 0 ? empty : (
            <ul className="space-y-1">
              {recent.slice(0, 6).map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => onOpenNote(n.id)} className="w-full flex gap-2 text-start text-xs hover:text-accent">
                    <span className="text-text-muted shrink-0">{formatDate(n.updatedAt)}</span>
                    <span className="truncate">{n.title || t('summary.untitled')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }

    case 'case-log': {
      const latest = props.caseUpdates.slice().sort((a, b) => b.createdAt - a.createdAt);
      return (
        <Card title={title} width={width} action={<LinkButton onClick={() => onOpenView('case-log')}>{t('summary.openAll')}</LinkButton>}>
          {latest.length === 0 ? empty : (
            <ul className="space-y-1.5">
              {latest.slice(0, 5).map((u) => (
                <li key={u.id} className="text-xs">
                  <span className="text-text-muted me-2">{formatDate(u.createdAt)}</span>
                  <span className="px-1.5 rounded border border-border-subtle text-[10px] me-2">{u.type}</span>
                  <span className="text-text-secondary">{u.body.length > 160 ? `${u.body.slice(0, 157)}…` : u.body}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }

    case 'timeline': {
      const events = props.events.slice().sort((a, b) => b.timestamp - a.timestamp);
      return (
        <Card title={t('summary.countTitle', { title, count: events.length })} width={width} action={<LinkButton onClick={() => onOpenView('timeline')}>{t('summary.openAll')}</LinkButton>}>
          {events.length === 0 ? empty : (
            <ul className="space-y-1">
              {events.slice(0, 10).map((e) => (
                <li key={e.id} className="flex gap-2 text-xs">
                  <span className="text-text-muted shrink-0">{formatFullDate(e.timestamp)}</span>
                  <span className="truncate">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      );
    }

    case 'playbook': {
      const execution = folder.playbookExecution;
      const done = execution?.steps.filter((s) => s.completed).length ?? 0;
      const total = execution?.steps.length ?? 0;
      return (
        <Card title={title} width={width} action={<LinkButton onClick={onOpenDetails}>{t('summary.openAll')}</LinkButton>}>
          {!execution ? empty : (
            <div className="space-y-1.5">
              <p className="text-xs">{execution.templateName} <span className="text-text-muted">· {done}/{total}</span></p>
              <div className="h-1.5 rounded bg-bg-hover overflow-hidden">
                <div className="h-full bg-accent-green" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
              </div>
            </div>
          )}
        </Card>
      );
    }
  }
}

function DescriptionSection({ folder, title, width, onUpdate }: { folder: Folder; title: string; width: LayoutSection['width']; onUpdate: SummaryViewProps['onUpdate'] }) {
  const { t } = useTranslation('investigations');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.description || '');
  const html = useMemo(() => (folder.description ? renderMarkdown(folder.description, undefined, { disableMedia: true }) : ''), [folder.description]);

  const save = () => {
    setEditing(false);
    if (draft !== (folder.description || '')) onUpdate(folder.id, { description: draft.trim() || undefined });
  };

  return (
    <Card title={title} width={width} action={!editing && (
      <LinkButton onClick={() => { setDraft(folder.description || ''); setEditing(true); }}>{t('summary.edit')}</LinkButton>
    )}>
      {editing ? (
        <textarea
          autoFocus
          maxLength={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          aria-label={title}
          className="w-full h-32 bg-bg-primary border border-border-subtle rounded p-2 text-xs font-mono"
        />
      ) : html ? (
        <div className="markdown-preview max-w-none text-sm overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="text-xs text-text-muted">{t('summary.nothingYet')}</p>
      )}
    </Card>
  );
}
