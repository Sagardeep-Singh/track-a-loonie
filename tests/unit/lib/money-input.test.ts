import { describe, expect, it } from 'vitest';
import { groupMoney, plainMoney, sanitizeMoneyInput } from '@/lib/ui/money-input';

describe('sanitizeMoneyInput', () => {
  it('accepts amounts with thousands commas', () => {
    expect(sanitizeMoneyInput('6,303.89')).toBe('6,303.89');
    expect(sanitizeMoneyInput('1,000,000')).toBe('1,000,000');
  });

  it('drops dollar signs and spaces from pasted amounts', () => {
    expect(sanitizeMoneyInput('$6,303.89')).toBe('6,303.89');
    expect(sanitizeMoneyInput(' 12.50 ')).toBe('12.50');
  });

  it('allows partial input while typing, including a leading minus', () => {
    expect(sanitizeMoneyInput('')).toBe('');
    expect(sanitizeMoneyInput('-')).toBe('-');
    expect(sanitizeMoneyInput('12.')).toBe('12.');
    expect(sanitizeMoneyInput('.5')).toBe('.5');
  });

  it('rejects letters, a second decimal point, and a minus in the middle', () => {
    expect(sanitizeMoneyInput('12a')).toBeNull();
    expect(sanitizeMoneyInput('1.2.3')).toBeNull();
    expect(sanitizeMoneyInput('1-2')).toBeNull();
    expect(sanitizeMoneyInput('1.2,3')).toBeNull();
  });
});

describe('plainMoney', () => {
  it('strips commas so validators get a plain number', () => {
    expect(plainMoney('6,303.89')).toBe('6303.89');
    expect(plainMoney('-1,200')).toBe('-1200');
  });
});

describe('groupMoney', () => {
  it('groups the whole-dollar part and leaves decimals as typed', () => {
    expect(groupMoney('6303.89')).toBe('6,303.89');
    expect(groupMoney('1234567.5')).toBe('1,234,567.5');
    expect(groupMoney('-1200')).toBe('-1,200');
    expect(groupMoney('999')).toBe('999');
  });

  it('leaves blanks and partial input alone', () => {
    expect(groupMoney('')).toBe('');
    expect(groupMoney('-')).toBe('-');
    expect(groupMoney('.5')).toBe('.5');
  });
});
