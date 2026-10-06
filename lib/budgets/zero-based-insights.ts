import { shiftMonth } from '@/lib/date';

/**
 * Pure insight rules for the zero-based Overview: category health, where the
 * money sits, and a short ranked list of suggestions. Kept apart from Prisma
 * (like `zero-based-math.ts`) so every rule is testable on plain numbers.
 * Amounts are integer cents.
 */

export type InsightTone = 'rose' | 'iris' | 'sky' | 'neutral';

export type ZbbInsightCategory = {
  categoryId: string;
  categoryName: string;
  carriedInCents: number;
  assignedCents: number;
  activityCents: number;
  availableCents: number;
  targetCents: number | null;
};

export type CategoryHealthStatus = 'overspent' | 'at-risk' | 'underfunded' | 'funded';

export type CategoryHealth = {
  categoryId: string;
  categoryName: string;
  status: CategoryHealthStatus;
  /** carried in + assigned: what the category had to spend this month */
  fundedCents: number;
  activityCents: number;
  availableCents: number;
  /** current month only: the day money runs out at the current pace */
  runOutDay: number | null;
  /** how far funding falls short of the target, 0 when there's no gap */
  targetShortfallCents: number;
};

export type AllocationSlice = {
  kind: 'category' | 'other' | 'ready';
  /** null for the Ready to Assign slice and the "other categories" bucket */
  categoryId: string | null;
  label: string;
  cents: number;
};

export type SuggestionAction =
  | { kind: 'budgets'; month: number }
  | { kind: 'categorize' }
  | { kind: 'category'; categoryId: string };

export type Suggestion = {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
  action: (SuggestionAction & { label: string }) | null;
};

export type ZbbInsights = {
  health: CategoryHealth[];
  allocation: AllocationSlice[];
  overspentCents: number;
  targetShortfallCents: number;
  suggestions: Suggestion[];
};

export type ZbbInsightInput = {
  month: number;
  /** null when `month` isn't the current month (no pace projection then) */
  today: { day: number; daysInMonth: number } | null;
  readyToAssignCents: number;
  categories: ZbbInsightCategory[];
  uncategorized: { count: number; cents: number };
  /** what's already assigned to the month after `month` */
  nextMonthAssignedCents: number;
  /** label for the month after `month`, e.g. "November" */
  nextMonthLabel: string;
  /** label for `month` itself, used in run-out dates, e.g. "Oct" */
  monthShortLabel: string;
};

const MAX_SUGGESTIONS = 5;
const ALLOCATION_SLICES = 5;

const dollars = (cents: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const categoriesLabel = (n: number): string => `${n} ${n === 1 ? 'category' : 'categories'}`;

const healthOf = (c: ZbbInsightCategory, today: ZbbInsightInput['today']): CategoryHealth => {
  const fundedCents = c.carriedInCents + c.assignedCents;
  const targetShortfallCents =
    c.targetCents === null ? 0 : Math.max(0, c.targetCents - fundedCents);

  let runOutDay: number | null = null;
  if (today && c.activityCents > 0 && c.availableCents > 0 && today.day < today.daysInMonth) {
    const perDay = c.activityCents / today.day;
    const day = Math.floor(today.day + c.availableCents / perDay);
    if (day < today.daysInMonth) runOutDay = Math.max(day, today.day);
  }

  const status: CategoryHealthStatus =
    c.availableCents < 0
      ? 'overspent'
      : runOutDay !== null
        ? 'at-risk'
        : targetShortfallCents > 0
          ? 'underfunded'
          : 'funded';

  return {
    categoryId: c.categoryId,
    categoryName: c.categoryName,
    status,
    fundedCents,
    activityCents: c.activityCents,
    availableCents: c.availableCents,
    runOutDay,
    targetShortfallCents,
  };
};

const STATUS_ORDER: Record<CategoryHealthStatus, number> = {
  overspent: 0,
  'at-risk': 1,
  underfunded: 2,
  funded: 3,
};

export const buildZbbInsights = (input: ZbbInsightInput): ZbbInsights => {
  const { month, today, readyToAssignCents, uncategorized } = input;

  // categories with nothing in them and nothing happening aren't worth a row
  const health = input.categories
    .filter(
      (c) =>
        c.carriedInCents + c.assignedCents !== 0 ||
        c.activityCents !== 0 ||
        (c.targetCents ?? 0) > 0,
    )
    .map((c) => healthOf(c, today))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.status === 'overspent' ? a.availableCents - b.availableCents : 0) ||
        (a.runOutDay ?? 99) - (b.runOutDay ?? 99) ||
        a.categoryName.localeCompare(b.categoryName),
    );

  const overspent = health.filter((h) => h.status === 'overspent');
  const atRisk = health.filter((h) => h.status === 'at-risk');
  const overspentCents = overspent.reduce((sum, h) => sum - h.availableCents, 0);
  const targetShortfallCents = health.reduce((sum, h) => sum + h.targetShortfallCents, 0);

  // --- where the money sits: positive category balances plus Ready to Assign
  const positive = health
    .filter((h) => h.availableCents > 0)
    .sort((a, b) => b.availableCents - a.availableCents);
  const allocation: AllocationSlice[] = positive.slice(0, ALLOCATION_SLICES).map((h) => ({
    kind: 'category',
    categoryId: h.categoryId,
    label: h.categoryName,
    cents: h.availableCents,
  }));
  const restCents = positive.slice(ALLOCATION_SLICES).reduce((sum, h) => sum + h.availableCents, 0);
  if (restCents > 0) {
    allocation.push({
      kind: 'other',
      categoryId: null,
      label: `${categoriesLabel(positive.length - ALLOCATION_SLICES)} more`,
      cents: restCents,
    });
  }
  if (readyToAssignCents > 0) {
    allocation.push({
      kind: 'ready',
      categoryId: null,
      label: 'Ready to assign',
      cents: readyToAssignCents,
    });
  }

  // --- suggestions, most urgent first
  const suggestions: Suggestion[] = [];
  const budgets = (label: string, m = month): Suggestion['action'] => ({
    kind: 'budgets',
    month: m,
    label,
  });

  if (readyToAssignCents < 0) {
    suggestions.push({
      id: 'over-assigned',
      tone: 'rose',
      title: `You've assigned ${dollars(-readyToAssignCents)} more than you have`,
      detail:
        'Lower an assignment, ideally in a category you have not spent from yet, until Ready to Assign is back to $0.',
      action: budgets('Fix in Budgets'),
    });
  }

  if (overspent.length > 0) {
    const worst = overspent[0];
    // the smallest healthy category that can cover the whole gap: big balances
    // are usually savings goals, which shouldn't be the first place to raid
    const donor = health
      .filter(
        (h) =>
          (h.status === 'funded' || h.status === 'underfunded') &&
          h.availableCents >= overspentCents,
      )
      .sort((a, b) => a.availableCents - b.availableCents)[0];
    const cover = donor
      ? `Cover it from ${donor.categoryName}, which has ${dollars(donor.availableCents)} available.`
      : readyToAssignCents >= overspentCents
        ? `Assign ${dollars(overspentCents)} from Ready to Assign to cover it.`
        : 'Move money in from other categories, or it carries into next month as a negative.';
    suggestions.push({
      id: 'overspent',
      tone: 'rose',
      title:
        overspent.length === 1
          ? `${worst.categoryName} is overspent by ${dollars(-worst.availableCents)}`
          : `${categoriesLabel(overspent.length)} overspent by ${dollars(overspentCents)}`,
      detail: cover,
      action: budgets('Cover it'),
    });
  }

  if (uncategorized.count > 0) {
    suggestions.push({
      id: 'uncategorized',
      tone: 'iris',
      title: `${plural(uncategorized.count, 'expense')} without a category`,
      detail: `${dollars(uncategorized.cents)} came out of Ready to Assign instead of a category. Categorize them so each category shows what it really spent.`,
      action: { kind: 'categorize', label: 'Categorize' },
    });
  }

  if (atRisk.length > 0 && today) {
    const first = atRisk[0];
    const daysLeft = today.daysInMonth - today.day;
    const safePerDay = Math.floor(first.availableCents / Math.max(daysLeft, 1));
    suggestions.push({
      id: 'at-risk',
      tone: 'iris',
      title: `${first.categoryName} runs out around ${input.monthShortLabel} ${first.runOutDay}`,
      detail:
        `At this pace it'll be empty before the month ends. Keep it to about ${dollars(safePerDay)} a day, or move money in.` +
        (atRisk.length > 1 ? ` ${categoriesLabel(atRisk.length - 1)} more on the same track.` : ''),
      action: { kind: 'category', categoryId: first.categoryId, label: 'See spending' },
    });
  }

  if (targetShortfallCents > 0) {
    const canFund = readyToAssignCents >= targetShortfallCents;
    suggestions.push({
      id: 'targets',
      tone: canFund ? 'sky' : 'neutral',
      title: canFund
        ? `You can fund every target now`
        : `Targets are ${dollars(targetShortfallCents)} short`,
      detail: canFund
        ? `Targets need ${dollars(targetShortfallCents)} more and you have ${dollars(readyToAssignCents)} ready. "Assign to targets" does it in one step.`
        : readyToAssignCents > 0
          ? `You have ${dollars(readyToAssignCents)} ready. Fund the essentials first; the rest can wait for the next paycheque.`
          : 'Nothing is waiting to be assigned. They will fill in as income arrives.',
      action: budgets('Assign to targets'),
    });
  }

  const leftover = readyToAssignCents - (targetShortfallCents > 0 ? targetShortfallCents : 0);
  if (readyToAssignCents > 0 && leftover > 0) {
    suggestions.push({
      id: 'idle',
      tone: 'sky',
      title: `${dollars(leftover)} is waiting for a job`,
      detail:
        input.nextMonthAssignedCents === 0
          ? `Assign it to ${input.nextMonthLabel} to start getting a month ahead, or to a savings category.`
          : `${dollars(input.nextMonthAssignedCents)} is already set aside for ${input.nextMonthLabel}. Add to it, or grow a savings category.`,
      action: budgets(`Plan ${input.nextMonthLabel}`, shiftMonth(month, 1)),
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      id: 'all-good',
      tone: 'sky',
      title: 'Every dollar has a job',
      detail: 'Nothing is overspent and nothing is waiting to be assigned. Nice work.',
      action: null,
    });
  }

  return {
    health,
    allocation,
    overspentCents,
    targetShortfallCents,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
  };
};
