'use client';

import { useActionState } from 'react';
import { Lock } from 'lucide-react';
import { resetPasswordAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
import { MIN_PASSWORD_LENGTH } from '@/lib/validators/password';

export const ResetPasswordForm = ({ token }: { token: string }): React.ReactElement => {
  const [error, formAction, pending] = useActionState(resetPasswordAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <div>
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className="bg-paper-raised rounded-[10px]"
        />
        <p className="text-ink-muted mt-1 text-xs">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>
      <div>
        <Label htmlFor="confirmNewPassword">Confirm new password</Label>
        <Input
          id="confirmNewPassword"
          name="confirmNewPassword"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className="bg-paper-raised rounded-[10px]"
        />
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        icon={Lock}
        loading={pending}
        className="mt-2 w-full py-3.5 text-[15px]"
      >
        Reset password
      </Button>
    </form>
  );
};
