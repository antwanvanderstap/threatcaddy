import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SummaryView, type SummaryViewProps } from '../components/Investigation/SummaryView';
import type { Folder, IncidentType, StandaloneIOC } from '../types';

const folder: Folder = {
  id: 'f1', name: 'Suspicious process', order: 0, createdAt: 1, caseNumber: 'NAG-0007',
  description: '**Stellar case** 110008', tags: ['attack:T1059', 'stellar'], externalRefs: { stellar: '110008' },
} as Folder;

const phishing: IncidentType = {
  id: 'phishing', name: 'Phishing', description: '', color: null, attackTechniques: ['T1566'], defaultPlaybookId: null,
  order: 10, createdAt: 0, updatedAt: 0,
  layout: { tabs: [{ id: 'triage', title: 'Triage', sections: [
    { id: 'external-refs', width: 'half' }, { id: 'field:affected-mailbox', width: 'half' },
  ] }] },
};

function renderView(overrides: Partial<SummaryViewProps> = {}) {
  const props: SummaryViewProps = {
    folder, types: [phishing], canEditLayouts: false,
    observables: [{ id: 'i1', type: 'ipv4', value: '10.0.0.5', folderId: 'f1' } as StandaloneIOC],
    notes: [], tasks: [], events: [], caseUpdates: [],
    onUpdate: vi.fn(), onAdvancePhase: vi.fn(async () => {}), onOpenView: vi.fn(), onOpenNote: vi.fn(),
    onOpenDetails: vi.fn(), onEditLayout: vi.fn(),
    ...overrides,
  };
  render(<SummaryView {...props} />);
  return props;
}

describe('SummaryView', () => {
  it('shows the default layout for an investigation without a type', () => {
    renderView();
    expect(screen.getByText('NAG-0007')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Summary', 'Work', 'Evidence']);
    expect(screen.getByTitle('ipv4-addr: 10.0.0.5')).toBeTruthy();
    expect(screen.getByText('T1059')).toBeTruthy();
    expect(document.querySelector('.markdown-preview strong')?.textContent).toBe('Stellar case');
  });

  it('follows the type layout and skips sections it does not know', () => {
    renderView({ folder: { ...folder, incidentType: 'phishing' } });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('110008')).toBeTruthy();
    expect(screen.queryByTitle('ipv4-addr: 10.0.0.5')).toBeNull();
    expect(document.querySelectorAll('section')).toHaveLength(1);
  });

  it('changes the type and switches tabs', () => {
    const props = renderView();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'phishing' } });
    expect(props.onUpdate).toHaveBeenCalledWith('f1', { incidentType: 'phishing' });
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getByRole('tab', { name: 'Evidence' }).getAttribute('aria-selected')).toBe('true');
  });

  it('offers layout editing to admins only', () => {
    renderView();
    expect(screen.queryByText(/editLayout|Edit layout/)).toBeNull();
    document.body.innerHTML = '';
    const props = renderView({ canEditLayouts: true, folder: { ...folder, incidentType: 'phishing' } });
    fireEvent.click(screen.getByText(/editLayout|Edit layout/));
    expect(props.onEditLayout).toHaveBeenCalledWith('phishing');
  });

  it('asks to open an investigation when none is selected', () => {
    renderView({ folder: undefined });
    expect(screen.getByText(/noInvestigation|No investigation selected/)).toBeTruthy();
  });
});
