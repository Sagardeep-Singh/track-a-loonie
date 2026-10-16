import { ScreenHeader } from '@/components/nav/screen-header';

const pulse = 'bg-paper-sunk [animation:om-pulse_1.4s_ease-in-out_infinite]';
const ringPulse = 'border-paper-sunk rounded-full [animation:om-pulse_1.4s_ease-in-out_infinite]';

const DashboardLoading = (): React.ReactElement => (
  <div>
    <ScreenHeader title="Overview" description="Here's where things stand this month." />
    <div className="mt-6.5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
      <div className="flex flex-col gap-5">
        {/* no ring here: the hero is a ring in limits mode but a Ready to
            Assign card in zero-based mode, and the skeleton can't know which */}
        <div className="border-line bg-paper-raised rounded-[18px] border p-6.5">
          <div className={`h-[11px] w-[110px] rounded-md ${pulse}`} />
          <div className={`mt-3.5 h-[40px] w-full max-w-[260px] rounded-lg ${pulse}`} />
          <div className={`mt-4 h-[11px] w-full max-w-[320px] rounded-md ${pulse}`} />
          <div className="border-line mt-5 grid grid-cols-3 gap-4 border-t pt-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <div className={`h-[10px] w-12 rounded-md ${pulse}`} />
                <div className={`mt-2 h-[18px] w-20 rounded-md ${pulse}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="border-line bg-paper-raised grid grid-cols-4 gap-2.5 rounded-[18px] border p-6.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex min-w-0 flex-col items-center gap-2.5">
              <div
                className={`h-[66px] w-[66px] border-[7px] lg:h-[88px] lg:w-[88px] lg:border-[9px] ${ringPulse}`}
              />
              <div className={`h-2.5 w-16 rounded-md ${pulse}`} />
            </div>
          ))}
        </div>
        <div className={`border-line bg-paper-raised h-[150px] rounded-[18px] border ${pulse}`} />
      </div>
      <div className="flex flex-col gap-5">
        <div className={`border-line bg-paper-raised h-[280px] rounded-[18px] border ${pulse}`} />
        <div className={`border-line bg-paper-raised h-[150px] rounded-[18px] border ${pulse}`} />
      </div>
    </div>
  </div>
);

export default DashboardLoading;
