import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvestigationsHub } from '../components/Investigations/InvestigationsHub';
import { InvestigationTable, type InvestigationRow } from '../components/Investigations/InvestigationTable';
import { CreateInvestigationModal } from '../components/Investigations/CreateInvestigationModal';
import type { Folder, InvestigationSummary } from '../types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn(), toasts: [], removeToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ connected: false, user: null, serverUrl: null }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'local-1',
    name: 'Op Falcon',
    order: 0,
    createdAt: Date.now(),
    status: 'active',
    ...overrides,
  };
}

function makeRemoteSummary(overrides: Partial<InvestigationSummary> = {}): InvestigationSummary {
  return {
    folderId: 'remote-1',
    role: 'editor',
    joinedAt: '2024-01-01T00:00:00Z',
    folder: {
      name: 'Shared Investigation',
      status: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    },
    entityCounts: { notes: 3, tasks: 2, iocs: 1, events: 0, whiteboards: 0, chats: 0 },
    memberCount: 3,
    ...overrides,
  };
}

const defaultHubProps = {
  localFolders: [] as Folder[],
  remoteInvestigations: [] as InvestigationSummary[],
  syncedFolderIds: new Set<string>(),
  serverConnected: true,
  localLoading: false,
  remoteLoading: false,
  onOpenInvestigation: vi.fn(),
  onSyncLocally: vi.fn(),
  onUnsync: vi.fn(),
  onCreateInvestigation: vi.fn(),
  onEditInvestigation: vi.fn(),
  onArchiveInvestigation: vi.fn(),
  onDeleteInvestigation: vi.fn(),
};

// ── InvestigationsHub ─────────────────────────────────────────────────────────

describe('InvestigationsHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "My Investigations" section with local folder cards', () => {
    render(
      <InvestigationsHub
        {...defaultHubProps}
        localFolders={[makeFolder()]}
      />
    );
    expect(screen.getByText('My Investigations')).toBeInTheDocument();
    expect(screen.getByText('Op Falcon')).toBeInTheDocument();
  });

  it('renders "Shared With Me" section with remote investigation cards', () => {
    render(
      <InvestigationsHub
        {...defaultHubProps}
        remoteInvestigations={[makeRemoteSummary()]}
      />
    );
    expect(screen.getByText('Shared With Me')).toBeInTheDocument();
    expect(screen.getByText('Shared Investigation')).toBeInTheDocument();
  });

  it('shows skeleton cards when loading', () => {
    const { container } = render(
      <InvestigationsHub
        {...defaultHubProps}
        localLoading={true}
        remoteLoading={true}
      />
    );
    // Skeleton cards use animate-pulse class
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('shows disconnected banner when serverConnected is false', () => {
    render(
      <InvestigationsHub
        {...defaultHubProps}
        serverConnected={false}
      />
    );
    expect(screen.getByText(/Server disconnected/)).toBeInTheDocument();
  });

  it('shows empty state when no investigations', () => {
    render(<InvestigationsHub {...defaultHubProps} />);
    expect(screen.getByText('No local investigations')).toBeInTheDocument();
    expect(screen.getByText('No shared investigations — ask a team member to invite you')).toBeInTheDocument();
  });

  it('calls onCreateInvestigation when "New Investigation" button clicked', () => {
    const onCreate = vi.fn();
    render(
      <InvestigationsHub
        {...defaultHubProps}
        onCreateInvestigation={onCreate}
      />
    );
    fireEvent.click(screen.getByText('New Investigation'));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('correctly partitions folders into local/synced/shared sections', () => {
    const localOnly = makeFolder({ id: 'local-1', name: 'Pure Local' });
    const syncedFolder = makeFolder({ id: 'synced-1', name: 'Synced Folder' });
    const remoteOnly = makeRemoteSummary({ folderId: 'remote-only', folder: { name: 'Remote Only', status: 'active', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' } });
    const remoteForSynced = makeRemoteSummary({ folderId: 'synced-1', folder: { name: 'Synced Remote', status: 'active', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' } });

    render(
      <InvestigationsHub
        {...defaultHubProps}
        localFolders={[localOnly, syncedFolder]}
        remoteInvestigations={[remoteOnly, remoteForSynced]}
        syncedFolderIds={new Set(['synced-1'])}
      />
    );

    // Pure Local should be in My Investigations
    expect(screen.getByText('Pure Local')).toBeInTheDocument();
    // Synced Folder should be in Synced Investigations
    expect(screen.getByText('Synced Folder')).toBeInTheDocument();
    // Remote Only should be in Shared With Me
    expect(screen.getByText('Remote Only')).toBeInTheDocument();
  });

  it('renders the "Create Investigation" button in empty state', () => {
    const onCreate = vi.fn();
    render(
      <InvestigationsHub
        {...defaultHubProps}
        onCreateInvestigation={onCreate}
      />
    );
    // There should be a "Create Investigation" button inside the empty state
    const createButtons = screen.getAllByText('Create Investigation');
    expect(createButtons.length).toBeGreaterThanOrEqual(1);
  });
});

// ── InvestigationTable ────────────────────────────────────────────────────────

describe('InvestigationTable', () => {
  const baseRow: InvestigationRow = {
    folderId: 'row-1',
    name: 'Op Thunder',
    status: 'active',
    entityCounts: { notes: 5, tasks: 3, iocs: 2, events: 1, whiteboards: 0, chats: 0 },
    dataMode: 'local',
  };

  const renderTable = (row: Partial<InvestigationRow> = {}, props: Partial<React.ComponentProps<typeof InvestigationTable>> = {}) =>
    render(<InvestigationTable rows={[{ ...baseRow, ...row }]} onOpen={vi.fn()} {...props} />);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a table row with name and status', () => {
    renderTable();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Op Thunder')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders entity counts', () => {
    renderTable();
    expect(screen.getByText('5')).toBeInTheDocument(); // notes
    expect(screen.getByText('3')).toBeInTheDocument(); // tasks
    expect(screen.getByText('2')).toBeInTheDocument(); // iocs
  });

  it('shows data mode badge (Local/Remote)', () => {
    const { unmount } = renderTable({ dataMode: 'local' });
    expect(screen.getByText('Local')).toBeInTheDocument();
    unmount();
    renderTable({ dataMode: 'remote' });
    expect(screen.getByText('Remote')).toBeInTheDocument();
  });

  it('shows severity and phase for incidents', () => {
    renderTable({ severity: 'high', irPhase: 'containment' });
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Containment')).toBeInTheDocument();
  });

  it('calls onOpen with folder id and data mode when a row is clicked', () => {
    const onOpen = vi.fn();
    renderTable({ dataMode: 'synced' }, { onOpen });
    fireEvent.click(screen.getByText('Op Thunder'));
    expect(onOpen).toHaveBeenCalledWith('row-1', 'synced');
  });

  it('context menu calls onSettings, onArchive, onDelete without opening the row', () => {
    const onOpen = vi.fn();
    const onSettings = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    renderTable({}, { onOpen, onSettings, onArchive, onDelete });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('Settings'));
    expect(onSettings).toHaveBeenCalledWith('row-1');

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('Archive'));
    expect(onArchive).toHaveBeenCalledWith('row-1');

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith('row-1');

    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Sync button calls onSync for remote rows', () => {
    const onSync = vi.fn();
    renderTable({ dataMode: 'remote' }, { onSync });
    fireEvent.click(screen.getByText('Sync'));
    expect(onSync).toHaveBeenCalledWith('row-1');
  });

  it('Unsync button calls onUnsync for synced rows', () => {
    const onUnsync = vi.fn();
    renderTable({ dataMode: 'synced' }, { onUnsync });
    fireEvent.click(screen.getByText('Unsync'));
    expect(onUnsync).toHaveBeenCalledWith('row-1');
  });

  it('shows member count, role and CLS level when provided', () => {
    renderTable({ dataMode: 'remote', memberCount: 5, role: 'viewer', clsLevel: 'TLP:AMBER' });
    expect(screen.getByText('5 members')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.getByText('TLP:AMBER')).toBeInTheDocument();
  });

  it('sorts by severity when the header is clicked', () => {
    render(
      <InvestigationTable
        onOpen={vi.fn()}
        rows={[
          { ...baseRow, folderId: 'a', name: 'Low one', severity: 'low' },
          { ...baseRow, folderId: 'b', name: 'Critical one', severity: 'critical' },
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Severity' }));
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(names[0]).toContain('Critical one');
    expect(names[1]).toContain('Low one');
  });
});

// ── CreateInvestigationModal ──────────────────────────────────────────────────

describe('CreateInvestigationModal', () => {
  const defaultModalProps = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onOpenNameGenerator: vi.fn(),
    onOpenPlaybookPicker: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders three tabs', () => {
    render(<CreateInvestigationModal {...defaultModalProps} />);
    expect(screen.getByText('Quick Create')).toBeInTheDocument();
    expect(screen.getByText('Name Generator')).toBeInTheDocument();
    expect(screen.getByText('From Playbook')).toBeInTheDocument();
  });

  it('Quick Create tab: creates investigation on Enter', async () => {
    const onCreate = vi.fn();
    render(<CreateInvestigationModal {...defaultModalProps} onCreate={onCreate} />);
    const input = screen.getByPlaceholderText('e.g. Operation Midnight Storm');
    await userEvent.type(input, 'Op Test{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Op Test');
  });

  it('Quick Create tab: disables button when name is empty', () => {
    render(<CreateInvestigationModal {...defaultModalProps} />);
    const createBtn = screen.getByText('Create Investigation');
    expect(createBtn).toBeDisabled();
  });

  it('Quick Create tab: enables button when name has content', async () => {
    render(<CreateInvestigationModal {...defaultModalProps} />);
    const input = screen.getByPlaceholderText('e.g. Operation Midnight Storm');
    await userEvent.type(input, 'Something');
    const createBtn = screen.getByText('Create Investigation');
    expect(createBtn).not.toBeDisabled();
  });

  it('Name Generator tab: calls onOpenNameGenerator when button clicked without closing modal', async () => {
    const onOpenNameGen = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateInvestigationModal
        {...defaultModalProps}
        onClose={onClose}
        onOpenNameGenerator={onOpenNameGen}
      />
    );
    // Switch to Name Generator tab
    fireEvent.click(screen.getByText('Name Generator'));
    fireEvent.click(screen.getByText('Open Name Generator'));
    expect(onOpenNameGen).toHaveBeenCalled();
    // Modal should NOT close (U1 fix: keep modal open)
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Playbook tab: calls onOpenPlaybookPicker when button clicked without closing modal', async () => {
    const onOpenPlaybook = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateInvestigationModal
        {...defaultModalProps}
        onClose={onClose}
        onOpenPlaybookPicker={onOpenPlaybook}
      />
    );
    // Switch to Playbook tab
    fireEvent.click(screen.getByText('From Playbook'));
    fireEvent.click(screen.getByText('Browse Playbooks'));
    expect(onOpenPlaybook).toHaveBeenCalled();
    // Modal should NOT close (U1 fix: keep modal open)
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing when open is false', () => {
    const { container } = render(
      <CreateInvestigationModal {...defaultModalProps} open={false} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('Quick Create: clicking Create Investigation button with valid name calls onCreate', async () => {
    const onCreate = vi.fn();
    render(<CreateInvestigationModal {...defaultModalProps} onCreate={onCreate} />);
    const input = screen.getByPlaceholderText('e.g. Operation Midnight Storm');
    await userEvent.type(input, 'My Investigation');
    fireEvent.click(screen.getByText('Create Investigation'));
    expect(onCreate).toHaveBeenCalledWith('My Investigation');
  });
});
