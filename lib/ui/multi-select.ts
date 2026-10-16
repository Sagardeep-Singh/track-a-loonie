/**
 * Pure option/selection logic for `components/ui/multi-select.tsx`, kept out
 * of the component so it is unit-testable under vitest's `environment: 'node'`
 * (same precedent as `lib/ui/numeric-keypad.ts`).
 */

export type MultiSelectOption = { id: string; name: string };

/** Case-insensitive "contains" match on name; a blank query keeps everything. */
export const filterOptionsByQuery = <T extends MultiSelectOption>(
  options: T[],
  query: string,
): T[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => option.name.toLowerCase().includes(needle));
};

/** Selected options first, keeping the original order within both groups. */
export const orderSelectedFirst = <T extends MultiSelectOption>(
  options: T[],
  selectedIds: string[],
): T[] => [
  ...options.filter((option) => selectedIds.includes(option.id)),
  ...options.filter((option) => !selectedIds.includes(option.id)),
];

/**
 * Only the selected IDs that still match an option. A stale URL can carry the
 * ID of a deleted account or category; it shouldn't count or show as a chip.
 */
export const selectedOptions = <T extends MultiSelectOption>(
  options: T[],
  selectedIds: string[],
): T[] => options.filter((option) => selectedIds.includes(option.id));

/** Trigger text: the "all" label, the one picked name, or "N selected". */
export const summarizeSelection = (
  options: MultiSelectOption[],
  selectedIds: string[],
  allLabel: string,
): string => {
  const selected = selectedOptions(options, selectedIds);
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) return selected[0].name;
  return `${selected.length} selected`;
};

export const toggleSelectedId = (ids: string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
