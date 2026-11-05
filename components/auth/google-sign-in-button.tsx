import { signInWithGoogleAction } from '@/lib/auth/actions';
import { Button } from '@/components/ui/button';

const GoogleGlyph = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <path
      d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.5h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9a8.7 8.7 0 0 0 2.7-6.6z"
      fill="#4285F4"
    />
    <path
      d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9a5.4 5.4 0 0 1-5.1-3.7H.9v2.3A9 9 0 0 0 9 18z"
      fill="#34A853"
    />
    <path d="M3.9 10.8a5.4 5.4 0 0 1 0-3.5V5H.9a9 9 0 0 0 0 8l3-2.2z" fill="#FBBC05" />
    <path
      d="M9 3.6c1.3 0 2.5.5 3.5 1.4l2.6-2.6A9 9 0 0 0 .9 5l3 2.3A5.4 5.4 0 0 1 9 3.6z"
      fill="#EA4335"
    />
  </svg>
);

export const GoogleSignInButton = ({
  label,
  action = signInWithGoogleAction,
  next,
}: {
  label: string;
  action?: (formData: FormData) => Promise<void>;
  /** where to land after sign-in; checked again server-side */
  next?: string;
}): React.ReactElement => (
  <form action={action}>
    {next && <input type="hidden" name="next" value={next} />}
    <Button type="submit" variant="secondary" className="w-full">
      <GoogleGlyph />
      {label}
    </Button>
  </form>
);
