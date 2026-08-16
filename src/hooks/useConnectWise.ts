import { useCallback, useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { db } from '../db';
import type { ConnectWiseSettings, Folder, IncidentSeverity, Settings } from '../types';
import {
  hasCompleteCredentials,
  connectWiseHost,
  defaultTicketConditions,
  type ConnectWiseCredentials,
} from '../lib/connectwise';
import { fetchTickets, testConnection, ConnectWiseError } from '../lib/connectwise-client';
import {
  planTicketIntake,
  folderFieldsFromTicket,
  folderUpdatesFromTicket,
  caseUpdateFromTicket,
  type TicketIntakePlan,
} from '../lib/connectwise-tickets';
import type { ServerProxyConfig } from '../lib/proxy-fetch';

export interface TicketIntakeSummary {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * ConnectWise Manage connection state and the operations that use it.
 *
 * Credentials live in Settings rather than a dedicated table — they are one
 * connection, not a collection, and Settings already rides the backup path.
 */
export function useConnectWise(
  settings: Settings,
  onUpdateSettings: (updates: Partial<Settings>) => void | Promise<void>,
  serverProxy?: ServerProxyConfig,
) {
  const [busy, setBusy] = useState<false | 'test' | 'tickets'>(false);

  const config = settings.connectWise;

  const credentials = useMemo<ConnectWiseCredentials | undefined>(() => {
    if (!hasCompleteCredentials(config)) return undefined;
    return {
      site: config.site,
      companyId: config.companyId,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
      clientId: config.clientId,
    };
  }, [config]);

  const configured = credentials != null && config?.enabled === true;

  /** Host the extension must be allowed to proxy to. */
  const host = useMemo(() => {
    if (!config?.site?.trim()) return undefined;
    try {
      return connectWiseHost(config.site);
    } catch {
      return undefined;
    }
  }, [config?.site]);

  const patchConfig = useCallback(
    (updates: Partial<ConnectWiseSettings>) => {
      const base: ConnectWiseSettings = config ?? {
        enabled: false, site: '', companyId: '', publicKey: '', privateKey: '', clientId: '',
      };
      return onUpdateSettings({ connectWise: { ...base, ...updates } });
    },
    [config, onUpdateSettings],
  );

  /** Verify the credentials with the cheapest authenticated call CW offers. */
  const testCredentials = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!credentials) return { ok: false, error: 'ConnectWise connection is not fully configured.' };
    setBusy('test');
    try {
      await testConnection(credentials, { server: serverProxy });
      await patchConfig({ lastError: undefined });
      return { ok: true };
    } catch (err) {
      const message = err instanceof ConnectWiseError ? err.message : String(err);
      await patchConfig({ lastError: message });
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }, [credentials, serverProxy, patchConfig]);

  /**
   * Work out what a ticket pull would do, without writing anything.
   *
   * Always run before `applyTicketPlan` — a board condition that matches more
   * than intended would otherwise open hundreds of investigations before the
   * analyst saw a single one.
   */
  const planTickets = useCallback(async (
    folders: Folder[],
    opts: { conditions?: string; minSeverity?: IncidentSeverity } = {},
  ): Promise<TicketIntakePlan> => {
    if (!credentials) throw new ConnectWiseError('ConnectWise connection is not fully configured.');
    setBusy('tickets');
    try {
      const conditions = opts.conditions ?? defaultTicketConditions(config?.ticketBoard);
      const { items } = await fetchTickets(credentials, conditions, { server: serverProxy });
      return planTicketIntake(items, folders, { minSeverity: opts.minSeverity });
    } finally {
      setBusy(false);
    }
  }, [credentials, serverProxy, config?.ticketBoard]);

  /**
   * Write an approved plan.
   *
   * Each ticket also lands a case-log entry attributed to ConnectWise, so the
   * investigation records where it came from and what the PSA changed since.
   */
  const applyTicketPlan = useCallback(async (
    plan: TicketIntakePlan,
    accepted?: Set<string>,
  ): Promise<TicketIntakeSummary> => {
    const now = Date.now();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const maxOrder = (await db.folders.toArray()).reduce((max, f) => Math.max(max, f.order), 0);
    let order = maxOrder;

    for (const item of plan.items) {
      if (item.action === 'unchanged') { skipped++; continue; }
      if (accepted && !accepted.has(item.ticketId)) { skipped++; continue; }

      if (item.action === 'create') {
        order += 1;
        const folder: Folder = {
          id: nanoid(),
          order,
          createdAt: now,
          updatedAt: now,
          status: 'active',
          ...folderFieldsFromTicket(item.draft),
        } as Folder;
        await db.folders.add(folder);
        await db.caseUpdates.add({ id: nanoid(), ...caseUpdateFromTicket(item, folder.id, now) });
        created++;
      } else if (item.existing) {
        const updates = folderUpdatesFromTicket(item.draft, item.changes);
        await db.folders.update(item.existing.id, { ...updates, updatedAt: now });
        await db.caseUpdates.add({ id: nanoid(), ...caseUpdateFromTicket(item, item.existing.id, now) });
        updated++;
      }
    }

    await patchConfig({ lastTicketSyncAt: now });
    return { created, updated, skipped };
  }, [patchConfig]);

  return {
    config,
    credentials,
    configured,
    host,
    busy,
    patchConfig,
    testCredentials,
    planTickets,
    applyTicketPlan,
  };
}
