'use client';

import { useActionState } from 'react';
import { UserPlus } from 'lucide-react';
import { signUpAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';

export const SignUpForm = ({ next }: { next?: string }): React.ReactElement => {
  const [error, formAction, pending] = useActionState(signUpAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          required
          autoFocus
          autoComplete="name"
          className="rounded-[10px]"
          placeholder="Jane Doe"
        />
      </div>
      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-[10px]"
          placeholder="you@example.com"
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          className="rounded-[10px]"
        />
      </div>
      {error && (
        <p className="bg-rose-soft text-rose rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        icon={UserPlus}
        loading={pending}
        className="mt-2 w-full py-3.5 text-[15px]"
      >
        Create account
      </Button>
    </form>
  );
};
