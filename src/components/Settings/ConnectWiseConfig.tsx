import { useCallback, useState } from 'react';
import {
  ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Loader2,
  Plug, RefreshCw, Ticket,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '../../types';
import { useConnectWise } from '../../hooks/useConnectWise';
import { useToast } from '../../contexts/ToastContext';

interface ConnectWiseConfigProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => void;
  /** Runs a configuration sync; supplied by the app so it can refresh assets. */
  onSyncConfigurations?: () => Promise<void>;
  /** Opens the ticket intake review; supplied by the app so it can show a plan. */
  onPullTickets?: () => Promise<void>;
}

const inputClass =
  'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent';

export function ConnectWiseConfig({
  settings,
  onUpdateSettings,
  onSyncConfigurations,
  onPullTickets,
}: ConnectWiseConfigProps) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState<false | 'assets' | 'tickets'>(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const { config, configured, credentials, busy, patchConfig } = useConnectWise(settings, onUpdateSettings);
  const cw = config;

  const handleTest = useCallback(async () => {
    setResult(null);
    // Import lazily so the settings bundle does not pull the client in for
    // users who never configure ConnectWise.
    const { testConnection, ConnectWiseError } = await import('../../lib/connectwise-client');
    if (!credentials) {
      setResult({ ok: false, msg: t('connectwise.incomplete') });
      return;
    }
    try {
      await testConnection(credentials);
      await patchConfig({ lastError: undefined });
      setResult({ ok: true, msg: t('connectwise.testOk') });
    } catch (err) {
      const msg = err instanceof ConnectWiseError ? err.message : String(err);
      await patchConfig({ lastError: msg });
      setResult({ ok: false, msg });
    }
  }, [credentials, patchConfig, t]);

  const runSync = useCallback(async () => {
    if (!onSyncConfigurations) return;
    setSyncing('assets');
    try {
      await onSyncConfigurations();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [onSyncConfigurations, addToast]);

  const runTickets = useCallback(async () => {
    if (!onPullTickets) return;
    setSyncing('tickets');
    try {
      await onPullTickets();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [onPullTickets, addToast]);

  const field = (
    key: 'site' | 'companyId' | 'publicKey' | 'privateKey' | 'clientId',
    type: 'text' | 'password',
    placeholder?: string,
  ) => (
    <div>
      <label htmlFor={`cw-${key}`} className="block text-xs font-medium text-gray-400 mb-1">
        {t(`connectwise.${key}`)}
      </label>
      <input
        id={`cw-${key}`}
        type={type}
        autoComplete="off"
        value={cw?.[key] ?? ''}
        onChange={(e) => patchConfig({ [key]: e.target.value })}
        className={inputClass}
        placeholder={placeholder}
      />
      <p className="text-[10px] text-gray-500 mt-1">{t(`connectwise.${key}Help`)}</p>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-300 hover:text-gray-100 transition-colors"
        >
          <Plug size={16} />
          {t('connectwise.title')}
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span className="text-xs text-gray-500">
          {configured ? t('connectwise.statusConnected') : t('connectwise.statusNotConfigured')}
        </span>
      </div>

      {expanded && (
        <div className="space-y-4 ps-1">
          <p className="text-xs text-gray-500">{t('connectwise.description')}</p>

          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              checked={cw?.enabled ?? false}
              onChange={(e) => patchConfig({ enabled: e.target.checked })}
              className="accent-accent-blue"
            />
            {t('connectwise.enable')}
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            {field('site', 'text', 'api-eu.myconnectwise.net')}
            {field('companyId', 'text', 'acme')}
            {field('publicKey', 'text')}
            {field('privateKey', 'password')}
            {field('clientId', 'password')}
          </div>

          <div>
            <label htmlFor="cw-mssp" className="block text-xs font-medium text-gray-400 mb-1">
              {t('connectwise.msspIdentifiers')}
            </label>
            <input
              id="cw-mssp"
              type="text"
              value={(cw?.msspIdentifiers ?? []).join(', ')}
              onChange={(e) =>
                patchConfig({
                  msspIdentifiers: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              className={inputClass}
              placeholder="nuage, nuage-internal"
            />
            <p className="text-[10px] text-gray-500 mt-1">{t('connectwise.msspIdentifiersHelp')}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="cw-conditions" className="block text-xs font-medium text-gray-400 mb-1">
                {t('connectwise.configurationConditions')}
              </label>
              <input
                id="cw-conditions"
                type="text"
                value={cw?.configurationConditions ?? ''}
                onChange={(e) => patchConfig({ configurationConditions: e.target.value })}
                className={inputClass}
                placeholder='status/name="Active"'
              />
              <p className="text-[10px] text-gray-500 mt-1">{t('connectwise.configurationConditionsHelp')}</p>
            </div>
            <div>
              <label htmlFor="cw-board" className="block text-xs font-medium text-gray-400 mb-1">
                {t('connectwise.ticketBoard')}
              </label>
              <input
                id="cw-board"
                type="text"
                value={cw?.ticketBoard ?? ''}
                onChange={(e) => patchConfig({ ticketBoard: e.target.value })}
                className={inputClass}
                placeholder="Security"
              />
              <p className="text-[10px] text-gray-500 mt-1">{t('connectwise.ticketBoardHelp')}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleTest}
              disabled={!credentials || busy === 'test'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium disabled:opacity-50"
            >
              {busy === 'test' ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              {t('connectwise.testConnection')}
            </button>

            {onSyncConfigurations && (
              <button
                onClick={runSync}
                disabled={!configured || syncing !== false}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 text-xs font-medium disabled:opacity-50"
              >
                {syncing === 'assets' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('connectwise.syncConfigurations')}
              </button>
            )}

            {onPullTickets && (
              <button
                onClick={runTickets}
                disabled={!configured || syncing !== false}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 text-xs font-medium disabled:opacity-50"
              >
                {syncing === 'tickets' ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />}
                {t('connectwise.pullTickets')}
              </button>
            )}
          </div>

          {result && (
            <div
              className={`flex items-start gap-2 p-2 rounded-lg text-xs ${
                result.ok ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'
              }`}
            >
              {result.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
              <span>{result.msg}</span>
            </div>
          )}

          {cw?.lastError && !result && (
            <div className="flex items-start gap-2 p-2 rounded-lg bg-red-500/10 text-red-300 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{cw.lastError}</span>
            </div>
          )}

          {cw?.lastConfigurationSyncAt && (
            <p className="text-[10px] text-gray-500">
              {t('connectwise.lastSync', { when: new Date(cw.lastConfigurationSyncAt).toLocaleString() })}
            </p>
          )}

          <p className="text-[10px] text-gray-500">{t('connectwise.transportNote')}</p>
        </div>
      )}
    </div>
  );
}
