import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Crosshair,
  Info,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import type { Asset } from '../../types';
import { cn } from '../../lib/utils';
import { buildAttackSurface, assessApplicability, parseThreatInput } from '../../lib/attack-surface';
import type { ProductExposure } from '../../lib/attack-surface';
import { EOL_DATASET_VERIFIED_AT, type EolStatus } from '../../lib/asset-eol';

interface AttackSurfaceTabProps {
  assets: Asset[];
  /** Injected so the view is deterministic in tests and stable across renders. */
  now: number;
  onOpenAsset: (id: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const STATUS_STYLE: Record<EolStatus, { icon: typeof ShieldAlert; chip: string; dot: string }> = {
  eol: { icon: ShieldAlert, chip: 'bg-accent-red/15 text-accent-red border-accent-red/30', dot: 'bg-accent-red' },
  'extended-only': { icon: AlertTriangle, chip: 'bg-accent-amber/15 text-accent-amber border-accent-amber/30', dot: 'bg-accent-amber' },
  'ending-soon': { icon: CalendarClock, chip: 'bg-accent-amber/10 text-accent-amber border-accent-amber/20', dot: 'bg-accent-amber/70' },
  supported: { icon: ShieldCheck, chip: 'bg-accent-green/15 text-accent-green border-accent-green/30', dot: 'bg-accent-green' },
  unknown: { icon: ShieldQuestion, chip: 'bg-bg-secondary text-text-muted border-border-subtle', dot: 'bg-text-muted' },
};

const STATUS_ORDER: EolStatus[] = ['eol', 'extended-only', 'ending-soon', 'supported', 'unknown'];

export function AttackSurfaceTab({ assets, now, onOpenAsset, t }: AttackSurfaceTabProps) {
  const [threatInput, setThreatInput] = useState('');
  const [submitted, setSubmitted] = useState('');

  const surface = useMemo(() => buildAttackSurface(assets, now), [assets, now]);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const report = useMemo(() => {
    if (!submitted.trim()) return null;
    return assessApplicability(parseThreatInput(submitted), assets);
  }, [submitted, assets]);

  const totalAssets = surface.coveredAssetIds.length + surface.unidentifiedAssetIds.length;

  if (totalAssets === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <ShieldQuestion size={32} className="text-text-muted" />
        <p className="text-sm font-medium">{t('surface.empty')}</p>
        <p className="text-xs text-text-muted max-w-md">{t('surface.emptyDesc')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-4 space-y-5">
        {/* Posture summary */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('surface.postureTitle')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {STATUS_ORDER.map((status) => {
              const count = surface.counts[status];
              if (count === 0) return null;
              const style = STATUS_STYLE[status];
              const Icon = style.icon;
              return (
                <span key={status} className={cn('flex items-center gap-1.5 px-2 py-1 text-xs rounded border', style.chip)}>
                  <Icon size={12} />
                  <strong>{count}</strong>
                  {t(`surface.status.${status}`)}
                </span>
              );
            })}
          </div>
          <p className="text-xs text-text-muted">
            {t('surface.summary', {
              atRisk: surface.atRiskAssetIds.length,
              total: totalAssets,
              unidentified: surface.unidentifiedAssetIds.length,
            })}
          </p>
        </section>

        {/* Threat applicability */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('surface.applicabilityTitle')}
          </h2>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); setSubmitted(threatInput); }}
          >
            <div className="relative flex-1 max-w-xl">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={threatInput}
                onChange={(e) => setThreatInput(e.target.value)}
                placeholder={t('surface.applicabilityPlaceholder')}
                aria-label={t('surface.applicabilityPlaceholder')}
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded border border-border-subtle bg-bg-input"
              />
            </div>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent-blue text-white hover:opacity-90"
            >
              <Crosshair size={13} />
              {t('surface.check')}
            </button>
          </form>

          {report && (
            report.indeterminate ? (
              <p className="text-xs text-accent-amber">{t('surface.indeterminate')}</p>
            ) : report.affectedAssetIds.length === 0 ? (
              <p className="text-xs text-accent-green">{t('surface.notApplicable')}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs">
                  {t('surface.applicableCount', { count: report.affectedAssetIds.length })}
                  {report.descriptor.id && <span className="text-text-muted"> · {report.descriptor.id}</span>}
                </p>
                {report.matches[0]?.confidence === 'keyword' && (
                  <p className="text-xs text-accent-amber flex items-start gap-1.5">
                    <Info size={12} className="mt-0.5 shrink-0" />
                    {t('surface.keywordWarning')}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {report.affectedAssetIds.slice(0, 60).map((id) => {
                    const asset = assetById.get(id);
                    if (!asset) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onOpenAsset(id)}
                        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border-subtle hover:bg-bg-hover"
                      >
                        <Server size={11} />
                        {asset.name}
                      </button>
                    );
                  })}
                  {report.affectedAssetIds.length > 60 && (
                    <span className="text-xs text-text-muted self-center">
                      {t('surface.andMore', { count: report.affectedAssetIds.length - 60 })}
                    </span>
                  )}
                </div>
              </div>
            )
          )}
        </section>

        {/* Product exposure table */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('surface.exposureTitle')}
          </h2>
          <div className="border border-border-subtle rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-bg-secondary border-b border-border-subtle">
                <tr className="text-left text-text-muted">
                  <th className="px-3 py-2 font-medium">{t('surface.col.product')}</th>
                  <th className="px-3 py-2 font-medium">{t('surface.col.assets')}</th>
                  <th className="px-3 py-2 font-medium">{t('surface.col.support')}</th>
                  <th className="px-3 py-2 font-medium">{t('surface.col.cpe')}</th>
                </tr>
              </thead>
              <tbody>
                {surface.exposures.map((exposure) => (
                  <ExposureRow key={exposure.key} exposure={exposure} t={t} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-muted flex items-start gap-1.5">
            <Info size={12} className="mt-0.5 shrink-0" />
            {t('surface.eolDisclaimer', {
              date: new Date(EOL_DATASET_VERIFIED_AT).toISOString().slice(0, 10),
            })}
          </p>
        </section>
      </div>
    </div>
  );
}

function ExposureRow({
  exposure, t,
}: {
  exposure: ProductExposure;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const style = STATUS_STYLE[exposure.eol.status];
  const days = exposure.eol.daysRemaining;

  const supportText = exposure.eol.status === 'unknown'
    ? t('surface.status.unknown')
    : days != null && days < 0
      ? t('surface.pastBy', { days: -days, status: t(`surface.status.${exposure.eol.status}`) })
      : t('surface.remaining', { days: days ?? 0, status: t(`surface.status.${exposure.eol.status}`) });

  return (
    <tr className="border-b border-border-subtle last:border-0">
      <td className="px-3 py-1.5">
        <span className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', style.dot)} />
          {exposure.product.displayName}
          {exposure.product.edition && (
            <span className="text-text-muted">{exposure.product.edition}</span>
          )}
        </span>
      </td>
      <td className="px-3 py-1.5 font-medium">{exposure.assetIds.length}</td>
      <td className="px-3 py-1.5 text-text-muted">{supportText}</td>
      <td className="px-3 py-1.5 font-mono text-text-muted truncate max-w-[20rem]" title={exposure.cpe}>
        {exposure.cpe}
      </td>
    </tr>
  );
}
