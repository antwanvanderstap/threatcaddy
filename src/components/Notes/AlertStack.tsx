import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Siren } from 'lucide-react';
import type { Note } from '../../types';
import { cn } from '../../lib/utils';

/** Alert notes are written by webhook ingest with the tag 'alert'. */
export function isAlertNote(note: Note): boolean {
  return !note.trashed && !!note.tags?.includes('alert');
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  return tags?.find((t) => t.startsWith(prefix))?.slice(prefix.length);
}

/** First ticket or case on the alert ("ref:connectwise:214033" → "CW #214033"). */
function alertRef(tags: string[] | undefined): string | undefined {
  const refs = (tags ?? []).filter((t) => t.startsWith('ref:')).map((t) => t.slice(4).split(':'));
  const pick = refs.find(([s]) => s === 'connectwise') ?? refs.find(([s]) => s === 'stellar') ?? refs[0];
  if (!pick) return undefined;
  const [system, ...rest] = pick;
  const label = system === 'connectwise' ? 'CW' : system === 'stellar' ? 'Stellar' : system;
  return `${label} #${rest.join(':')}`;
}

const SEVERITY_CLASSES: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400',
  high: 'bg-orange-500/15 text-orange-400',
  medium: 'bg-yellow-500/15 text-yellow-400',
  low: 'bg-blue-500/15 text-blue-400',
};

interface AlertStackProps {
  alerts: Note[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

/** The alerts linked to an investigation, newest first, above its notes. */
export function AlertStack({ alerts, selectedId, onSelect }: AlertStackProps) {
  const { t } = useTranslation('notes');
  const [open, setOpen] = useState(true);
  const sorted = useMemo(() => [...alerts].sort((a, b) => b.createdAt - a.createdAt), [alerts]);
  if (sorted.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-gray-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-800/60"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Siren size={12} className="text-red-400" />
        {t('alerts.title', { count: sorted.length })}
      </button>
      {open && (
        <ul className="max-h-56 overflow-y-auto pb-1">
          {sorted.map((note) => {
            const severity = tagValue(note.tags, 'severity:');
            const source = tagValue(note.tags, 'source:');
            const ref = alertRef(note.tags);
            return (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => onSelect(note.id)}
                  className={cn(
                    'w-full grid grid-cols-[auto_auto_1fr] items-center gap-x-2 px-3 py-1 text-start text-xs hover:bg-gray-800/60',
                    selectedId === note.id && 'bg-gray-800',
                  )}
                  title={note.title}
                >
                  <span className="font-mono text-[10px] text-gray-500 whitespace-nowrap">
                    {new Date(note.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className={cn('text-[10px] font-medium px-1.5 rounded', SEVERITY_CLASSES[severity ?? ''] ?? 'bg-gray-700/40 text-gray-400')}>
                    {severity ?? '—'}
                  </span>
                  <span className="truncate text-gray-200">{note.title}</span>
                  <span className="col-start-3 truncate text-[10px] text-gray-500">
                    {[source, ref].filter(Boolean).join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
