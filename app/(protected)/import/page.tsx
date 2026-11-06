import Link from 'next/link';
import { getServerAuthSession } from '@/lib/auth/session';
import { listAccounts } from '@/lib/services/accounts';
import { listCategories } from '@/lib/services/categories';
import { ImportView } from '@/components/import/import-view';

const ImportPage = async (): Promise<React.ReactElement> => {
  const session = await getServerAuthSession();
  const userId = session!.user.id;
  const [accounts, categories] = await Promise.all([listAccounts(userId), listCategories(userId)]);

  return (
    <div className="animate-[fade-up_0.3s_ease-out]">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="font-display text-ink text-2xl font-semibold">Import CSV</h1>
          <p className="text-ink-muted mt-1 text-sm">
            Upload a CSV, map its columns, review the auto-categorized preview, then commit.
          </p>
        </div>
        <Link href="/import/history" className="text-iris shrink-0 text-sm hover:underline">
          History
        </Link>
      </div>
      <ImportView
        // balance-tracked accounts don't take transactions
        accounts={accounts.filter((a) => !a.tracksBalance)}
        categories={categories}
      />
    </div>
  );
};

export default ImportPage;
