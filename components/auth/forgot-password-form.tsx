'use client';

import { useActionState } from 'react';
import { Mail } from 'lucide-react';
import { requestPasswordResetAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';

export const ForgotPasswordForm = (): React.ReactElement => {
  const [error, formAction, pending] = useActionState(requestPasswordResetAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          className="bg-paper-raised rounded-[10px]"
          placeholder="you@example.com"
        />
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        icon={Mail}
        loading={pending}
        className="mt-2 w-full py-3.5 text-[15px]"
      >
        Send reset link
      </Button>
    </form>
  );
};
