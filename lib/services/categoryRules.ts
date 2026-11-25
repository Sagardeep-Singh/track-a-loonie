import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { ServiceValidationError } from '@/lib/services/common';
import { compileRuleMatcher } from '@/lib/services/categorize';
import type {
  CreateCategoryRuleInput,
  UpdateCategoryRuleInput,
} from '@/lib/validators/category-rules';
import type {
  ExportedCategoryRule,
  ImportedCategoryRule,
} from '@/lib/validators/category-rule-transfer';

export type FrontendCategoryRule = {
  id: string;
  categoryId: string;
  categoryName: string;
  matchText: string;
  priority: number;
  /** Count of the user's current transactions this rule's match text and
   * category both agree with — an approximation of "applied", since a
   * transaction's category isn't tagged with which rule (if any) set it. */
  appliedCount: number;
  /** Other rules whose match text also matches at least one of the same
   * transactions — priority only matters for this subset. */
  overlapCount: number;
  /** Set iff overlapCount > 0: the immediate rival by priority, and whether
   * this rule wins (lower priority number) or loses to it. */
  overlap: { matchText: string; priority: number; wins: boolean } | null;
};

const toFrontend = (
  rule: {
    id: string;
    categoryId: string;
    matchText: string;
    priority: number;
    category: { name: string };
  },
  appliedCount: number,
  overlapCount: number,
  overlap: FrontendCategoryRule['overlap'],
): FrontendCategoryRule => ({
  id: rule.id,
  categoryId: rule.categoryId,
  categoryName: rule.category.name,
  matchText: rule.matchText,
  priority: rule.priority,
  appliedCount,
  overlapCount,
  overlap,
});

export type CategoryRulesSummary = {
  rules: FrontendCategoryRule[];
  /** Distinct transactions matched by at least one rule (not a sum of
   * appliedCount, which double-counts overlaps). */
  appliedToTransactionCount: number;
};

export const listCategoryRules = async (userId: string): Promise<CategoryRulesSummary> => {
  const [rules, categorizedTransactions, allTransactions] = await Promise.all([
    prisma.categoryRule.findMany({
      where: { userId },
      include: { category: { select: { name: true } } },
      orderBy: [{ priority: 'asc' }, { matchText: 'asc' }],
    }),
    prisma.transaction.findMany({
      where: { userId, categoryId: { not: null } },
      select: { categoryId: true, payee: true, note: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      select: { payee: true, note: true },
    }),
  ]);

  const matchers = rules.map((rule) => ({ rule, matcher: compileRuleMatcher(rule.matchText) }));

  // Two rules "overlap" when some real transaction's payee/note matches both
  // match texts — a static substring-containment check between match texts
  // would flag pairs that never actually collide on real data, and miss
  // pairs that do (e.g. "food" and "superstore" both matching one payee).
  const overlapCounts = new Map<string, Map<string, number>>();
  for (const rule of rules) overlapCounts.set(rule.id, new Map());
  let appliedToTransactionCount = 0;
  for (const t of allTransactions) {
    const haystack = `${t.payee ?? ''} ${t.note ?? ''}`;
    const matchedIds = matchers.filter((m) => m.matcher.test(haystack)).map((m) => m.rule.id);
    if (matchedIds.length > 0) appliedToTransactionCount += 1;
    if (matchedIds.length < 2) continue;
    for (const a of matchedIds) {
      for (const b of matchedIds) {
        if (a === b) continue;
        const counts = overlapCounts.get(a)!;
        counts.set(b, (counts.get(b) ?? 0) + 1);
      }
    }
  }

  const frontendRules = rules.map((rule) => {
    const matcher = compileRuleMatcher(rule.matchText);
    const appliedCount = categorizedTransactions.filter(
      (t) => t.categoryId === rule.categoryId && matcher.test(`${t.payee ?? ''} ${t.note ?? ''}`),
    ).length;

    const rivalIds = [...overlapCounts.get(rule.id)!.keys()];
    let overlap: FrontendCategoryRule['overlap'] = null;
    if (rivalIds.length > 0) {
      // The immediate rival is whichever overlapping rule is "next" in
      // priority order to this one — the one this rule's priority actually
      // has to beat (or lose to).
      const rivals = rivalIds
        .map((id) => rules.find((r) => r.id === id)!)
        .sort((a, b) => a.priority - b.priority || a.matchText.localeCompare(b.matchText));
      const rival =
        rivals.find((r) => r.priority > rule.priority) ??
        rivals.find((r) => r.priority < rule.priority) ??
        rivals[0];
      overlap = {
        matchText: rival.matchText,
        priority: rival.priority,
        wins: rule.priority < rival.priority,
      };
    }

    return toFrontend(rule, appliedCount, rivalIds.length, overlap);
  });

  return { rules: frontendRules, appliedToTransactionCount };
};

export const createCategoryRule = async (
  userId: string,
  input: CreateCategoryRuleInput,
): Promise<FrontendCategoryRule> => {
  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, userId },
  });
  if (!category) {
    throw new ServiceValidationError('Category not found');
  }

  const rule = await prisma.categoryRule.create({
    data: {
      userId,
      categoryId: input.categoryId,
      matchText: input.matchText,
      priority: input.priority,
    },
    include: { category: { select: { name: true } } },
  });
  return toFrontend(rule, 0, 0, null);
};

export const updateCategoryRule = async (
  userId: string,
  ruleId: string,
  input: UpdateCategoryRuleInput,
): Promise<FrontendCategoryRule> => {
  const existing = await prisma.categoryRule.findFirst({ where: { id: ruleId, userId } });
  if (!existing) {
    throw new ServiceValidationError('Rule not found');
  }
  if (input.categoryId !== undefined && input.categoryId !== existing.categoryId) {
    const category = await prisma.category.findFirst({
      where: { id: input.categoryId, userId },
      select: { id: true },
    });
    if (!category) {
      throw new ServiceValidationError('Category not found');
    }
  }

  const rule = await prisma.categoryRule.update({
    where: { id: ruleId },
    data: input,
    include: { category: { select: { name: true } } },
  });
  return toFrontend(rule, 0, 0, null);
};

export const deleteCategoryRule = async (userId: string, ruleId: string): Promise<void> => {
  const existing = await prisma.categoryRule.findFirst({ where: { id: ruleId, userId } });
  if (!existing) {
    throw new ServiceValidationError('Rule not found');
  }
  await prisma.categoryRule.delete({ where: { id: ruleId } });
};

/** categoryName, not categoryId — ids aren't portable across users/instances. */
export const exportCategoryRules = async (userId: string): Promise<ExportedCategoryRule[]> => {
  const rules = await prisma.categoryRule.findMany({
    where: { userId },
    include: { category: { select: { name: true } } },
    orderBy: [{ priority: 'asc' }, { matchText: 'asc' }],
  });
  return rules.map((rule) => ({
    matchText: rule.matchText,
    categoryName: rule.category.name,
    priority: rule.priority,
  }));
};

export type ImportRowStatus = 'ready' | 'skip' | 'will-create';

type ClassifiedImportRow = ImportedCategoryRule & {
  categoryId: string | null;
  newCategoryName: string | null;
  status: ImportRowStatus;
  reason?: string;
};

/**
 * Shared by preview (read-only) and commit: missing-category and
 * duplicate-row decisions are made once here so a row that's shown as
 * "will import" in the preview is classified the same way at commit time.
 * Dedup guards both against rows already in the DB and against duplicate
 * rows within the same uploaded file.
 *
 * `db` defaults to the singleton but accepts a transaction client so commit
 * can re-classify inside its own transaction, keeping the reads coherent with
 * the category/rule writes it performs.
 */
const classifyImportRows = async (
  userId: string,
  rows: ImportedCategoryRule[],
  db: Prisma.TransactionClient = prisma,
): Promise<ClassifiedImportRow[]> => {
  const [categories, existingRules] = await Promise.all([
    db.category.findMany({ where: { userId }, select: { id: true, name: true } }),
    db.categoryRule.findMany({
      where: { userId },
      select: { categoryId: true, matchText: true },
    }),
  ]);
  const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const existingKeys = new Set(existingRules.map((r) => `${r.categoryId}|${r.matchText}`));
  /** First-occurrence casing wins for a category that doesn't exist yet. */
  const pendingNameByLower = new Map<string, string>();

  return rows.map((row) => {
    const lowerName = row.categoryName.toLowerCase();
    const categoryId = categoryIdByName.get(lowerName);
    if (!categoryId) {
      // No such category yet: opt-in creation, surfaced per row in the
      // preview so nothing is created behind the user's back.
      const newCategoryName = pendingNameByLower.get(lowerName) ?? row.categoryName;
      pendingNameByLower.set(lowerName, newCategoryName);
      // Keyed on the name, not an id — there is no id to key on yet.
      const pendingKey = `${lowerName}|${row.matchText}`;
      if (existingKeys.has(pendingKey)) {
        return {
          ...row,
          categoryId: null,
          newCategoryName: null,
          status: 'skip',
          reason: 'Already exists',
        };
      }
      existingKeys.add(pendingKey);
      return { ...row, categoryId: null, newCategoryName, status: 'will-create' };
    }
    const key = `${categoryId}|${row.matchText}`;
    if (existingKeys.has(key)) {
      return {
        ...row,
        categoryId,
        newCategoryName: null,
        status: 'skip',
        reason: 'Already exists',
      };
    }
    existingKeys.add(key); // guard against duplicate rows within the same file
    return { ...row, categoryId, newCategoryName: null, status: 'ready' };
  });
};

export type ImportPreviewRow = {
  matchText: string;
  categoryName: string;
  priority: number;
  status: ImportRowStatus;
  reason?: string;
  /** Present iff `status === 'will-create'`: the canonical casing to create. */
  newCategoryName?: string;
};

/**
 * Read-only classification for the import confirmation step: lets the UI
 * show what each row will do before anything is written, so the user can
 * deselect any row (not just skipped ones) before committing.
 */
export const previewCategoryRuleImport = async (
  userId: string,
  rows: ImportedCategoryRule[],
): Promise<ImportPreviewRow[]> => {
  const classified = await classifyImportRows(userId, rows);
  return classified.map(
    ({ matchText, categoryName, priority, status, reason, newCategoryName }) => ({
      matchText,
      categoryName,
      priority,
      status,
      reason,
      newCategoryName: newCategoryName ?? undefined,
    }),
  );
};

export type ImportCategoryRulesResult = {
  imported: number;
  skipped: Array<{ matchText: string; reason: string }>;
  /** Canonical names of the categories this commit created, deduped. */
  createdCategories: string[];
};

/**
 * Lenient by design (decision 4 in the plan): a bad row is skipped with a
 * reason, not a reason to reject the whole file. Re-classifies at write
 * time rather than trusting the caller's preview — the DB state (existing
 * rules, categories) may have changed between preview and confirm, and a
 * category referenced as `will-create` at preview time may exist by now
 * (created out-of-band, or by an earlier row of this same commit), in which
 * case it resolves to an id and is never created twice.
 *
 * Everything runs in one transaction, including the classification reads: the
 * rule-level dedupe has no DB unique constraint, so the reads have to be
 * coherent with the writes, and a created category must not survive a failed
 * rule insert.
 */
export const importCategoryRules = async (
  userId: string,
  rows: ImportedCategoryRule[],
): Promise<ImportCategoryRulesResult> =>
  prisma.$transaction(async (tx) => {
    const classified = await classifyImportRows(userId, rows, tx);

    const namesToCreate: string[] = [];
    const seenLower = new Set<string>();
    for (const row of classified) {
      if (row.status !== 'will-create' || !row.newCategoryName) continue;
      const lower = row.newCategoryName.toLowerCase();
      if (seenLower.has(lower)) continue;
      seenLower.add(lower);
      namesToCreate.push(row.newCategoryName);
    }

    const createdIdByName = new Map<string, string>();
    if (namesToCreate.length > 0) {
      // `createCategory` in lib/services/categories.ts is the wrong shape here:
      // it throws on duplicates and takes no transaction client. `skipDuplicates`
      // covers the narrow race where a concurrent transaction created the same
      // name since this transaction's classification read.
      await tx.category.createMany({
        data: namesToCreate.map((name) => ({ userId, name, isDefault: false })),
        skipDuplicates: true,
      });
      // `createMany` returns no rows, so ids have to be read back.
      const created = await tx.category.findMany({
        where: { userId, name: { in: namesToCreate } },
        select: { id: true, name: true },
      });
      for (const category of created) {
        createdIdByName.set(category.name.toLowerCase(), category.id);
      }
    }

    const toCreate = classified
      .filter((r) => r.status === 'ready' || r.status === 'will-create')
      .map((r) => ({
        userId,
        categoryId:
          r.status === 'ready'
            ? (r.categoryId as string)
            : (createdIdByName.get((r.newCategoryName as string).toLowerCase()) as string),
        matchText: r.matchText,
        priority: r.priority,
      }));
    const skipped = classified
      .filter((r) => r.status === 'skip')
      .map((r) => ({ matchText: r.matchText, reason: r.reason as string }));

    if (toCreate.length > 0) {
      await tx.categoryRule.createMany({ data: toCreate });
    }

    return { imported: toCreate.length, skipped, createdCategories: namesToCreate };
  });
