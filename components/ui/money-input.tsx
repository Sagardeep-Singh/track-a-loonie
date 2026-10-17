'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { groupMoney, plainMoney, sanitizeMoneyInput } from '@/lib/ui/money-input';

type MoneyInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max' | 'step'
> & {
  /** plain amount like `6303.89`; omit with `defaultValue` for an uncontrolled field */
  value?: string;
  defaultValue?: string;
  /** called with the plain amount, commas stripped */
  onValueChange?: (plain: string) => void;
};

/**
 * Money field: a text input with the decimal keypad instead of
 * `type="number"`, so it has no spinner arrows and accepts `6,303.89`.
 * Commas are added on blur. With a `name`, a hidden input carries the plain
 * amount so FormData readers never see commas.
 */
export const MoneyInput = ({
  value,
  defaultValue,
  onValueChange,
  name,
  className,
  onBlur,
  ...props
}: MoneyInputProps): React.ReactElement => {
  const [display, setDisplay] = useState(() => groupMoney(value ?? defaultValue ?? ''));
  // a controlled value changed from outside (reset, refetch): show it
  if (value !== undefined && plainMoney(display) !== value) {
    setDisplay(groupMoney(value));
  }
  const plain = plainMoney(display);

  return (
    <>
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={display}
        onChange={(e) => {
          const next = sanitizeMoneyInput(e.target.value);
          if (next === null) return;
          setDisplay(next);
          onValueChange?.(plainMoney(next));
        }}
        onBlur={(e) => {
          setDisplay(groupMoney(plain));
          onBlur?.(e);
        }}
        className={cn('font-mono tabular-nums', className)}
      />
      {name && <input type="hidden" name={name} value={plain} />}
    </>
  );
};
