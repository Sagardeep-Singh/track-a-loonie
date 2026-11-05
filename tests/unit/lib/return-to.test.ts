import { describe, expect, it } from 'vitest';
import { nextQuery, safeReturnTo } from '@/lib/auth/return-to';

describe('safeReturnTo', () => {
  it('allows the upgrade page, with or without a price', () => {
    expect(safeReturnTo('/upgrade')).toBe('/upgrade');
    expect(safeReturnTo('/upgrade?price=price_123')).toBe('/upgrade?price=price_123');
  });

  it('falls back to the dashboard for anything else', () => {
    expect(safeReturnTo(null)).toBe('/dashboard');
    expect(safeReturnTo('https://evil.example/upgrade')).toBe('/dashboard');
    expect(safeReturnTo('//evil.example')).toBe('/dashboard');
    expect(safeReturnTo('/upgrade/../settings')).toBe('/dashboard');
    expect(safeReturnTo('/settings')).toBe('/dashboard');
  });
});

describe('nextQuery', () => {
  it('encodes an allowed path and drops anything else', () => {
    expect(nextQuery('/upgrade')).toBe('?next=%2Fupgrade');
    expect(nextQuery('/settings')).toBe('');
    expect(nextQuery(undefined)).toBe('');
  });
});
