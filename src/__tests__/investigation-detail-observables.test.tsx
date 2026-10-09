import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvestigationDetailPanel } from '../components/Investigation/InvestigationDetailPanel';
import type { Folder, StandaloneIOC, IOCType } from '../types';

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn(), toasts: [], removeToast: vi.fn() }),
}));

const folder: Folder = { id: 'f1', name: 'Case', order: 0, createdAt: 1 } as Folder;

function ioc(id: string, type: IOCType, value: string, extra: Partial<StandaloneIOC> = {}): StandaloneIOC {
  return { id, type, value, confidence: 'medium', tags: [], trashed: false, archived: false, createdAt: 1, updatedAt: 1, folderId: 'f1', ...extra } as StandaloneIOC;
}

function renderPanel(observables?: StandaloneIOC[], onOpenObservables?: () => void) {
  return render(
    <InvestigationDetailPanel
      folder={folder}
      onUpdate={vi.fn()}
      onClose={vi.fn()}
      allTags={[]}
      onCreateTag={vi.fn()}
      entityCounts={{ notes: 0, tasks: 0, events: 0, whiteboards: 0 }}
      effectiveClsLevels={[]}
      observables={observables}
      onOpenObservables={onOpenObservables}
    />
  );
}

describe('InvestigationDetailPanel observed STIX objects', () => {
  it('shows observables as STIX objects above the description, deduplicated', () => {
    renderPanel([
      ioc('a', 'ipv4', '10.0.0.5'),
      ioc('b', 'ipv4', '10.0.0.5'),
      ioc('c', 'sha256', 'abc123'),
      ioc('d', 'mitre-attack', 'T1059'),
    ]);
    expect(screen.getAllByTitle('ipv4-addr: 10.0.0.5')).toHaveLength(1);
    expect(screen.getByTitle('file: abc123')).toBeTruthy();
    const attack = screen.getByTitle('attack-pattern: T1059');
    const description = document.querySelector('textarea');
    expect(description).not.toBeNull();
    expect(attack.compareDocumentPosition(description as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('collapses long lists and expands on request', () => {
    renderPanel(Array.from({ length: 15 }, (_, i) => ioc(`i${i}`, 'domain', `host${String(i).padStart(2, '0')}.example`)));
    expect(screen.queryByTitle('domain-name: host14.example')).toBeNull();
    fireEvent.click(screen.getByText(/15/, { selector: 'button' }));
    expect(screen.getByTitle('domain-name: host14.example')).toBeTruthy();
  });

  it('opens the IOC view', () => {
    const onOpen = vi.fn();
    renderPanel([ioc('a', 'url', 'https://evil.example/x')], onOpen);
    fireEvent.click(screen.getByText(/observablesOpen|Open IOCs/));
    expect(onOpen).toHaveBeenCalled();
  });

  it('omits the section when no observables are passed', () => {
    renderPanel(undefined);
    expect(screen.queryByText(/observablesLabel|Observed STIX objects/)).toBeNull();
  });
});
