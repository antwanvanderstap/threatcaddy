import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StandaloneIOC } from '../../types';
import { IOC_TYPE_LABELS } from '../../types';
import { stixObservablesOf } from '../../lib/stix-observables';
import { cn } from '../../lib/utils';

const COLLAPSED = 12;

/** An investigation's observables as STIX object chips (`ipv4-addr | 10.0.0.5`). */
export function ObservedStixObjects({ observables }: { observables: StandaloneIOC[] }) {
  const { t } = useTranslation('investigations');
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(() => stixObservablesOf(observables), [observables]);

  if (items.length === 0) return <p className="text-xs text-gray-500">{t('detail.observablesEmpty')}</p>;

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {(showAll ? items : items.slice(0, COLLAPSED)).map(({ ioc, stixType }) => {
          const color = IOC_TYPE_LABELS[ioc.type]?.color ?? '#6b7280';
          return (
            <span
              key={ioc.id}
              title={`${stixType}: ${ioc.value}`}
              className={cn('inline-flex max-w-full items-stretch rounded-md border overflow-hidden text-xs font-mono', ioc.iocStatus === 'false-positive' && 'opacity-50')}
              style={{ borderColor: `${color}40` }}
            >
              <span className="px-1.5 py-0.5 text-[10px] shrink-0 flex items-center" style={{ backgroundColor: `${color}20`, color }}>{stixType}</span>
              <span className="px-1.5 py-0.5 text-gray-200 truncate">{ioc.value.split('\n')[0]}</span>
            </span>
          );
        })}
      </div>
      {items.length > COLLAPSED && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-1.5 text-[11px] text-gray-400 hover:text-gray-200">
          {showAll ? t('detail.observablesShowLess') : t('detail.observablesShowAll', { count: items.length })}
        </button>
      )}
    </>
  );
}
