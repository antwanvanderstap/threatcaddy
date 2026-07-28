import { useState } from 'react';
import { Building2, Loader2, Users, X } from 'lucide-react';
import type { AssetOwnerType } from '../../types';
import { cn } from '../../lib/utils';
import type { OwnerFilter } from '../../lib/asset-ownership';

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Short badge for an asset's owner, used in the inventory table. */
export function OwnerBadge({ owner, customerName, t }: {
  owner: AssetOwnerType | undefined;
  customerName?: string;
  t: T;
}) {
  const type = owner ?? 'unknown';
  if (type === 'mssp') {
    return (
      <span className="inline-flex items-center gap-1 text-accent-blue">
        <Building2 size={11} />
        {t('owner.mssp')}
      </span>
    );
  }
  if (type === 'customer') {
    return (
      <span className="inline-flex items-center gap-1">
        <Users size={11} className="text-accent-green" />
        {customerName?.trim() || t('owner.unnamedCustomer')}
      </span>
    );
  }
  return <span className="text-text-muted">{t('owner.unknown')}</span>;
}

/** Dropdown that scopes a view to the MSSP, a specific customer, or everything. */
export function OwnerFilterSelect({ value, customers, onChange, t }: {
  value: OwnerFilter;
  customers: string[];
  onChange: (next: OwnerFilter) => void;
  t: T;
}) {
  const serialized = typeof value === 'object' ? `customer:${value.customerName}` : value;
  return (
    <select
      value={serialized}
      aria-label={t('owner.filterLabel')}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw.startsWith('customer:')
          ? { customerName: raw.slice('customer:'.length) }
          : (raw as OwnerFilter));
      }}
      className="text-xs rounded border border-border-subtle bg-bg-input px-2 py-1"
    >
      <option value="all">{t('owner.filterAll')}</option>
      <option value="mssp">{t('owner.mssp')}</option>
      <option value="customer">{t('owner.allCustomers')}</option>
      {customers.map((name) => (
        <option key={name} value={`customer:${name}`}>{name}</option>
      ))}
      <option value="unknown">{t('owner.unknown')}</option>
    </select>
  );
}

interface OwnerPickerProps {
  owner: AssetOwnerType;
  customerName: string;
  onOwnerChange: (owner: AssetOwnerType) => void;
  onCustomerNameChange: (name: string) => void;
  customers: string[];
  t: T;
}

/** Shared owner + customer-name inputs, used by both import and bulk assign. */
function OwnerPicker({
  owner, customerName, onOwnerChange, onCustomerNameChange, customers, t,
}: OwnerPickerProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        {(['mssp', 'customer', 'unknown'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onOwnerChange(value)}
            className={cn(
              'px-2.5 py-1.5 text-xs rounded border',
              owner === value
                ? 'border-accent-blue text-accent-blue bg-accent-blue/10'
                : 'border-border-subtle hover:bg-bg-hover',
            )}
          >
            {t(`owner.${value === 'mssp' ? 'mssp' : value === 'customer' ? 'customer' : 'unknown'}`)}
          </button>
        ))}
      </div>

      {owner === 'customer' && (
        <div>
          <label className="text-xs text-text-muted" htmlFor="owner-customer-name">
            {t('owner.customerNameLabel')}
          </label>
          <input
            id="owner-customer-name"
            list="owner-known-customers"
            value={customerName}
            onChange={(e) => onCustomerNameChange(e.target.value)}
            placeholder={t('owner.customerNamePlaceholder')}
            className="mt-1 w-full text-xs rounded border border-border-subtle bg-bg-input px-2 py-1.5"
          />
          <datalist id="owner-known-customers">
            {customers.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>
      )}
    </div>
  );
}

/**
 * Asks whose inventory a file is before importing it.
 *
 * A CMDB export carries no organization column, so ownership cannot be
 * inferred — stating it once per file labels every row in that import.
 */
export function ImportOwnerDialog({ customers, onCancel, onConfirm, t }: {
  customers: string[];
  onCancel: () => void;
  onConfirm: (owner: AssetOwnerType, customerName?: string) => void;
  t: T;
}) {
  const [owner, setOwner] = useState<AssetOwnerType>('mssp');
  const [customerName, setCustomerName] = useState('');
  const blocked = owner === 'customer' && !customerName.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded border border-border-subtle bg-bg-primary shadow-lg">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold flex-1">{t('owner.importTitle')}</h2>
          <button type="button" onClick={onCancel} aria-label={t('actions.dismiss')}>
            <X size={14} className="text-text-muted hover:text-text-primary" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-text-muted">{t('owner.importDesc')}</p>
          <OwnerPicker
            owner={owner}
            customerName={customerName}
            onOwnerChange={setOwner}
            onCustomerNameChange={setCustomerName}
            customers={customers}
            t={t}
          />
        </div>

        <div className="flex items-center justify-end gap-1.5 px-4 py-3 border-t border-border-subtle">
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover"
          >
            {t('owner.cancel')}
          </button>
          <button
            type="button"
            disabled={blocked}
            onClick={() => onConfirm(owner, customerName)}
            className="px-3 py-1.5 text-xs rounded bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('owner.chooseFile')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Assigns ownership to every asset currently in view.
 *
 * Filter-driven rather than checkbox-driven so a whole tenant can be labelled
 * in one action — search a naming prefix, confirm the count, assign.
 */
export function BulkOwnerBar({ count, customers, onAssign, t }: {
  count: number;
  customers: string[];
  onAssign: (owner: AssetOwnerType, customerName?: string) => Promise<void>;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState<AssetOwnerType>('customer');
  const [customerName, setCustomerName] = useState('');
  const [busy, setBusy] = useState(false);

  const blocked = busy || (owner === 'customer' && !customerName.trim());

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-2 py-1 text-xs rounded border border-border-subtle hover:bg-bg-hover"
      >
        {t('owner.assignButton', { count })}
      </button>
    );
  }

  return (
    <div className="flex items-start gap-2 p-2 rounded border border-accent-blue/40 bg-accent-blue/5">
      <div className="space-y-2">
        <p className="text-xs">{t('owner.assignPrompt', { count })}</p>
        <OwnerPicker
          owner={owner}
          customerName={customerName}
          onOwnerChange={setOwner}
          onCustomerNameChange={setCustomerName}
          customers={customers}
          t={t}
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              try {
                await onAssign(owner, customerName);
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent-blue text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t('owner.assignConfirm', { count })}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-2.5 py-1.5 text-xs rounded border border-border-subtle hover:bg-bg-hover"
          >
            {t('owner.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
