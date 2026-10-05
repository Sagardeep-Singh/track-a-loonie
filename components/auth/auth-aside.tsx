import { LogoMark } from '@/components/ui/logo-mark';
import { Ring } from '@/components/ui/ring';

/** The brand panel on the left of the sign-in, forgot-password and reset-password pages. */
export const AuthAside = (): React.ReactElement => (
  <div className="bg-iris-soft mx-5 mt-5 flex flex-col justify-between rounded-3xl p-6 lg:mx-0 lg:mt-0 lg:rounded-none lg:p-14">
    <div className="font-display flex items-center gap-2.5 text-[20px] font-semibold">
      <LogoMark size={30} variant="spiral" />
      trackaloonie
    </div>
    <div>
      <div className="hidden lg:block">
        <Ring size="hero" fraction={0.56} />
      </div>
      <h1 className="font-display mt-[18px] max-w-[400px] text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] lg:mt-7 lg:text-[34px]">
        Know what&rsquo;s left, not just what&rsquo;s gone.
      </h1>
      <p className="text-ink/75 mt-2.5 max-w-[420px] text-[13.5px] leading-snug lg:mt-3.5 lg:text-[15px]">
        Import a statement, confirm a few categories, and Track a Loonie keeps the rest of the month
        honest.
      </p>
    </div>
    <div className="text-ink/60 mt-6 hidden text-[12.5px] lg:block">
      Your data stays in your account. No bank credentials are stored.
    </div>
  </div>
);
