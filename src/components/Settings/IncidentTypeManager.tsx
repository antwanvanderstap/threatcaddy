import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, LayoutTemplate, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import type { IncidentLayout, IncidentType, PlaybookTemplate } from '../../types';
import type { IncidentTypeChanges } from '../../lib/server-api';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import { cn } from '../../lib/utils';
import {
  DEFAULT_LAYOUT, SUMMARY_SECTION_IDS, addSection, addTab, cloneLayout, isSummarySection, moveSection,
  moveTab, placedSections, removeSection, removeTab, renameTab, setSectionWidth,
} from '../../lib/incident-layout';

export interface IncidentTypeManagerProps {
  types: IncidentType[];
  connected: boolean;
  /** Only admins change incident types; the server enforces it too. */
  canEdit: boolean;
  error?: string;
  playbooks: PlaybookTemplate[];
  initialTypeId?: string;
  onCreate: (input: IncidentTypeChanges & { name: string }) => Promise<IncidentType>;
  onUpdate: (id: string, changes: IncidentTypeChanges) => Promise<IncidentType>;
  onDelete: (id: string) => Promise<void>;
}

interface Draft {
  name: string;
  description: string;
  color: string | null;
  techniques: string;
  defaultPlaybookId: string | null;
  layout: IncidentLayout | null;
}

const draftOf = (type: IncidentType): Draft => ({
  name: type.name,
  description: type.description,
  color: type.color,
  techniques: type.attackTechniques.join(', '),
  defaultPlaybookId: type.defaultPlaybookId,
  layout: type.layout ? cloneLayout(type.layout) : null,
});

function parseTechniques(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
}

const TECHNIQUE = /^T\d{4}(?:\.\d{3})?$/;

const input = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent disabled:opacity-60';
const small = 'px-2 py-1 rounded text-xs border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent';

/** Settings → Incident types: team-wide types and their Summary-view layouts. */
export function IncidentTypeManager({
  types, connected, canEdit, error, playbooks, initialTypeId, onCreate, onUpdate, onDelete,
}: IncidentTypeManagerProps) {
  const { t } = useTranslation('investigations');
  const { addToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialTypeId ?? types[0]?.id);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = types.find((x) => x.id === selectedId);
  const [draft, setDraft] = useState<Draft | undefined>(selected && draftOf(selected));

  useEffect(() => {
    if (!selectedId && types.length) setSelectedId(types[0].id); // eslint-disable-line react-hooks/set-state-in-effect
  }, [selectedId, types]);

  // A different type, or a newer version saved (here or by another admin): start
  // from what the server has. A background refresh of an unchanged type keeps the draft.
  const selectedVersion = selected ? `${selected.id}@${selected.updatedAt}` : '';
  useEffect(() => {
    setDraft(selected && draftOf(selected)); // eslint-disable-line react-hooks/set-state-in-effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion]);

  const changes = useMemo((): IncidentTypeChanges | undefined => {
    if (!selected || !draft) return undefined;
    const out: IncidentTypeChanges = {};
    if (draft.name.trim() !== selected.name) out.name = draft.name.trim();
    if (draft.description !== selected.description) out.description = draft.description;
    if (draft.color !== selected.color) out.color = draft.color;
    const techniques = parseTechniques(draft.techniques);
    if (techniques.join() !== selected.attackTechniques.join()) out.attackTechniques = techniques;
    if (draft.defaultPlaybookId !== selected.defaultPlaybookId) out.defaultPlaybookId = draft.defaultPlaybookId;
    if (JSON.stringify(draft.layout) !== JSON.stringify(selected.layout)) out.layout = draft.layout;
    return Object.keys(out).length ? out : undefined;
  }, [selected, draft]);

  const badTechniques = draft ? parseTechniques(draft.techniques).filter((x) => !TECHNIQUE.test(x)) : [];
  const disabled = !canEdit || busy;

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) addToast('success', success);
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!connected && types.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-lg font-semibold text-gray-200 flex items-center gap-2"><LayoutTemplate size={18} /> {t('incidentTypes.title')}</h3>
        <p className="text-sm text-gray-400">{t('incidentTypes.needsServer')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-200 flex items-center gap-2"><LayoutTemplate size={18} /> {t('incidentTypes.title')}</h3>
        <p className="text-xs text-gray-500 mt-1">{t('incidentTypes.intro')}</p>
        {!canEdit && <p className="text-xs text-amber-400 mt-1">{t('incidentTypes.readOnly')}</p>}
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {types.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setSelectedId(x.id)}
            className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border',
              x.id === selectedId ? 'border-accent text-gray-100 bg-gray-800' : 'border-gray-700 text-gray-400 hover:text-gray-200')}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: x.color || '#6b7280' }} />
            {x.name}
            {x.layout && <LayoutTemplate size={10} className="text-accent" aria-label={t('incidentTypes.customLayout')} />}
          </button>
        ))}
      </div>

      {canEdit && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void run(async () => {
              const created = await onCreate({ name });
              setNewName('');
              setSelectedId(created.id);
            }, t('incidentTypes.created', { name }));
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder={t('incidentTypes.newPlaceholder')} className={input} aria-label={t('incidentTypes.newPlaceholder')} />
          <button type="submit" disabled={busy || !newName.trim()} className={cn(small, 'flex items-center gap-1 shrink-0')}><Plus size={12} /> {t('incidentTypes.add')}</button>
        </form>
      )}

      {selected && draft && (
        <div className="space-y-4 rounded-xl border border-gray-700 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <label className="block text-xs text-gray-400">{t('incidentTypes.name')}
              <input value={draft.name} disabled={disabled} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={cn(input, 'mt-1')} />
            </label>
            <label className="block text-xs text-gray-400">{t('incidentTypes.color')}
              <input type="color" value={draft.color || '#6b7280'} disabled={disabled} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="mt-1 block h-9 w-14 rounded border border-gray-700 bg-gray-800" />
            </label>
          </div>
          <label className="block text-xs text-gray-400">{t('incidentTypes.description')}
            <textarea value={draft.description} disabled={disabled} maxLength={2000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={cn(input, 'mt-1 h-16 resize-none')} />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs text-gray-400">{t('incidentTypes.techniques')}
              <input value={draft.techniques} disabled={disabled} placeholder="T1566, T1078.004" onChange={(e) => setDraft({ ...draft, techniques: e.target.value })} className={cn(input, 'mt-1 font-mono')} />
              {badTechniques.length > 0 && <span className="text-red-400">{t('incidentTypes.badTechniques', { ids: badTechniques.join(', ') })}</span>}
            </label>
            <label className="block text-xs text-gray-400">{t('incidentTypes.defaultPlaybook')}
              <select value={draft.defaultPlaybookId ?? ''} disabled={disabled} onChange={(e) => setDraft({ ...draft, defaultPlaybookId: e.target.value || null })} className={cn(input, 'mt-1')}>
                <option value="">{t('detail.none')}</option>
                {draft.defaultPlaybookId && !playbooks.some((p) => p.id === draft.defaultPlaybookId) && (
                  <option value={draft.defaultPlaybookId}>{draft.defaultPlaybookId}</option>
                )}
                {playbooks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-gray-200">{t('incidentTypes.layout')}</h4>
              {draft.layout ? (
                <button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, layout: null })} className={cn(small, 'flex items-center gap-1')}>
                  <RotateCcw size={12} /> {t('incidentTypes.useDefault')}
                </button>
              ) : (
                <button type="button" disabled={disabled} onClick={() => setDraft({ ...draft, layout: cloneLayout(DEFAULT_LAYOUT) })} className={small}>
                  {t('incidentTypes.customize')}
                </button>
              )}
            </div>
            {draft.layout
              ? <LayoutEditor layout={draft.layout} disabled={disabled} onChange={(layout) => setDraft({ ...draft, layout })} />
              : <p className="text-xs text-gray-500">{t('incidentTypes.usesDefault')}</p>}
          </div>

          {canEdit && (
            <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
              <button
                type="button"
                disabled={busy || !changes || !draft.name.trim() || badTechniques.length > 0}
                onClick={() => changes && void run(() => onUpdate(selected.id, changes), t('incidentTypes.saved', { name: draft.name.trim() }))}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
              >
                {t('incidentTypes.save')}
              </button>
              <button type="button" disabled={busy || !changes} onClick={() => setDraft(draftOf(selected))} className={small}>{t('incidentTypes.discard')}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="ms-auto flex items-center gap-1 px-2 py-1 rounded text-xs text-red-400 hover:bg-red-500/10">
                <Trash2 size={12} /> {t('incidentTypes.delete')}
              </button>
            </div>
          )}
        </div>
      )}

      {selected && (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void run(async () => {
              await onDelete(selected.id);
              setSelectedId(undefined);
            }, t('incidentTypes.deleted', { name: selected.name }));
          }}
          title={t('incidentTypes.deleteTitle')}
          message={t('incidentTypes.deleteMessage', { name: selected.name })}
          confirmLabel={t('incidentTypes.delete')}
          danger
        />
      )}
    </section>
  );
}

type DragItem = { tabId: string; index: number };

/** Tabs of ordered sections. Sections drag within and between tabs; buttons do the same without a mouse. */
export function LayoutEditor({ layout, disabled, onChange }: { layout: IncidentLayout; disabled: boolean; onChange: (layout: IncidentLayout) => void }) {
  const { t } = useTranslation('investigations');
  const [tabId, setTabId] = useState<string | undefined>(layout.tabs[0]?.id);
  const [newTab, setNewTab] = useState('');
  const [drag, setDrag] = useState<DragItem | null>(null);
  const tabIndex = Math.max(0, layout.tabs.findIndex((x) => x.id === tabId));
  const tab = layout.tabs[tabIndex];
  const placed = placedSections(layout);
  const available = SUMMARY_SECTION_IDS.filter((id) => !placed.has(id));

  useEffect(() => {
    if (!layout.tabs.some((x) => x.id === tabId)) setTabId(layout.tabs[0]?.id); // eslint-disable-line react-hooks/set-state-in-effect
  }, [layout, tabId]);

  if (!tab) return null;

  const dropOn = (targetTabId: string, index: number) => {
    if (!drag) return;
    onChange(moveSection(layout, drag.tabId, drag.index, targetTabId, index));
    setDrag(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1" role="tablist">
        {layout.tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === tab.id}
            onClick={() => setTabId(x.id)}
            onDragOver={(e) => { if (drag && !disabled) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); dropOn(x.id, layout.tabs.find((y) => y.id === x.id)?.sections.length ?? 0); }}
            className={cn('px-2.5 py-1 rounded text-xs border', x.id === tab.id ? 'border-accent text-gray-100 bg-gray-800' : 'border-gray-700 text-gray-400 hover:text-gray-200')}
          >
            {x.title} <span className="text-gray-500">({x.sections.length})</span>
          </button>
        ))}
        {!disabled && (
          <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const next = addTab(layout, newTab); if (next !== layout) { onChange(next); setTabId(next.tabs.at(-1)?.id); setNewTab(''); } }}>
            <input value={newTab} onChange={(e) => setNewTab(e.target.value)} maxLength={60} placeholder={t('incidentTypes.newTab')} aria-label={t('incidentTypes.newTab')}
              className="w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" />
            <button type="submit" disabled={!newTab.trim() || layout.tabs.length >= 12} className={small} aria-label={t('incidentTypes.addTab')}><Plus size={12} /></button>
          </form>
        )}
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center gap-1">
          <input
            key={tab.id}
            defaultValue={tab.title}
            maxLength={60}
            aria-label={t('incidentTypes.tabTitle')}
            onBlur={(e) => onChange(renameTab(layout, tab.id, e.target.value))}
            className="w-40 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
          />
          <button type="button" className={small} disabled={tabIndex === 0} onClick={() => onChange(moveTab(layout, tabIndex, tabIndex - 1))} aria-label={t('incidentTypes.tabLeft')}><ChevronLeft size={12} /></button>
          <button type="button" className={small} disabled={tabIndex === layout.tabs.length - 1} onClick={() => onChange(moveTab(layout, tabIndex, tabIndex + 1))} aria-label={t('incidentTypes.tabRight')}><ChevronRight size={12} /></button>
          <button type="button" className={cn(small, 'text-red-400')} disabled={layout.tabs.length <= 1} onClick={() => onChange(removeTab(layout, tab.id))}>{t('incidentTypes.removeTab')}</button>
        </div>
      )}

      {/* Sections in a two-column preview: full-width sections span both columns, as in the Summary view. */}
      <ol className="grid grid-cols-2 gap-2" aria-label={t('incidentTypes.sectionsOf', { tab: tab.title })}>
        {tab.sections.map((s, i) => {
          const known = isSummarySection(s.id);
          return (
            <li
              key={`${s.id}-${i}`}
              draggable={!disabled}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); setDrag({ tabId: tab.id, index: i }); }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (drag && !disabled) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); dropOn(tab.id, i); }}
              className={cn('flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800/60 px-2 py-1.5 text-xs min-w-0',
                s.width === 'full' && 'col-span-2',
                drag?.tabId === tab.id && drag.index === i && 'opacity-40')}
            >
              {!disabled && <GripVertical size={12} className="shrink-0 text-gray-500 cursor-grab" />}
              <span className={cn('flex-1 truncate', known ? 'text-gray-200' : 'text-gray-500 italic')} title={s.id}>
                {known ? t(`summary.section.${s.id}`) : t('incidentTypes.unknownSection', { id: s.id })}
              </span>
              {!disabled && (
                <>
                  <button type="button" className={small} onClick={() => onChange(setSectionWidth(layout, tab.id, i, s.width === 'full' ? 'half' : 'full'))}
                    aria-label={t('incidentTypes.toggleWidth')} title={t('incidentTypes.toggleWidth')}>
                    {s.width === 'full' ? t('incidentTypes.full') : t('incidentTypes.half')}
                  </button>
                  <button type="button" className={small} disabled={i === 0} onClick={() => onChange(moveSection(layout, tab.id, i, tab.id, i - 1))} aria-label={t('incidentTypes.moveUp')}><ArrowUp size={12} /></button>
                  <button type="button" className={small} disabled={i === tab.sections.length - 1} onClick={() => onChange(moveSection(layout, tab.id, i, tab.id, i + 1))} aria-label={t('incidentTypes.moveDown')}><ArrowDown size={12} /></button>
                  {layout.tabs.length > 1 && (
                    <select
                      value=""
                      aria-label={t('incidentTypes.moveToTab')}
                      onChange={(e) => { if (e.target.value) onChange(moveSection(layout, tab.id, i, e.target.value, Number.MAX_SAFE_INTEGER)); }}
                      className="bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[11px] text-gray-300 max-w-[5.5rem]"
                    >
                      <option value="">{t('incidentTypes.moveToTab')}</option>
                      {layout.tabs.filter((x) => x.id !== tab.id).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                    </select>
                  )}
                  <button type="button" className={cn(small, 'text-red-400')} onClick={() => onChange(removeSection(layout, tab.id, i))} aria-label={t('incidentTypes.removeSection')}><X size={12} /></button>
                </>
              )}
            </li>
          );
        })}
        {tab.sections.length === 0 && (
          <li className="col-span-2 rounded-lg border border-dashed border-gray-700 px-2 py-3 text-center text-xs text-gray-500"
            onDragOver={(e) => { if (drag && !disabled) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); dropOn(tab.id, 0); }}>
            {t('incidentTypes.emptyTab')}
          </li>
        )}
      </ol>

      {!disabled && available.length > 0 && (
        <div>
          <p className="text-[11px] text-gray-500 mb-1">{t('incidentTypes.addSection')}</p>
          <div className="flex flex-wrap gap-1">
            {available.map((id) => (
              <button key={id} type="button" className={cn(small, 'flex items-center gap-1')} onClick={() => onChange(addSection(layout, tab.id, id))}>
                <Plus size={10} /> {t(`summary.section.${id}`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
