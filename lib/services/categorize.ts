import { monthRange, toDateKey } from '@/lib/date';
import { prisma } from '@/lib/db/prisma';
import { rangeToDates, type DateRange } from '@/lib/period-selection';

export type CategoryRuleMatcher = { categoryId: string; matchText: string; priority: number };

/** Case-insensitive substring matcher for a rule's matchText. */
export const compileRuleMatcher = (matchText: string): { test: (haystack: string) => boolean } => {
  const needle = matchText.toLowerCase();
  return { test: (haystack: string) => haystack.toLowerCase().includes(needle) };
};

/**
 * First rule (lowest priority number) whose matchText matches the
 * payee/note wins. No match returns null so callers can fall back to an
 * "Other" category or leave uncategorized.
 */
/** Precompiles matchers once so callers matching many rows against the same
 * rule set (import preview, categorize queue, stats) don't recompile a
 * RegExp per row per rule. */
const compileMatchers = (
  rules: CategoryRuleMatcher[],
): Array<{ categoryId: string; matcher: { test: (haystack: string) => boolean } }> =>
  [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => ({ categoryId: rule.categoryId, matcher: compileRuleMatcher(rule.matchText) }));

export const matchCategoryRule = (rules: CategoryRuleMatcher[], text: string): string | null => {
  for (const { categoryId, matcher } of compileMatchers(rules)) {
    if (matcher.test(text)) {
      return categoryId;
    }
  }
  return null;
};

export const suggestCategoryId = async (userId: string, text: string): Promise<string | null> => {
  const rules = await prisma.categoryRule.findMany({
    where: { userId },
    select: { categoryId: true, matchText: true, priority: true },
  });
  return matchCategoryRule(rules, text);
};

export type CategorizeQueueRow = {
  id: string;
  payee: string;
  meta: string;
  amount: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  why: string | null;
};

/** `range` narrows the queue to the page's selected period; omitted (or both
 * sides null) is all time, the default for a triage queue. */
export const getCategorizeQueue = async (
  userId: string,
  range: DateRange = { from: null, to: null },
): Promise<CategorizeQueueRow[]> => {
  const date = rangeToDates(range);
  const rules = await prisma.categoryRule.findMany({
    where: { userId },
    include: { category: { select: { name: true } } },
    orderBy: { priority: 'asc' },
  });
  const transactions = await prisma.transaction.findMany({
    // a transfer leg or a card payment isn't spending or income — it never
    // needs a category, so keep it out of the triage queue entirely
    where: {
      userId,
      categoryId: null,
      skippedAt: null,
      isTransfer: false,
      isPayment: false,
      ...(date.gte || date.lt ? { date } : {}),
    },
    include: { account: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });

  const matchers = rules.map((r) => ({ rule: r, matcher: compileRuleMatcher(r.matchText) }));

  return transactions.map((tx) => {
    const haystack = `${tx.payee ?? ''} ${tx.note ?? ''}`;
    const rule = matchers.find((m) => m.matcher.test(haystack))?.rule;
    return {
      id: tx.id,
      payee: tx.payee || tx.note || 'Transaction',
      meta: `${tx.account.name} · ${toDateKey(tx.date)}`,
      amount: Number(tx.amount).toFixed(2),
      suggestedCategoryId: rule?.categoryId ?? null,
      suggestedCategoryName: rule?.category.name ?? null,
      why: rule ? `A rule matches "${rule.matchText}" in this transaction.` : null,
    };
  });
};

export type CategorizeQueueStats = { total: number; matched: number };

export const getCategorizeQueueStats = async (userId: string): Promise<CategorizeQueueStats> => {
  const [rules, uncategorized] = await Promise.all([
    prisma.categoryRule.findMany({
      where: { userId },
      select: { categoryId: true, matchText: true, priority: true },
    }),
    prisma.transaction.findMany({
      // a transfer leg or a card payment isn't spending or income — it never
      // needs a category, so keep it out of the triage queue entirely
      where: { userId, categoryId: null, skippedAt: null, isTransfer: false, isPayment: false },
      select: { payee: true, note: true },
    }),
  ]);

  const matchers = compileMatchers(rules);
  const matched = uncategorized.filter((tx) => {
    const haystack = `${tx.payee ?? ''} ${tx.note ?? ''}`;
    return matchers.some((m) => m.matcher.test(haystack));
  }).length;

  return { total: uncategorized.length, matched };
};

export type UncategorizedMonthSummary = { count: number; amount: string };

/** Uncategorized, unskipped expense spend within one calendar month — used
 * by the Budgets summary card to flag that its totals are understated. */
export const getUncategorizedMonthSummary = async (
  userId: string,
  month: number,
): Promise<UncategorizedMonthSummary> => {
  const { start, end } = monthRange(month);

  const rows = await prisma.transaction.findMany({
    where: {
      userId,
      categoryId: null,
      skippedAt: null,
      type: 'EXPENSE',
      isTransfer: false,
      date: { gte: start, lt: end },
    },
    select: { amount: true },
  });

  return {
    count: rows.length,
    amount: rows.reduce((sum, t) => sum + Number(t.amount), 0).toFixed(2),
  };
};

export type CategorizeProgress = { categorizedCount: number; totalCount: number };

/** "N of M categorized" for the progress bar — M is every transaction ever
 * logged (skipped ones included, since they still count as "handled"). */
export const getCategorizeProgress = async (userId: string): Promise<CategorizeProgress> => {
  const [totalCount, uncategorizedUnskipped] = await Promise.all([
    prisma.transaction.count({ where: { userId } }),
    prisma.transaction.count({ where: { userId, categoryId: null, skippedAt: null } }),
  ]);
  return { categorizedCount: totalCount - uncategorizedUnskipped, totalCount };
};
