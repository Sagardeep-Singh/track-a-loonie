import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => {
  const prismaMock: {
    categoryRule: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    category: {
      findMany: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    transaction: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  } = {
    categoryRule: { findMany: vi.fn(), createMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    category: { findMany: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
    transaction: { findMany: vi.fn() },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prismaMock)),
  };
  return { prismaMock };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: prismaMock }));

const {
  listCategoryRules,
  exportCategoryRules,
  importCategoryRules,
  previewCategoryRuleImport,
  updateCategoryRule,
} = await import('@/lib/services/categoryRules');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listCategoryRules', () => {
  it('counts current transactions whose category and text both match the rule', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      {
        id: 'r1',
        categoryId: 'cat-1',
        matchText: 'whole foods',
        priority: 0,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      { categoryId: 'cat-1', payee: 'Whole Foods #1', note: null },
      { categoryId: 'cat-1', payee: 'Whole Foods #2', note: null },
      // right category, but text doesn't match the rule — not counted
      { categoryId: 'cat-1', payee: 'Rent', note: null },
      // text matches, but a different category — not counted (user recategorized it)
      { categoryId: 'cat-2', payee: 'Whole Foods #3', note: null },
    ]);

    const result = await listCategoryRules('user-1');

    expect(result).toEqual({
      rules: [
        {
          id: 'r1',
          categoryId: 'cat-1',
          categoryName: 'Groceries',
          matchText: 'whole foods',
          priority: 0,
          appliedCount: 2,
          overlapCount: 0,
          overlap: null,
        },
      ],
      appliedToTransactionCount: 3,
    });
  });

  it('flags rules whose match text collides on a real transaction, and picks the priority rival', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      {
        id: 'r1',
        categoryId: 'cat-1',
        matchText: 'food',
        priority: 5,
        category: { name: 'Dine Out' },
      },
      {
        id: 'r2',
        categoryId: 'cat-2',
        matchText: 'superstore',
        priority: 0,
        category: { name: 'Groceries' },
      },
    ]);
    prismaMock.transaction.findMany.mockResolvedValue([
      // matches both rules' text — the actual collision the counts are built from
      { categoryId: 'cat-2', payee: 'Real Foodstore Superstore', note: null },
    ]);

    const result = await listCategoryRules('user-1');

    expect(result.rules[0]).toMatchObject({
      id: 'r1',
      overlapCount: 1,
      overlap: { matchText: 'superstore', priority: 0, wins: false },
    });
    expect(result.rules[1]).toMatchObject({
      id: 'r2',
      overlapCount: 1,
      overlap: { matchText: 'food', priority: 5, wins: true },
    });
  });
});

describe('exportCategoryRules', () => {
  it('exports by category name, not id', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { matchText: 'whole foods', priority: 0, category: { name: 'Groceries' } },
      { matchText: 'amzn mktp', priority: 1, category: { name: 'Shopping' } },
    ]);

    const result = await exportCategoryRules('user-1');

    expect(result).toEqual([
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
      { matchText: 'amzn mktp', categoryName: 'Shopping', priority: 1 },
    ]);
  });
});

describe('importCategoryRules', () => {
  beforeEach(() => {
    prismaMock.category.findMany.mockResolvedValue([
      { id: 'cat-1', name: 'Groceries' },
      { id: 'cat-2', name: 'Shopping' },
    ]);
    prismaMock.categoryRule.findMany.mockResolvedValue([]);
  });

  it('imports rows matched by category name, case-insensitively', async () => {
    const result = await importCategoryRules('user-1', [
      { matchText: 'whole foods', categoryName: 'groceries', priority: 0 },
    ]);

    expect(result).toEqual({ imported: 1, skipped: [], createdCategories: [] });
    expect(prismaMock.categoryRule.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', categoryId: 'cat-1', matchText: 'whole foods', priority: 0 }],
    });
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
  });

  it('skips a row that already exists for this user (idempotent re-import)', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'whole foods' },
    ]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
    ]);

    expect(result).toEqual({
      imported: 0,
      skipped: [{ matchText: 'whole foods', reason: 'Already exists' }],
      createdCategories: [],
    });
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
  });

  it('deduplicates identical rows within the same file', async () => {
    const result = await importCategoryRules('user-1', [
      { matchText: 'rent', categoryName: 'Groceries', priority: 0 },
      { matchText: 'rent', categoryName: 'Groceries', priority: 0 },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([{ matchText: 'rent', reason: 'Already exists' }]);
    expect(result.createdCategories).toEqual([]);
  });

  it('creates the missing category and attaches the rule to it', async () => {
    // same mock serves the classification read and the post-create re-fetch
    prismaMock.category.findMany
      .mockResolvedValueOnce([{ id: 'cat-1', name: 'Groceries' }])
      .mockResolvedValueOnce([{ id: 'cat-new', name: 'Travel' }]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
    ]);

    expect(prismaMock.category.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', name: 'Travel', isDefault: false }],
      skipDuplicates: true,
    });
    expect(prismaMock.categoryRule.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', categoryId: 'cat-new', matchText: 'air canada', priority: 0 }],
    });
    expect(result).toEqual({ imported: 1, skipped: [], createdCategories: ['Travel'] });
  });

  it('scopes the category write and the id re-fetch to the user', async () => {
    prismaMock.category.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'cat-new', name: 'Travel' }]);

    await importCategoryRules('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
    ]);

    expect(prismaMock.category.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: 'user-1' })],
      skipDuplicates: true,
    });
    expect(prismaMock.category.findMany).toHaveBeenLastCalledWith({
      where: { userId: 'user-1', name: { in: ['Travel'] } },
      select: { id: true, name: true },
    });
  });

  it('creates one category for case-variant rows and attaches both rules to it', async () => {
    prismaMock.category.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'cat-new', name: 'Travel' }]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
      { matchText: 'westjet', categoryName: 'travel', priority: 1 },
    ]);

    expect(prismaMock.category.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.category.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user-1', name: 'Travel', isDefault: false }],
      skipDuplicates: true,
    });
    expect(prismaMock.categoryRule.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user-1', categoryId: 'cat-new', matchText: 'air canada', priority: 0 },
        { userId: 'user-1', categoryId: 'cat-new', matchText: 'westjet', priority: 1 },
      ],
    });
    expect(result.createdCategories).toEqual(['Travel']);
  });

  it('creates nothing when the only row for a missing category was left unchecked (never submitted)', async () => {
    // simulates the user leaving a `will-create` preview row unchecked: the
    // commit payload never includes it, so `Travel` never reaches the
    // classifier at all — only the pre-existing `Groceries` row is sent
    const result = await importCategoryRules('user-1', [
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
    ]);

    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ imported: 1, skipped: [], createdCategories: [] });
  });

  it('is idempotent on re-run once the category and rule both exist', async () => {
    prismaMock.category.findMany.mockResolvedValue([{ id: 'cat-new', name: 'Travel' }]);
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-new', matchText: 'air canada' },
    ]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
    ]);

    expect(result).toEqual({
      imported: 0,
      skipped: [{ matchText: 'air canada', reason: 'Already exists' }],
      createdCategories: [],
    });
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
  });

  it('splits a mixed batch across imported, skipped and created categories', async () => {
    prismaMock.category.findMany
      .mockResolvedValueOnce([
        { id: 'cat-1', name: 'Groceries' },
        { id: 'cat-2', name: 'Shopping' },
      ])
      .mockResolvedValueOnce([{ id: 'cat-new', name: 'Travel' }]);
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-2', matchText: 'amzn mktp' },
    ]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
      { matchText: 'amzn mktp', categoryName: 'Shopping', priority: 0 },
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
    ]);

    expect(result).toEqual({
      imported: 2,
      skipped: [{ matchText: 'amzn mktp', reason: 'Already exists' }],
      createdCategories: ['Travel'],
    });
    expect(prismaMock.categoryRule.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user-1', categoryId: 'cat-1', matchText: 'whole foods', priority: 0 },
        { userId: 'user-1', categoryId: 'cat-new', matchText: 'air canada', priority: 0 },
      ],
    });
  });

  it('runs inside a transaction even when nothing is written', async () => {
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'whole foods' },
    ]);

    const result = await importCategoryRules('user-1', [
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
    ]);

    expect(result.imported).toBe(0);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe('previewCategoryRuleImport', () => {
  beforeEach(() => {
    prismaMock.category.findMany.mockResolvedValue([{ id: 'cat-1', name: 'Groceries' }]);
    prismaMock.categoryRule.findMany.mockResolvedValue([
      { categoryId: 'cat-1', matchText: 'existing rule' },
    ]);
  });

  it('classifies rows as ready/skip/will-create without writing anything', async () => {
    const result = await previewCategoryRuleImport('user-1', [
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0 },
      { matchText: 'rent', categoryName: 'Housing', priority: 0 },
      { matchText: 'existing rule', categoryName: 'Groceries', priority: 0 },
    ]);

    expect(result).toEqual([
      { matchText: 'whole foods', categoryName: 'Groceries', priority: 0, status: 'ready' },
      {
        matchText: 'rent',
        categoryName: 'Housing',
        priority: 0,
        status: 'will-create',
        newCategoryName: 'Housing',
      },
      {
        matchText: 'existing rule',
        categoryName: 'Groceries',
        priority: 0,
        status: 'skip',
        reason: 'Already exists',
      },
    ]);
    expect(prismaMock.categoryRule.createMany).not.toHaveBeenCalled();
    expect(prismaMock.category.createMany).not.toHaveBeenCalled();
  });

  it('resolves every case variant of a missing category to the first occurrence casing', async () => {
    const result = await previewCategoryRuleImport('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
      { matchText: 'westjet', categoryName: 'travel', priority: 0 },
      { matchText: 'hotel', categoryName: 'TRAVEL', priority: 0 },
    ]);

    expect(result.map((r) => r.status)).toEqual(['will-create', 'will-create', 'will-create']);
    expect(result.map((r) => r.newCategoryName)).toEqual(['Travel', 'Travel', 'Travel']);
  });

  it('skips a duplicate will-create row with the same name and match text', async () => {
    const result = await previewCategoryRuleImport('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
      { matchText: 'air canada', categoryName: 'travel', priority: 0 },
    ]);

    expect(result[0]).toEqual({
      matchText: 'air canada',
      categoryName: 'Travel',
      priority: 0,
      status: 'will-create',
      newCategoryName: 'Travel',
    });
    expect(result[1]).toEqual({
      matchText: 'air canada',
      categoryName: 'travel',
      priority: 0,
      status: 'skip',
      reason: 'Already exists',
    });
  });

  it('treats different match texts for the same missing category as distinct rows', async () => {
    const result = await previewCategoryRuleImport('user-1', [
      { matchText: 'air canada', categoryName: 'Travel', priority: 0 },
      { matchText: 'westjet', categoryName: 'Travel', priority: 0 },
    ]);

    expect(result.map((r) => r.status)).toEqual(['will-create', 'will-create']);
    expect(result.every((r) => r.reason === undefined)).toBe(true);
  });
});

describe('updateCategoryRule', () => {
  const existingRule = {
    id: 'r1',
    userId: 'user-1',
    categoryId: 'cat-1',
    matchText: 'x',
    priority: 0,
  };
  const updatedRule = { ...existingRule, category: { name: 'Groceries' } };

  it("rejects moving a rule to a category the user doesn't own", async () => {
    prismaMock.categoryRule.findFirst.mockResolvedValue(existingRule);
    prismaMock.category.findFirst.mockResolvedValue(null);

    await expect(
      updateCategoryRule('user-1', 'r1', { categoryId: 'cat-someone-else' }),
    ).rejects.toThrow('Category not found');
    expect(prismaMock.category.findFirst).toHaveBeenCalledWith({
      where: { id: 'cat-someone-else', userId: 'user-1' },
      select: { id: true },
    });
    expect(prismaMock.categoryRule.update).not.toHaveBeenCalled();
  });

  it('moves a rule to an owned category', async () => {
    prismaMock.categoryRule.findFirst.mockResolvedValue(existingRule);
    prismaMock.category.findFirst.mockResolvedValue({ id: 'cat-2' });
    prismaMock.categoryRule.update.mockResolvedValue({ ...updatedRule, categoryId: 'cat-2' });

    const rule = await updateCategoryRule('user-1', 'r1', { categoryId: 'cat-2' });

    expect(rule.categoryId).toBe('cat-2');
  });

  it('skips the category lookup when the category is unchanged or absent', async () => {
    prismaMock.categoryRule.findFirst.mockResolvedValue(existingRule);
    prismaMock.categoryRule.update.mockResolvedValue(updatedRule);

    await updateCategoryRule('user-1', 'r1', { matchText: 'y' });
    await updateCategoryRule('user-1', 'r1', { categoryId: 'cat-1' });

    expect(prismaMock.category.findFirst).not.toHaveBeenCalled();
  });
});
