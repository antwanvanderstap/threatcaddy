import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InvestigationsHub, ticketLabel } from '../components/Investigations/InvestigationsHub';
import { InvestigationTable, type InvestigationRow } from '../components/Investigations/InvestigationTable';
import { AlertStack, isAlertNote } from '../components/Notes/AlertStack';
import type { InvestigationSummary, Note } from '../types';

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn(), toasts: [], removeToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ connected: false, user: null, serverUrl: null }),
}));

const row: InvestigationRow = {
  folderId: 'row-1',
  caseNumber: 'NAG-0042',
  ticket: 'CW #214033',
  alertCount: 7,
  name: 'Account locked out: VHQ-NAMS-DC1$',
  status: 'active',
  entityCounts: { notes: 0, tasks: 0, iocs: 0, events: 0, whiteboards: 0, chats: 0 },
  dataMode: 'remote',
};

function alert(id: string, title: string, createdAt: number, tags: string[]): Note {
  return { id, title, content: '', createdAt, updatedAt: createdAt, tags, pinned: false, archived: false, trashed: false } as Note;
}

describe('ticketLabel', () => {
  it('prefers the ConnectWise ticket, then the Stellar case', () => {
    expect(ticketLabel({ stellar: '12011', connectwise: '214015' })).toBe('CW #214015');
    expect(ticketLabel({ stellar: '12011', stellar_id: 'abc' })).toBe('Stellar #12011');
    expect(ticketLabel({ sentinelone_threat: '9' })).toBe('sentinelone_threat #9');
    expect(ticketLabel({})).toBeUndefined();
    expect(ticketLabel(null)).toBeUndefined();
  });
});

describe('investigation table', () => {
  it('shows the investigation number, ticket and alert count beside a plain name', () => {
    render(<InvestigationTable rows={[row]} onOpen={vi.fn()} />);
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('NAG-0042');
    expect(cells[1]).toHaveTextContent('Account locked out: VHQ-NAMS-DC1$');
    expect(cells[1]).not.toHaveTextContent('[');
    expect(cells[2]).toHaveTextContent('CW #214033');
    expect(cells[3]).toHaveTextContent('7');
  });

  it('maps the server summary into those columns', () => {
    const summary: InvestigationSummary = {
      folderId: 'remote-1', role: 'editor', joinedAt: '2026-10-08T00:00:00Z',
      folder: {
        name: 'Internal Credential Stuffing', status: 'active', caseNumber: 'MJX-0007', customerCode: 'MJX',
        externalRefs: { connectwise: '214015', stellar: '12011' },
        createdAt: '2026-10-08T05:30:00Z', updatedAt: '2026-10-08T05:30:00Z',
      },
      alertCount: 2,
      entityCounts: { notes: 2, tasks: 0, iocs: 0, events: 0, whiteboards: 0, chats: 0 },
      memberCount: 3,
    };
    render(<InvestigationsHub localFolders={[]} remoteInvestigations={[summary]} syncedFolderIds={new Set()}
      serverConnected localLoading={false} remoteLoading={false} onOpenInvestigation={vi.fn()} onSyncLocally={vi.fn()}
      onUnsync={vi.fn()} onCreateInvestigation={vi.fn()} />);
    expect(screen.getByText('MJX-0007')).toBeInTheDocument();
    expect(screen.getByText('CW #214015')).toBeInTheDocument();
  });
});

describe('alert stack', () => {
  const alerts = [
    alert('a1', 'Account locked out', 1_000, ['alert', 'source:connectwise', 'severity:medium', 'ref:connectwise:214033']),
    alert('a2', 'Internal Credential Stuffing', 2_000, ['alert', 'source:stellar', 'severity:high', 'ref:stellar:12011', 'ref:stellar_id:abc']),
  ];

  it('recognises ingested alerts but not other or trashed notes', () => {
    expect(isAlertNote(alerts[0])).toBe(true);
    expect(isAlertNote(alert('n', 'Notes', 0, ['triage']))).toBe(false);
    expect(isAlertNote({ ...alerts[0], trashed: true })).toBe(false);
  });

  it('lists alerts newest first with their source and ticket, and opens one on click', () => {
    const onSelect = vi.fn();
    render(<AlertStack alerts={alerts} onSelect={onSelect} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Internal Credential Stuffing');
    expect(items[0]).toHaveTextContent('stellar · Stellar #12011');
    expect(items[1]).toHaveTextContent('connectwise · CW #214033');
    fireEvent.click(within(items[1]).getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('renders nothing without alerts', () => {
    const { container } = render(<AlertStack alerts={[]} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
