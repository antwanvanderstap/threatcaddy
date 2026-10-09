import { useCallback, useEffect, useState } from 'react';
import type { IncidentType } from '../types';
import {
  createIncidentType,
  deleteIncidentType,
  fetchIncidentTypes,
  updateIncidentType,
  type IncidentTypeChanges,
} from '../lib/server-api';

const CACHE_PREFIX = 'tc-incident-types:';
const REFRESH_MS = 5 * 60_000;

function sortTypes(types: IncidentType[]): IncidentType[] {
  return types.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function readCache(serverUrl: string | null): IncidentType[] {
  if (!serverUrl) return [];
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + serverUrl);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as IncidentType[] : [];
  } catch {
    return [];
  }
}

function writeCache(serverUrl: string | null, types: IncidentType[]) {
  if (!serverUrl) return;
  try { localStorage.setItem(CACHE_PREFIX + serverUrl, JSON.stringify(types)); } catch { /* storage full or blocked */ }
}

/**
 * Team-wide incident types from the team server. Cached per server so
 * layouts still render offline; refreshed on connect, on window focus and
 * every few minutes, since admins edit them from other browsers. Without a
 * server there are no types and every investigation uses the default layout.
 */
export function useIncidentTypes(connected: boolean, serverUrl: string | null) {
  const [types, setTypes] = useState<IncidentType[]>(() => readCache(serverUrl));
  const [error, setError] = useState<string | undefined>();

  const store = useCallback((next: IncidentType[]) => {
    const sorted = sortTypes(next);
    setTypes(sorted);
    writeCache(serverUrl, sorted);
  }, [serverUrl]);

  const reload = useCallback(async () => {
    if (!connected) return;
    try {
      store(await fetchIncidentTypes());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [connected, store]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTypes(readCache(serverUrl));
  }, [serverUrl]);

  useEffect(() => {
    if (!connected) return;
    void reload();
    const timer = setInterval(() => { void reload(); }, REFRESH_MS);
    const onFocus = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [connected, reload]);

  const create = useCallback(async (input: IncidentTypeChanges & { name: string }) => {
    const created = await createIncidentType(input);
    setTypes((prev) => {
      const next = sortTypes([...prev.filter((t) => t.id !== created.id), created]);
      writeCache(serverUrl, next);
      return next;
    });
    return created;
  }, [serverUrl]);

  const update = useCallback(async (id: string, changes: IncidentTypeChanges) => {
    const updated = await updateIncidentType(id, changes);
    setTypes((prev) => {
      const next = sortTypes(prev.map((t) => (t.id === id ? updated : t)));
      writeCache(serverUrl, next);
      return next;
    });
    return updated;
  }, [serverUrl]);

  const remove = useCallback(async (id: string) => {
    await deleteIncidentType(id);
    setTypes((prev) => {
      const next = prev.filter((t) => t.id !== id);
      writeCache(serverUrl, next);
      return next;
    });
  }, [serverUrl]);

  return { types, error, reload, create, update, remove };
}
