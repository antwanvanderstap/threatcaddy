import type { StandaloneIOC } from '../types';
import { IOC_STIX_OBJECT_TYPES } from '../types';

/** One entry per distinct STIX type + value, grouped by STIX type. */
export function stixObservablesOf(observables: StandaloneIOC[]) {
  const seen = new Set<string>();
  return observables
    .map((ioc) => ({ ioc, stixType: IOC_STIX_OBJECT_TYPES[ioc.type] ?? ioc.type }))
    .filter(({ ioc, stixType }) => {
      const key = `${stixType}|${ioc.value.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.stixType.localeCompare(b.stixType) || a.ioc.value.localeCompare(b.ioc.value));
}
