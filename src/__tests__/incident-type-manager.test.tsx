import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IncidentTypeManager, type IncidentTypeManagerProps } from '../components/Settings/IncidentTypeManager';
import type { IncidentType } from '../types';

const addToast = vi.fn();
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ addToast, toasts: [], removeToast: vi.fn() }),
}));

const phishing: IncidentType = {
  id: 'phishing', name: 'Phishing', description: 'Phish', color: null, attackTechniques: ['T1566'],
  defaultPlaybookId: null, layout: null, order: 10, createdAt: 0, updatedAt: 0,
};

function renderManager(overrides: Partial<IncidentTypeManagerProps> = {}) {
  const props: IncidentTypeManagerProps = {
    types: [phishing], connected: true, canEdit: true, playbooks: [],
    onCreate: vi.fn(async (input) => ({ ...phishing, id: 'new', name: input.name })),
    onUpdate: vi.fn(async (id, changes) => ({ ...phishing, ...changes, id })),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  };
  render(<IncidentTypeManager {...props} />);
  return props;
}

describe('IncidentTypeManager', () => {
  it('needs a team server when there are no types', () => {
    renderManager({ types: [], connected: false });
    expect(screen.getByText(/needsServer|team server/)).toBeTruthy();
  });

  it('is read-only for non-admins', () => {
    renderManager({ canEdit: false });
    expect((screen.getByDisplayValue('Phishing') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(/incidentTypes.save|^Save$/)).toBeNull();
  });

  it('saves only what changed, including a customized layout', async () => {
    const props = renderManager();
    fireEvent.change(screen.getByDisplayValue('T1566'), { target: { value: 't1566, T1566.002' } });
    fireEvent.click(screen.getByText(/incidentTypes.customize|Customize layout/));
    fireEvent.click(screen.getByText(/incidentTypes.save|^Save$/));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled());
    const [id, changes] = (props.onUpdate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe('phishing');
    expect(Object.keys(changes).sort()).toEqual(['attackTechniques', 'layout']);
    expect(changes.attackTechniques).toEqual(['T1566', 'T1566.002']);
    expect(changes.layout.tabs.map((t: { id: string }) => t.id)).toEqual(['summary', 'work', 'evidence']);
  });

  it('blocks saving malformed technique ids', () => {
    renderManager();
    fireEvent.change(screen.getByDisplayValue('T1566'), { target: { value: 'phishing' } });
    expect(screen.getByText(/badTechniques|Not technique ids/)).toBeTruthy();
    expect((screen.getByText(/incidentTypes.save|^Save$/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reports a refused delete', async () => {
    renderManager({ onDelete: vi.fn(async () => { throw new Error('Incident type is used by 3 investigation(s)'); }) });
    fireEvent.click(screen.getByText(/incidentTypes.delete|Delete type/));
    const confirm = screen.getAllByText(/incidentTypes.delete|Delete type/).at(-1)!;
    fireEvent.click(confirm);
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('error', 'Incident type is used by 3 investigation(s)'));
  });
});
