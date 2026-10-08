'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { fromDateKey, toDateKey, todayDateKey } from '@/lib/date';

type Preset = 'WEEK' | 'MONTH' | 'SIX_MONTHS' | 'CUSTOM';

const PRESETS: [Preset, string][] = [
  ['WEEK', 'Week'],
  ['MONTH', 'Month'],
  ['SIX_MONTHS', '6 months'],
  ['CUSTOM', 'Custom range'],
];

/** "today" is the viewer's calendar day (a UTC today is already tomorrow on
 * a Canadian evening); from there the arithmetic runs on UTC-midnight
 * calendar dates (see lib/format.ts) so nothing shifts by a day. */
const presetFrom = (preset: Exclude<Preset, 'CUSTOM'>, todayKey: string): string => {
  const from = fromDateKey(todayKey)!;
  if (preset === 'WEEK') from.setUTCDate(from.getUTCDate() - 7);
  if (preset === 'MONTH') from.setUTCMonth(from.getUTCMonth() - 1);
  if (preset === 'SIX_MONTHS') from.setUTCMonth(from.getUTCMonth() - 6);
  return toDateKey(from);
};

export const MatchTransfersDialog = ({
  open,
  onClose,
  onConfirm,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (range: { from: Date; to: Date }) => void;
  pending: boolean;
}): React.ReactElement => {
  // Defaults to the last month, per the feature's ask; re-seeded fresh on
  // every open by the caller remounting this component (`key`), matching
  // this codebase's existing dialog-draft convention.
  const [preset, setPreset] = useState<Preset>('MONTH');
  const today = todayDateKey();
  const [customFrom, setCustomFrom] = useState(presetFrom('MONTH', today));
  const [customTo, setCustomTo] = useState(today);

  const customRangeValid = customFrom !== '' && customTo !== '' && customFrom <= customTo;
  const canConfirm = preset !== 'CUSTOM' || customRangeValid;

  const handleConfirm = (): void => {
    if (!canConfirm) return;
    const toKey = preset === 'CUSTOM' ? customTo : todayDateKey();
    const fromKey = preset === 'CUSTOM' ? customFrom : presetFrom(preset, toKey);
    const from = fromDateKey(fromKey);
    const to = fromDateKey(toKey);
    if (from && to) onConfirm({ from, to });
  };

  return (
    <Modal open={open} onClose={onClose} title="Match transfers" className="max-w-sm">
      <p className="text-ink-muted text-sm">
        Look for transfer pairs dated within this range. Wider ranges take longer to scan.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setPreset(value)}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
              preset === value
                ? 'bg-ink text-paper-raised border-ink'
                : 'border-line text-ink bg-paper-raised'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {preset === 'CUSTOM' && (
        <div className="mt-4">
          <Label htmlFor="match-transfers-from">Date range</Label>
          <div className="flex items-center gap-2">
            <Input
              id="match-transfers-from"
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span className="text-ink-muted text-xs">to</span>
            <Input
              id="match-transfers-to"
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </div>
          {!customRangeValid && (
            <p className="text-rose mt-1.5 text-xs">Pick a start date on or before the end date.</p>
          )}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-2.5">
        <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={handleConfirm} disabled={!canConfirm} loading={pending}>
          Match transfers
        </Button>
      </div>
    </Modal>
  );
};
