import type { Folder, IncidentLayout, IncidentType, LayoutSection, LayoutSectionWidth, LayoutTab } from '../types';

/**
 * Investigation Summary layouts. An incident type's layout is tabs of ordered
 * sections; a type without one (and an investigation without a type) uses
 * DEFAULT_LAYOUT. Section ids not in SUMMARY_SECTIONS are kept in the layout
 * but not rendered, so a layout made by a newer client survives an older one.
 */

export const SUMMARY_SECTION_IDS = [
  'details',
  'incident-clock',
  'stix-observables',
  'description',
  'attack-techniques',
  'external-refs',
  'tags',
  'classification',
  'alerts',
  'open-tasks',
  'recent-notes',
  'case-log',
  'timeline',
  'playbook',
] as const;

export type SummarySectionId = typeof SUMMARY_SECTION_IDS[number];

/** Width a section gets when it is added to a tab. */
export const SECTION_DEFAULT_WIDTH: Record<SummarySectionId, LayoutSectionWidth> = {
  details: 'half',
  'incident-clock': 'half',
  'stix-observables': 'full',
  description: 'full',
  'attack-techniques': 'half',
  'external-refs': 'half',
  tags: 'half',
  classification: 'half',
  alerts: 'full',
  'open-tasks': 'half',
  'recent-notes': 'half',
  'case-log': 'full',
  timeline: 'full',
  playbook: 'full',
};

export function isSummarySection(id: string): id is SummarySectionId {
  return (SUMMARY_SECTION_IDS as readonly string[]).includes(id);
}

const section = (id: SummarySectionId, width = SECTION_DEFAULT_WIDTH[id]): LayoutSection => ({ id, width });

export const DEFAULT_LAYOUT: IncidentLayout = {
  tabs: [
    {
      id: 'summary',
      title: 'Summary',
      sections: [
        section('details'), section('incident-clock'),
        section('stix-observables'),
        section('description'),
        section('attack-techniques'), section('external-refs'),
        section('tags'), section('classification'),
      ],
    },
    {
      id: 'work',
      title: 'Work',
      sections: [section('open-tasks'), section('recent-notes'), section('case-log'), section('playbook')],
    },
    {
      id: 'evidence',
      title: 'Evidence',
      sections: [section('alerts'), section('timeline')],
    },
  ],
};

export function cloneLayout(layout: IncidentLayout): IncidentLayout {
  return { tabs: layout.tabs.map((tab) => ({ ...tab, sections: tab.sections.map((s) => ({ ...s })) })) };
}

/** The investigation's type (undefined when unset or unknown) and the layout to render. */
export function resolveLayout(
  folder: Pick<Folder, 'incidentType'> | undefined,
  types: IncidentType[],
): { type: IncidentType | undefined; layout: IncidentLayout } {
  const type = folder?.incidentType ? types.find((t) => t.id === folder.incidentType) : undefined;
  return { type, layout: type?.layout ?? DEFAULT_LAYOUT };
}

// ─── Editing helpers (pure; the layout editor applies them) ─────────

const MAX_TABS = 12;
const MAX_SECTIONS = 40;

function updateTab(layout: IncidentLayout, tabId: string, fn: (tab: LayoutTab) => LayoutTab): IncidentLayout {
  return { tabs: layout.tabs.map((tab) => (tab.id === tabId ? fn(tab) : tab)) };
}

function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** A tab id unique within the layout, derived from its title. */
export function tabIdFor(layout: IncidentLayout, title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'tab';
  const ids = new Set(layout.tabs.map((t) => t.id));
  if (!ids.has(base)) return base;
  for (let n = 2; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addTab(layout: IncidentLayout, title: string): IncidentLayout {
  const name = title.trim().slice(0, 60);
  if (!name || layout.tabs.length >= MAX_TABS) return layout;
  return { tabs: [...layout.tabs, { id: tabIdFor(layout, name), title: name, sections: [] }] };
}

export function renameTab(layout: IncidentLayout, tabId: string, title: string): IncidentLayout {
  const name = title.trim().slice(0, 60);
  return name ? updateTab(layout, tabId, (tab) => ({ ...tab, title: name })) : layout;
}

/** The last tab cannot be removed: a layout always has one. */
export function removeTab(layout: IncidentLayout, tabId: string): IncidentLayout {
  return layout.tabs.length <= 1 ? layout : { tabs: layout.tabs.filter((t) => t.id !== tabId) };
}

export function moveTab(layout: IncidentLayout, from: number, to: number): IncidentLayout {
  return { tabs: move(layout.tabs, from, to) };
}

/** Sections already placed anywhere in the layout (each appears at most once). */
export function placedSections(layout: IncidentLayout): Set<string> {
  return new Set(layout.tabs.flatMap((t) => t.sections.map((s) => s.id)));
}

export function addSection(layout: IncidentLayout, tabId: string, id: SummarySectionId, index?: number): IncidentLayout {
  if (placedSections(layout).has(id)) return layout;
  return updateTab(layout, tabId, (tab) => {
    if (tab.sections.length >= MAX_SECTIONS) return tab;
    const sections = tab.sections.slice();
    sections.splice(index ?? sections.length, 0, section(id));
    return { ...tab, sections };
  });
}

export function removeSection(layout: IncidentLayout, tabId: string, index: number): IncidentLayout {
  return updateTab(layout, tabId, (tab) => ({ ...tab, sections: tab.sections.filter((_, i) => i !== index) }));
}

export function setSectionWidth(layout: IncidentLayout, tabId: string, index: number, width: LayoutSectionWidth): IncidentLayout {
  return updateTab(layout, tabId, (tab) => ({
    ...tab,
    sections: tab.sections.map((s, i) => (i === index ? { ...s, width } : s)),
  }));
}

/** Moves a section within a tab, or to another tab when `toTabId` differs. */
export function moveSection(
  layout: IncidentLayout, fromTabId: string, from: number, toTabId: string, to: number,
): IncidentLayout {
  if (fromTabId === toTabId) {
    return updateTab(layout, fromTabId, (tab) => ({ ...tab, sections: move(tab.sections, from, to) }));
  }
  const source = layout.tabs.find((t) => t.id === fromTabId);
  const target = layout.tabs.find((t) => t.id === toTabId);
  const moving = source?.sections[from];
  if (!moving || !target || target.sections.length >= MAX_SECTIONS) return layout;
  return {
    tabs: layout.tabs.map((tab) => {
      if (tab.id === fromTabId) return { ...tab, sections: tab.sections.filter((_, i) => i !== from) };
      if (tab.id === toTabId) {
        const sections = tab.sections.slice();
        sections.splice(Math.max(0, Math.min(to, sections.length)), 0, moving);
        return { ...tab, sections };
      }
      return tab;
    }),
  };
}

/** ATT&CK technique ids on an investigation: `attack:T1059` tags plus mitre-attack IOC values. */
export function attackTechniquesOf(tags: string[] | undefined, iocValues: string[] = []): string[] {
  const ids = new Set<string>();
  for (const tag of tags ?? []) {
    const m = /^attack:(T\d{4}(?:\.\d{3})?)$/i.exec(tag);
    if (m) ids.add(m[1].toUpperCase());
  }
  for (const value of iocValues) {
    const m = /^(T\d{4}(?:\.\d{3})?)\b/i.exec(value.trim());
    if (m) ids.add(m[1].toUpperCase());
  }
  return [...ids].sort();
}
