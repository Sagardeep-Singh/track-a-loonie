const UpgradeLayout = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <div className="bg-paper min-h-screen px-5 py-8 lg:px-10 lg:py-14">
    <div className="mx-auto max-w-[1040px]">{children}</div>
  </div>
);

export default UpgradeLayout;
