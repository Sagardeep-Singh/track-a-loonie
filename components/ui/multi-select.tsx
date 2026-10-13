'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Label } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import {
  filterOptionsByQuery,
  orderSelectedFirst,
  selectedOptions,
  summarizeSelection,
  toggleSelectedId,
  type MultiSelectOption,
} from '@/lib/ui/multi-select';

// Chips only add information once the trigger collapses to "N selected".
const MIN_CHIPS = 2;
const MAX_CHIPS = 4;

/**
 * Searchable multi-select: a trigger button that expands an inline panel
 * (search box + listbox) instead of floating over the page, so it needs no
 * positioning inside a native `<dialog>`. `open` is lifted so a parent can
 * keep only one picker open at a time.
 */
export const MultiSelect = ({
  id,
  label,
  options,
  selectedIds,
  onChange,
  allLabel,
  searchPlaceholder,
  open,
  onOpenChange,
}: {
  id: string;
  label: string;
  options: MultiSelectOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  allLabel: string;
  searchPlaceholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement => {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Snapshot of the option order taken when the panel opens, so selected
  // options sit on top without rows jumping under the cursor while toggling.
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = selectedOptions(options, selectedIds);
  const ordered = orderIds
    .map((optionId) => options.find((option) => option.id === optionId))
    .filter((option): option is MultiSelectOption => Boolean(option));
  const filtered = filterOptionsByQuery(ordered, query);
  const active = Math.min(highlight, filtered.length - 1);
  const optionId = (option: MultiSelectOption): string => `${id}-option-${option.id}`;
  const panelId = `${id}-panel`;

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openPanel = (): void => {
    setQuery('');
    setHighlight(0);
    setOrderIds(orderSelectedFirst(options, selectedIds).map((option) => option.id));
    onOpenChange(true);
  };

  const closePanel = (): void => {
    onOpenChange(false);
    triggerRef.current?.focus();
  };

  const toggle = (optionId: string): void => onChange(toggleSelectedId(selectedIds, optionId));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(Math.min(active + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(Math.max(active - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlight(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[active]) toggle(filtered[active].id);
    } else if (e.key === 'Escape') {
      // Without preventDefault the native <dialog> also treats this Escape
      // as a cancel and closes the whole Filters dialog.
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  };

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? onOpenChange(false) : openPanel())}
        className={cn(
          'bg-paper flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm outline-none',
          open ? 'border-iris' : 'border-line focus-visible:border-iris',
          selected.length === 0 ? 'text-ink-muted' : 'text-ink',
        )}
      >
        <span className="truncate">{summarizeSelection(options, selectedIds, allLabel)}</span>
        <ChevronDown
          size={16}
          aria-hidden
          className={cn('text-ink-muted shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>

      {selected.length >= MIN_CHIPS && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selected.slice(0, MAX_CHIPS).map((option) => (
            <span
              key={option.id}
              className="bg-iris-soft text-iris inline-flex items-center gap-0.5 rounded-full py-0.5 pr-1 pl-2.5 text-xs font-medium"
            >
              {option.name}
              <button
                type="button"
                aria-label={`Remove ${option.name}`}
                onClick={() => toggle(option.id)}
                className="hover:bg-iris/10 flex cursor-pointer rounded-full p-0.5"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          {selected.length > MAX_CHIPS && (
            <button
              type="button"
              onClick={() => {
                if (!open) openPanel();
              }}
              className="text-ink-muted hover:text-ink cursor-pointer px-1.5 text-xs font-medium"
            >
              +{selected.length - MAX_CHIPS} more
            </button>
          )}
        </div>
      )}

      {open && (
        <div
          id={panelId}
          className="border-line bg-paper-raised mt-2 overflow-hidden rounded-lg border"
        >
          <div className="border-line relative border-b p-2">
            <Search
              size={14}
              aria-hidden
              className="text-ink-muted pointer-events-none absolute top-1/2 left-4.5 -translate-y-1/2"
            />
            <input
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={`${id}-listbox`}
              aria-autocomplete="list"
              aria-activedescendant={filtered[active] ? optionId(filtered[active]) : undefined}
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={handleKeyDown}
              className="border-line bg-paper text-ink focus:border-iris w-full rounded-md border py-1.5 pr-3 pl-8 text-sm outline-none"
            />
          </div>
          <div
            ref={listRef}
            id={`${id}-listbox`}
            role="listbox"
            aria-multiselectable
            aria-label={label}
            className="max-h-56 overflow-y-auto p-1"
          >
            {filtered.map((option, index) => {
              const isSelected = selectedIds.includes(option.id);
              return (
                <div
                  key={option.id}
                  id={optionId(option)}
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  // Keep focus in the search box so typing and arrows still work.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => toggle(option.id)}
                  className={cn(
                    'text-ink flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
                    index === active && 'bg-iris-soft',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      isSelected ? 'border-iris bg-iris text-paper-raised' : 'border-line bg-paper',
                    )}
                  >
                    {isSelected && <Check size={12} strokeWidth={3} />}
                  </span>
                  {option.name}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-ink-muted px-2.5 py-4 text-center text-sm">No matches</p>
            )}
          </div>
          <div className="border-line bg-paper flex items-center justify-between gap-2 border-t px-2 py-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-ink-muted hover:text-ink cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium"
            >
              Clear
            </button>
            <span className="text-ink-muted text-xs">
              {selected.length} of {options.length} selected
            </span>
            <button
              type="button"
              onClick={closePanel}
              className="bg-ink text-paper-raised cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
