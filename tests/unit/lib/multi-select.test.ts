import { describe, expect, it } from 'vitest';
import {
  filterOptionsByQuery,
  orderSelectedFirst,
  selectedOptions,
  summarizeSelection,
  toggleSelectedId,
} from '@/lib/ui/multi-select';

const options = [
  { id: 'c1', name: 'Dining' },
  { id: 'c2', name: 'Groceries' },
  { id: 'c3', name: 'Internet' },
  { id: 'c4', name: 'Rent' },
];

describe('filterOptionsByQuery', () => {
  it('returns every option for an empty or whitespace query', () => {
    expect(filterOptionsByQuery(options, '')).toEqual(options);
    expect(filterOptionsByQuery(options, '   ')).toEqual(options);
  });

  it('matches case-insensitively anywhere in the name, keeping order', () => {
    expect(filterOptionsByQuery(options, 'IN').map((o) => o.id)).toEqual(['c1', 'c3']);
    expect(filterOptionsByQuery(options, ' cer ').map((o) => o.id)).toEqual(['c2']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterOptionsByQuery(options, 'vet')).toEqual([]);
  });
});

describe('orderSelectedFirst', () => {
  it('puts selected options first and keeps relative order in both groups', () => {
    expect(orderSelectedFirst(options, ['c4', 'c2']).map((o) => o.id)).toEqual([
      'c2',
      'c4',
      'c1',
      'c3',
    ]);
  });

  it('ignores selected IDs that match no option', () => {
    expect(orderSelectedFirst(options, ['gone']).map((o) => o.id)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
  });
});

describe('selectedOptions', () => {
  it('drops stale IDs', () => {
    expect(selectedOptions(options, ['c3', 'gone']).map((o) => o.id)).toEqual(['c3']);
  });
});

describe('summarizeSelection', () => {
  it('shows the all label when nothing is selected', () => {
    expect(summarizeSelection(options, [], 'All categories')).toBe('All categories');
  });

  it('shows the name when one option is selected', () => {
    expect(summarizeSelection(options, ['c2'], 'All categories')).toBe('Groceries');
  });

  it('shows a count when several are selected', () => {
    expect(summarizeSelection(options, ['c1', 'c2', 'c3'], 'All categories')).toBe('3 selected');
  });

  it('does not count stale IDs', () => {
    expect(summarizeSelection(options, ['gone'], 'All categories')).toBe('All categories');
    expect(summarizeSelection(options, ['c4', 'gone'], 'All categories')).toBe('Rent');
  });
});

describe('toggleSelectedId', () => {
  it('adds a missing ID and removes a present one', () => {
    expect(toggleSelectedId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelectedId(['a', 'b'], 'a')).toEqual(['b']);
  });
});
