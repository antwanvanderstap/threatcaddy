import { describe, it, expect } from 'vitest';
import type { IncidentLayout, IncidentType } from '../types';
import {
  DEFAULT_LAYOUT, addSection, addTab, attackTechniquesOf, cloneLayout, moveSection, moveTab,
  placedSections, removeSection, removeTab, renameTab, resolveLayout, setSectionWidth,
} from '../lib/incident-layout';

const layout: IncidentLayout = {
  tabs: [
    { id: 'a', title: 'A', sections: [{ id: 'details', width: 'half' }, { id: 'tags', width: 'half' }, { id: 'description', width: 'full' }] },
    { id: 'b', title: 'B', sections: [{ id: 'timeline', width: 'full' }] },
  ],
};

const type = (id: string, l: IncidentLayout | null): IncidentType => ({
  id, name: id, description: '', color: null, attackTechniques: [], defaultPlaybookId: null, layout: l, order: 0, createdAt: 0, updatedAt: 0,
});

describe('resolveLayout', () => {
  it('uses the type layout, and the default for no type, an unknown type or a type without one', () => {
    const types = [type('custom', layout), type('plain', null)];
    expect(resolveLayout({ incidentType: 'custom' }, types)).toEqual({ type: types[0], layout });
    expect(resolveLayout({ incidentType: 'plain' }, types)).toEqual({ type: types[1], layout: DEFAULT_LAYOUT });
    expect(resolveLayout({ incidentType: 'gone' }, types)).toEqual({ type: undefined, layout: DEFAULT_LAYOUT });
    expect(resolveLayout({}, types).layout).toBe(DEFAULT_LAYOUT);
    expect(resolveLayout(undefined, types).layout).toBe(DEFAULT_LAYOUT);
  });

  it('places every section at most once in the default layout', () => {
    const ids = DEFAULT_LAYOUT.tabs.flatMap((t) => t.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('layout editing', () => {
  it('moves sections within a tab and across tabs', () => {
    expect(moveSection(layout, 'a', 0, 'a', 2).tabs[0].sections.map((s) => s.id)).toEqual(['tags', 'description', 'details']);
    const moved = moveSection(layout, 'a', 1, 'b', 0);
    expect(moved.tabs[0].sections.map((s) => s.id)).toEqual(['details', 'description']);
    expect(moved.tabs[1].sections.map((s) => s.id)).toEqual(['tags', 'timeline']);
    expect(moveSection(layout, 'a', 9, 'b', 0)).toBe(layout);
  });

  it('adds a section once, with its default width, and removes it', () => {
    const added = addSection(layout, 'b', 'stix-observables', 0);
    expect(added.tabs[1].sections[0]).toEqual({ id: 'stix-observables', width: 'full' });
    expect(addSection(added, 'a', 'stix-observables')).toBe(added);
    expect(placedSections(added).has('stix-observables')).toBe(true);
    expect(removeSection(added, 'b', 0).tabs[1].sections.map((s) => s.id)).toEqual(['timeline']);
  });

  it('sets widths without touching the original', () => {
    const copy = cloneLayout(layout);
    const wide = setSectionWidth(copy, 'a', 0, 'full');
    expect(wide.tabs[0].sections[0].width).toBe('full');
    expect(copy.tabs[0].sections[0].width).toBe('half');
  });

  it('adds, renames, reorders and removes tabs, keeping ids unique and at least one tab', () => {
    const withTab = addTab(addTab(layout, 'A'), '  A  ');
    expect(withTab.tabs.map((t) => t.id)).toEqual(['a', 'b', 'a-2', 'a-3']);
    expect(addTab(layout, '   ')).toBe(layout);
    expect(renameTab(layout, 'b', 'Evidence').tabs[1].title).toBe('Evidence');
    expect(renameTab(layout, 'b', ' ')).toBe(layout);
    expect(moveTab(layout, 1, 0).tabs.map((t) => t.id)).toEqual(['b', 'a']);
    const one = removeTab(layout, 'a');
    expect(one.tabs.map((t) => t.id)).toEqual(['b']);
    expect(removeTab(one, 'b')).toBe(one);
  });
});

describe('attackTechniquesOf', () => {
  it('collects technique ids from attack tags and mitre-attack IOCs', () => {
    expect(attackTechniquesOf(['attack:T1059', 'attack:Execution', 'attack:t1078.004', 'stellar'], ['T1566 - Phishing', 'T1059'])).toEqual(['T1059', 'T1078.004', 'T1566']);
    expect(attackTechniquesOf(undefined)).toEqual([]);
  });
});
