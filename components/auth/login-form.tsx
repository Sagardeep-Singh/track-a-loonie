'use client';

import { useActionState, useState } from 'react';
import { LogIn } from 'lucide-react';
import { signInAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';

export const LoginForm = ({ next }: { next?: string }): React.ReactElement => {
  const [error, formAction, pending] = useActionState(signInAction, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
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
      <div>
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            className="bg-paper-raised rounded-[10px] pr-14"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="text-ink-muted hover:text-ink absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        icon={LogIn}
        loading={pending}
        className="mt-2 w-full py-3.5 text-[15px]"
      >
        Continue
      </Button>
    </form>
  );
};
