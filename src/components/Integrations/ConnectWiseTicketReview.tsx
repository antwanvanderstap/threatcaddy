import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Ticket, AlertTriangle } from 'lucide-react';
import { Modal } from '../Common/Modal';
import type { TicketIntakePlan } from '../../lib/connectwise-tickets';

interface ConnectWiseTicketReviewProps {
  open: boolean;
  onClose: () => void;
  /** Null while the plan is still being fetched. */
  plan: TicketIntakePlan | null;
  loading: boolean;
  error?: string;
  onApply: (accepted: Set<string>) => Promise<void>;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  medium: 'text-amber-400',
  low: 'text-sky-400',
  none: 'text-gray-500',
};

/**
 * Review step between fetching ConnectWise tickets and writing them.
 *
 * Nothing is written until the analyst confirms: a board condition that matches
 * more than intended would otherwise create investigations in bulk, and
 * investigations are far more annoying to unpick than they are to create.
 */
export function ConnectWiseTicketReview({
  open, onClose, plan, loading, error, onApply,
}: ConnectWiseTicketReviewProps) {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation('common');
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  // Actionable items start selected — the common case is accepting the plan,
  // and the analyst deselects the exceptions.
  const actionable = useMemo(
    () => (plan?.items ?? []).filter((i) => i.action !== 'unchanged'),
    [plan],
  );

  useEffect(() => {
    setAccepted(new Set(actionable.map((i) => i.ticketId)));
  }, [actionable]);

  const toggle = (id: string) => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      await onApply(accepted);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('connectwise.ticketReviewTitle')} wide>
      <div className="space-y-3 max-h-[70vh] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-400 py-6 justify-center">
            <Loader2 size={16} className="animate-spin" />
            {t('connectwise.ticketsLoading')}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-red-500/10 text-red-300 text-xs">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {plan && !loading && (
          <>
            <p className="text-xs text-gray-400">
              {t('connectwise.ticketPlanSummary', {
                create: plan.toCreate,
                update: plan.toUpdate,
                unchanged: plan.unchanged,
              })}
            </p>

            {actionable.length === 0 && (
              <p className="text-xs text-gray-500 italic py-4 text-center">
                {t('connectwise.ticketsNothingToDo')}
              </p>
            )}

            {actionable.map((item) => (
              <label
                key={item.ticketId}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/50 border border-gray-700/50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={accepted.has(item.ticketId)}
                  onChange={() => toggle(item.ticketId)}
                  className="mt-1 accent-accent-blue"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Ticket size={13} className="text-gray-500 shrink-0" />
                    <span className="text-sm text-gray-200 truncate">{item.draft.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded bg-gray-900/60 ${SEVERITY_COLOR[item.draft.severity] ?? 'text-gray-500'}`}>
                      {item.draft.severity}
                    </span>
                    <span className="text-gray-500">
                      {item.action === 'create'
                        ? t('connectwise.willCreate')
                        : t('connectwise.willUpdate')}
                    </span>
                    {item.draft.companyName && (
                      <span className="text-gray-500">{item.draft.companyName}</span>
                    )}
                    {item.draft.boardName && (
                      <span className="text-gray-600">{item.draft.boardName}</span>
                    )}
                  </div>
                  {item.changes.length > 0 && (
                    <div className="mt-1 text-[10px] text-gray-500">
                      {item.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join(' · ')}
                    </div>
                  )}
                </div>
              </label>
            ))}
          </>
        )}

        <div className="flex justify-end gap-3 pt-2 sticky bottom-0 bg-gray-900 py-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm"
          >
            {tc('cancel')}
          </button>
          <button
            onClick={handleApply}
            disabled={applying || accepted.size === 0}
            className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1.5"
          >
            {applying && <Loader2 size={14} className="animate-spin" />}
            {t('connectwise.applyPlan', { count: accepted.size })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
