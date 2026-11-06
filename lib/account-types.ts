export const ACCOUNT_TYPE_VALUES = [
  'CHECKING',
  'SAVINGS',
  'CASH',
  'CREDIT_CARD',
  'LINE_OF_CREDIT',
  'RRSP',
  'TFSA',
  'FHSA',
  'RESP',
  'RRIF',
  'LIRA',
  'INVESTMENT',
] as const;

export type AccountTypeValue = (typeof ACCOUNT_TYPE_VALUES)[number];

export const ACCOUNT_TYPE_GROUPS = ['Banking', 'Credit', 'Registered', 'Investment'] as const;

export type AccountTypeGroup = (typeof ACCOUNT_TYPE_GROUPS)[number];

type AccountTypeMeta = {
  label: string;
  group: AccountTypeGroup;
  /** money owed rather than held: inverted CSV signs, "owing" balance, payments */
  isLiability: boolean;
  /** whether a new account counts toward Ready to Assign unless the user says otherwise */
  defaultOnBudget: boolean;
};

export const ACCOUNT_TYPES: Record<AccountTypeValue, AccountTypeMeta> = {
  CHECKING: { label: 'Checking', group: 'Banking', isLiability: false, defaultOnBudget: true },
  SAVINGS: { label: 'Savings', group: 'Banking', isLiability: false, defaultOnBudget: false },
  CASH: { label: 'Cash', group: 'Banking', isLiability: false, defaultOnBudget: true },
  CREDIT_CARD: { label: 'Credit card', group: 'Credit', isLiability: true, defaultOnBudget: true },
  LINE_OF_CREDIT: {
    label: 'Line of credit',
    group: 'Credit',
    isLiability: true,
    defaultOnBudget: true,
  },
  RRSP: { label: 'RRSP', group: 'Registered', isLiability: false, defaultOnBudget: false },
  TFSA: { label: 'TFSA', group: 'Registered', isLiability: false, defaultOnBudget: false },
  FHSA: { label: 'FHSA', group: 'Registered', isLiability: false, defaultOnBudget: false },
  RESP: { label: 'RESP', group: 'Registered', isLiability: false, defaultOnBudget: false },
  RRIF: { label: 'RRIF', group: 'Registered', isLiability: false, defaultOnBudget: false },
  LIRA: { label: 'LIRA', group: 'Registered', isLiability: false, defaultOnBudget: false },
  INVESTMENT: {
    label: 'Non-registered investment',
    group: 'Investment',
    isLiability: false,
    defaultOnBudget: false,
  },
};

const metaFor = (type: string): AccountTypeMeta | undefined =>
  ACCOUNT_TYPES[type as AccountTypeValue];

export const accountTypeLabel = (type: string): string => metaFor(type)?.label ?? type;

export const isLiabilityAccountType = (type: string | undefined): boolean =>
  type !== undefined && (metaFor(type)?.isLiability ?? false);

export const defaultOnBudgetFor = (type: string): boolean => metaFor(type)?.defaultOnBudget ?? true;

export const accountTypesInGroup = (group: AccountTypeGroup): AccountTypeValue[] =>
  ACCOUNT_TYPE_VALUES.filter((type) => ACCOUNT_TYPES[type].group === group);

export const accountTypeGroup = (type: string): AccountTypeGroup =>
  metaFor(type)?.group ?? 'Banking';

/** whether a new account is tracked by balance updates instead of transactions
 * unless the user says otherwise: the long-term money (savings, registered,
 * investment) whose value moves without anything worth logging as a transaction */
export const defaultTracksBalanceFor = (type: string): boolean =>
  type === 'SAVINGS' || ['Registered', 'Investment'].includes(accountTypeGroup(type));

/**
 * Converts between a stored signed balance and what the user types into a
 * balance field, in either direction. Balances are stored signed (a credit
 * card owing $1,200 is -1200), but people think of a liability as the amount
 * they owe, so its fields take that as a positive number. A negative amount
 * owing is a credit, e.g. an overpaid card. Asset balances pass through.
 */
export const liabilityAwareBalance = (value: string, type: string): string => {
  const trimmed = value.trim();
  if (!isLiabilityAccountType(type) || !Number.isFinite(Number(trimmed)) || trimmed === '') {
    return value;
  }
  // flip the sign as text so "-1200.00" keeps its cents; zero stays unsigned
  if (Number(trimmed) === 0) return trimmed.replace(/^-/, '');
  return trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`;
};

/** Label for a balance field: liabilities are entered as the amount owing. */
export const balanceFieldLabel = (type: string, prefix: 'Current' | 'Starting' | 'New'): string =>
  isLiabilityAccountType(type) ? `${prefix} amount owing` : `${prefix} balance`;
