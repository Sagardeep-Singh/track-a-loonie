# Bank Feed Integration (Plaid)

## Status: architected, ready for ui-designer phase (see checklist)

Designed against the locked user decisions below. Anything this document adds beyond
those decisions is marked **[architect addition — flagged, not assumed]**. Anything that
still needs a product/user call before implementation is marked
**[NEEDS PRODUCT CALL]** and is collected in one place in section 12.

---

## Locked decisions (from the user, not re-litigated here)

1. **Cost model: hard cap + manual approval.** Total linked accounts app-wide is capped
   at a config value. A link attempt beyond the cap is refused with a clear message, not
   silently queued.
2. **Provider: Plaid.** Link → `public_token` exchange → per-Item `access_token` →
   cursor-based transaction sync driven by a webhook.
3. **Account model: attach to existing `Account`.** A linked bank connection is an
   optional link on an existing `Account` row, the same coexistence posture CSV import
   already has. The user picks which existing `Account` a linked bank account maps to
   during the link flow. **No new account type, no parallel account entity.**
4. **Multi-account / multi-institution: unlimited per user.** Many Plaid Items across
   many institutions per user; the only ceiling is the app-wide cap from decision 1.

---

## Architect decisions (this document)

5. **Cap lives in an env var**, `BANK_LINK_MAX_ITEMS`, read server-side only. No
   admin/ops surface exists in this app (explicit PM non-goal), and adding a settable
   admin value would require an admin concept, a role, and a UI — all of which the PM
   ruled out. Unset ⇒ **fail closed**: linking is disabled and the UI says bank linking
   isn't available on this deployment, mirroring how `CRON_SECRET` and the VAPID keys
   already behave. Cap is enforced **inside** the `prisma.$transaction` that creates the
   link rows; the pre-check before issuing a link token is UX only, never enforcement.
6. **Sync-run identity: a new `SyncBatch` model**, not a reuse of `ImportBatch`. See
   tradeoff 11.1.
7. **Credential encryption: new `lib/crypto/bankTokens.ts`**, AES-256-GCM via Node
   `crypto`, new env var `BANK_TOKEN_ENCRYPTION_KEY` (base64, 32 bytes), per-record IV,
   `keyVersion` column for rotation. Nothing in this repo does encryption today; this is
   from scratch.
8. **Duplicate detection: two-tier.** Tier 1 is an exact match on a new
   `Transaction.plaidTransactionId`. Tier 2 (cross-source: sync row vs. a manual or
   CSV-imported row) is `accountId` + exact amount + **date within ±3 days** + normalized
   payee as a _tiebreaker_, never as an equality requirement. Details in 5.3.
9. **Pending transactions are not ingested.** Only `pending: false` rows become
   `Transaction` rows. A pending count/total is snapshotted on the connection for display
   only. Details and the reversal path in 5.4. **[NEEDS PRODUCT CALL — confirm]**
10. **Balance: display-only reconciliation.** Plaid's reported balance is stored with an
    `asOf` timestamp and shown _alongside_ the app's derived
    `startingBalance + net(transactions)`. It never overwrites `startingBalance` and never
    creates a plug transaction.
11. **Account-type mapping is validation, not translation.** Only depository and credit
    Plaid accounts may be linked; everything else is refused at link time. A
    Plaid-type/`AccountType` mismatch on the user's pick is blocked, not silently
    accepted. `AccountType` gains no new values (PM non-goal, outside authorization).
12. **Sync undo is the soft variant**, not CSV's hard block: it deletes every transaction
    in the run that is _not_ reimbursement-linked and reports the skipped count. Rationale
    in 11.3.
13. **Disconnect keeps already-synced transactions** and stops syncing — the same
    coexistence posture as CSV. The provider-side Item is removed best-effort.
14. **Initial lookback: 90 days**, overridable by `BANK_SYNC_INITIAL_LOOKBACK_DAYS`.
15. **Webhook validates and marks pending; a cron drains.** There is no queue in this app
    and real-time sync is a disclosed non-goal, so the webhook route does no ingestion
    work itself.

---

## Grounding in current code

Every claim here was read on this branch (`feat/bank-feed-integration`, cut from `main`).

- **`lib/crypto/secrets.ts` does not exist.** No encryption of any kind exists in this
  repo — `bcryptjs` hashing (`lib/services/password.ts`, `accountDeletion.ts`) and
  sha256 + `timingSafeEqual` comparison (`app/api/cron/reminders/route.ts`) are the only
  crypto in the tree. Token encryption is a from-scratch security surface.
- **`Account`** (`prisma/schema.prisma:54`) is plain manual: `name`, `type`,
  `startingBalance`, optional `statementDay`. No external-institution fields.
- **Balance is derived on read, never stored**: `toFrontendAccount`
  (`lib/services/accounts.ts:19-50`) computes `startingBalance + net(transactions)` and
  returns it as `balance`. It also derives `lastImportAt` from
  `importBatches { where: { status: 'ACTIVE' } }`.
- **`ImportBatch`** (`prisma/schema.prisma:162`): `filename` and `filenameNormalized`
  are both **non-null** and are the entire duplicate-import mechanism
  (`findActiveBatchByFilename`, `lib/services/importBatches.ts:68`). A sync run has no
  filename.
- **Row-level dedupe key is app-code only, no DB constraint**:
  `duplicateKey = accountId|YYYY-MM-DD|amount.toFixed(2)|payee`, **exact** payee
  (`lib/services/csvImport.ts:42-50`). `loadExistingKeys` bounds its scan to the row date
  range ±1 day (`csvImport.ts:66-84`).
- **`commitImport` stores `Math.abs(amount)`** plus a separate `TransactionType` enum
  (`csvImport.ts:229-230`). Sign handling is the caller's job.
- **`undoImportBatch` hard-blocks** on any reimbursement-linked transaction in the batch
  (`lib/services/importBatches.ts:143-153`) — the same "block, don't cascade" posture as
  `deleteAccount` (`lib/services/accounts.ts:124`).
- **`commitImport` fires `matchTransfers(userId, { from: dateFrom, to: dateTo })`** in a
  swallowing try/catch after the commit (`csvImport.ts:244-248`). `matchTransfers` pairs
  opposite-sign, equal-amount rows on _different_ accounts within
  `MATCH_WINDOW_DAYS = 5` (`lib/services/transfers.ts:10`).
- **Categorization** is `compileRuleMatcher` / `matchCategoryRule`
  (`lib/services/categorize.ts:6-33`), matched against `` `${payee} ${note}` ``.
  Unmatched rows land in `getCategorizeQueue`, which excludes
  `isTransfer` / `isPayment` / `skippedAt` rows. **There is no AI-suggestion path on this
  branch** to route to.
- **`lib/services/userData.ts` is a hard dependency of any new model**:
  `exportUserData` enumerates 7 models field-by-field (lines 8-180), `wipeUserData`
  deletes them in an explicit, ordered sequence (lines 198-206), and `importUserData`
  re-creates them with remapped ids (lines 238-373). A new model that is not added to all
  three leaks rows past a "full replace" import and past account deletion.
- **`app/api/cron/reminders/route.ts` is the only unauthenticated route precedent**:
  bearer secret, sha256 + `timingSafeEqual`, fail-closed 500 when the secret is unset.
  `vercel.json` holds a single cron entry.
- **No Plaid SDK in `package.json`.** Dependencies are lean (no HTTP client beyond
  `fetch`).

---

## User stories & acceptance criteria

(Condensed from the PM report; acceptance criteria here are the ones this architecture
is actually accountable for.)

### 1. Link a bank account

- User opens Settings → Bank connections → "Link a bank".
- Server issues a link token; client runs Plaid Link; client posts back the
  `public_token`.
- Server exchanges it, encrypts and stores the `access_token`, and returns the list of
  linkable provider accounts (depository/credit only — decision 11).
- User maps each provider account to one of _their existing_ `Account` rows. Unmapped
  provider accounts are simply not linked; no `Account` is auto-created.
- An `Account` can hold at most one provider account link; a provider account can be
  linked to at most one `Account`.
- Cap refusal (decision 1/5) is a clear, named error at the point of confirmation, and
  also pre-checked before the link token is issued so the user doesn't complete a bank
  auth flow just to be refused.

### 2. Initial sync

- On successful link, the connection is marked sync-pending; the next cron tick performs
  the first sync with a 90-day lookback (decision 14).
- The run is recorded as a `SyncBatch` with counts and a date range.

### 3. Ongoing sync

- Provider webhook marks the connection sync-pending; cron drains it (decision 15).
- Added rows are inserted (post-dedupe), modified rows update the matching row by
  `plaidTransactionId`, removed ids delete the matching row **unless** it is
  reimbursement-linked (then it is left alone and counted).

### 4. Re-auth on expiry

- Connection status flips to `REAUTH_REQUIRED` when the provider reports the item needs
  login; the connections UI shows an actionable "Reconnect" affordance that issues an
  update-mode link token for that item.
- Syncs for a `REAUTH_REQUIRED` connection are skipped, not retried into oblivion.

### 5. Disconnect

- Removes the provider-side item best-effort, clears the link fields on the `Account`,
  marks the connection `DISCONNECTED`, and **keeps** every already-synced transaction
  (decision 13).
- The connection row is retained so its sync history stays readable.

### 6. Duplicate detection

- A synced transaction that matches an existing manual/CSV row per 5.3 is skipped and
  counted in `skippedDuplicates` on the run.

### 7. Categorization on sync

- Every inserted row runs through the existing `CategoryRule` engine
  (`compileRuleMatcher`, compiled once per run). Unmatched rows land in the existing
  categorize queue with `categoryId: null`.

### 8. Sync history & undo

- Sync runs are listed with counts, date range, and status, in the same shape as import
  history.
- Undo is the soft variant of decision 12.

### 9. Pending vs. posted

- Pending rows are not ingested (decision 9). The connections UI shows a pending
  count/total from the last sync, labelled as not yet in the ledger.

### 10. Balance display

- Account detail shows both the derived balance and the provider-reported balance with
  its `asOf` time, and explains divergence rather than alarming (decision 10).

---

## Non-goals (this pass)

Inherited from the PM report, unchanged: replacing CSV import (stays first-class);
investment/loan/brokerage account types; any money-movement capability (read-only);
multi-currency; adopting the institution's category taxonomy; an admin/ops fleet view;
real-time sync guarantees (best-effort, disclosed); AI-assisted categorization. Added
here: no automatic `Account` creation during link; no balance auto-correction; no
per-user cap (the cap is app-wide only).

---

## Checklist

- [x] product-manager: scope, stories, non-goals, open questions
- [x] user decisions on provider, cost model, account model, multi-account posture
- [x] software-architect: schema, encryption design, dedupe, sync/undo semantics, routes
- [ ] **user: resolve the open product calls in section 12 before implementation starts**
- [ ] senior-developer: verify the Plaid API surface in section 13 against current docs;
      report any deviation before writing code
- [ ] ui-designer: connections list, link/mapping flow, cap-refusal state,
      re-auth state, sync history + undo modal, dual-balance display
- [ ] tester: unit test plan (`tests/unit/services/bank*.test.ts`,
      `tests/unit/lib/bankTokens.test.ts`) + e2e plan (`tests/e2e/bank-*.spec.ts`)
- [ ] senior-developer: implementation + tests + migration
- [ ] tester: review, edge cases

---

# Architecture

## 0. Cross-cutting invariants

- Request flow stays `route handler → Zod validator → service → prisma singleton`. No
  business logic in handlers; handlers auth-gate, parse, and map typed service errors to
  status codes.
- Every Prisma query in the new services scopes by `userId` — **with exactly one
  deliberate exception**, the app-wide cap count in 5.1, which is documented inline in
  the code so a future reviewer does not "fix" it into a per-user cap.
- Services return plain serializable objects (`FrontendBankConnection`,
  `FrontendSyncBatch`), never Prisma models. **No `Frontend*` type has a token field of
  any kind** — not encrypted, not masked, not redacted-present.
- The decrypted `access_token` exists only inside `lib/services/bankSync.ts` and
  `lib/plaid/client.ts` call frames. It is never returned, never logged, never put in an
  error message.
- Exported functions are arrow functions with explicit return types.

---

## 1. Schema

**Authorization:** the task explicitly authorizes the schema changes designed below. The
authorized set is: two new enums, two new models, four new nullable columns on `Account`,
two new nullable columns on `Transaction`. `Transaction.plaidTransactionId` is called out
separately in 12.3 because it is a column on an existing model that the task brief did not
enumerate — it is _required for sync correctness_ (see 5.2), so it is designed in, but
confirm it before migrating.

### 1.1 New enums

```prisma
enum BankConnectionStatus {
  ACTIVE
  /// provider says the item needs the user to log in again; syncs are skipped
  REAUTH_REQUIRED
  /// user disconnected, or the provider reported permission revoked. Terminal.
  DISCONNECTED
  /// the stored token could not be decrypted (key rotated away / lost). Behaves
  /// exactly like REAUTH_REQUIRED for the user: reconnect to fix.
  CREDENTIAL_ERROR
}

enum SyncBatchStatus {
  ACTIVE
  UNDONE
  /// the run failed partway; any rows it did insert are still attributed to it
  /// and are still undoable
  FAILED
}
```

### 1.2 New model — `BankConnection` (one per provider Item)

```prisma
/// one linked provider Item (one institution login). Holds the encrypted
/// long-lived access token and the sync cursor. Many per user, many per
/// institution — there is no single-connection limit (decision 4).
model BankConnection {
  id                String               @id @default(cuid())
  userId            String
  /// provider's item identifier; unique app-wide, so re-linking the same item
  /// under a second app user is refused rather than silently double-billed
  providerItemId    String               @unique
  /// AES-256-GCM ciphertext of the provider access token, serialized as
  /// "v<keyVersion>.<iv b64url>.<authTag b64url>.<ciphertext b64url>".
  /// Never leaves the service layer. Never appears in an export.
  accessTokenCipher String
  /// which BANK_TOKEN_ENCRYPTION_KEY generation encrypted this row; lets a
  /// rotation re-encrypt rows one at a time instead of atomically
  keyVersion        Int                  @default(1)
  institutionId     String?
  institutionName   String?
  status            BankConnectionStatus @default(ACTIVE)
  /// opaque provider cursor for incremental transaction sync. Null until the
  /// first successful run completes.
  syncCursor        String?
  /// set by the webhook, cleared by the cron drain. The whole queue is this
  /// boolean (decision 15) — no queue table, no job runner.
  syncPending       Boolean              @default(false)
  lastSyncedAt      DateTime?
  /// last provider-reported failure, for the connections UI. Provider error
  /// code only — never a token, never a raw provider payload.
  lastErrorCode     String?
  lastErrorAt       DateTime?
  createdAt         DateTime             @default(now())
  disconnectedAt    DateTime?

  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  accounts    Account[]
  syncBatches SyncBatch[]

  @@index([userId, status])
  @@index([syncPending, status])
}
```

`@@index([syncPending, status])` is the cron drain's only query and is deliberately
**not** `userId`-scoped — the drain iterates all users, exactly as
`sendDueReminders` already does.

### 1.3 New model — `SyncBatch` (one sync run)

```prisma
/// one sync run against one BankConnection. The bank-feed analogue of
/// ImportBatch, deliberately a separate model: ImportBatch.filename /
/// filenameNormalized are non-null and ARE the CSV duplicate-import gate, and a
/// sync run has no filename to put there (see tradeoff 11.1).
model SyncBatch {
  id                String          @id @default(cuid())
  userId            String
  connectionId      String
  status            SyncBatchStatus @default(ACTIVE)
  /// provider rows the run saw, before dedupe
  fetchedCount      Int             @default(0)
  /// rows actually inserted
  importedCount     Int             @default(0)
  /// rows dropped by dedupe (either tier — see 5.3)
  skippedDuplicates Int             @default(0)
  /// existing rows updated from the provider's "modified" set
  updatedCount      Int             @default(0)
  /// rows deleted from the provider's "removed" set
  removedCount      Int             @default(0)
  /// provider rows skipped because they were still pending (decision 9)
  pendingSkipped    Int             @default(0)
  /// min/max transaction date across the rows this run touched. Nullable: a run
  /// that touched nothing has no range (ImportBatch cannot express this, which
  /// is part of why this is a separate model).
  dateFrom          DateTime?
  dateTo            DateTime?
  /// provider error code when status is FAILED. Never a raw provider payload.
  errorCode         String?
  createdAt         DateTime        @default(now())
  completedAt       DateTime?
  undoneAt          DateTime?

  user         User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  connection   BankConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  transactions Transaction[]

  @@index([userId, createdAt])
  @@index([connectionId, createdAt])
}
```

### 1.4 `Account` changes (decision 3 — the link is a field, not a new entity)

```prisma
model Account {
  // ...existing fields unchanged...

  /// set when this account is linked to a provider account. Null for every
  /// manual/CSV-only account — linking is opt-in and coexists (decision 3).
  bankConnectionId  String?
  /// provider's account identifier within the item. Unique app-wide so one
  /// provider account can never be linked to two Account rows.
  providerAccountId String?  @unique
  /// last provider-reported balances, display-only (decision 10). NEVER written
  /// into startingBalance, never used to synthesize a transaction.
  providerBalance          Decimal?  @db.Decimal(12, 2)
  providerAvailableBalance Decimal?  @db.Decimal(12, 2)
  providerBalanceAsOf      DateTime?
  /// masked last-4 the provider reports, so the mapping UI can say which
  /// account this is without storing a full number
  providerAccountMask      String?

  bankConnection BankConnection? @relation(fields: [bankConnectionId], references: [id], onDelete: SetNull)

  @@index([bankConnectionId])
}
```

`onDelete: SetNull`, not Cascade: deleting a connection must **never** delete the user's
`Account` and its transaction history. Disconnect explicitly nulls the link fields
(5.6) — it does not rely on the FK.

### 1.5 `Transaction` changes

```prisma
model Transaction {
  // ...existing fields unchanged...

  /// provider transaction id for a synced row; null for manual and CSV rows.
  /// Required for sync correctness: the provider's "modified" and "removed" sets
  /// identify rows by this id and nothing else.
  plaidTransactionId String?
  syncBatchId        String?

  syncBatch SyncBatch? @relation(fields: [syncBatchId], references: [id], onDelete: SetNull)

  /// SCOPED to the user, deliberately NOT a bare app-wide @unique — see below.
  /// Postgres allows unlimited NULL combinations under a unique index, so manual
  /// and CSV rows are unaffected.
  @@unique([userId, plaidTransactionId])
  @@index([syncBatchId])
}
```

`onDelete: SetNull` mirrors `importBatch`. Undo is an explicit `prisma.$transaction`,
never a cascade.

**Why `plaidTransactionId` is scoped per user while `Account.providerAccountId` (1.4) is
app-wide — the asymmetry is intentional, not an oversight:**

- `Account.providerAccountId` **must** be app-wide unique: it is what makes the cap
  meaningful and what prevents the same provider account being linked twice and
  double-billed (5.1).
- `Transaction.plaidTransactionId` **must not** be. Provider transaction ids are unique
  _within an Item_, not globally, and two users on the same deployment (a household
  sharing an instance) can each link the same real bank account. A bare app-wide
  `@unique` would also break the re-link path 5.6 depends on: disconnect deliberately
  _preserves_ `plaidTransactionId` on kept rows so a later re-link's tier-1 dedupe
  recognizes them, and a second user's link would then collide with the surviving row.

**Consequence for 5.2 step 6 — normative:** because rows and the cursor commit
atomically, a single unexpected constraint violation would abort the whole transaction,
leave the cursor unadvanced, and cause the _next_ run to refetch the same page and fail
identically — a permanently wedged connection. So per-row insert failures must be
**caught and counted, never allowed to abort the batch**: insert defensively (upsert on
`userId_plaidTransactionId`, or catch the violation per row), increment
`skippedDuplicates`, and let the run complete so the cursor advances. The unit test plan
must include "one row violates the unique constraint ⇒ the rest of the run still commits
and the cursor advances."

### 1.6 `User` back-relations

`User` gains `bankConnections BankConnection[]` and `syncBatches SyncBatch[]` (required
by Prisma).

### 1.7 Migration

No backfill is required — every new column is nullable or has a default, and
`plaidTransactionId` / `providerAccountId` are NULL on every existing row, which a
Postgres unique index permits without conflict. A plain migration is therefore enough:

```bash
npm run prisma:migrate -- --name add_bank_feed
npm run prisma:generate
```

`prisma/seed.ts` was checked: it writes no bank fields and needs **no change**;
`npm run db:setup` stays green. `prisma/bootstrap-admin.ts` is likewise unaffected.

---

## 2. Credential encryption — `lib/crypto/bankTokens.ts` (new)

Nothing to extend; this is from scratch.

```ts
/** AES-256-GCM. Node's built-in crypto — no new dependency. */
export const encryptBankToken = (plaintext: string): { cipher: string; keyVersion: number };
export const decryptBankToken = (cipher: string) => string;
/** true when a usable key is configured; drives the "bank linking unavailable" UI */
export const isBankTokenEncryptionConfigured = (): boolean;
```

**Key.** `BANK_TOKEN_ENCRYPTION_KEY` — base64 of exactly 32 random bytes
(`openssl rand -base64 32`). Read lazily inside the functions, **not** at module load, so
a missing key is a caught service error rather than an import-time crash that takes the
whole app down (this matters: `lib/crypto` will be imported transitively by the
connections page).

**Serialization.** `v<keyVersion>.<iv b64url>.<authTag b64url>.<ciphertext b64url>`.
Four dot-separated parts, version first so a rotation is parseable. Random 12-byte IV per
record — never reused, never derived from the row id. The GCM auth tag is stored, not
recomputed, so tampering is detected on decrypt.

**Fail closed.** Key unset or not 32 bytes ⇒ `encryptBankToken` throws
`BankFeedUnavailableError`; the link route returns 503 with a clear message and the UI
says bank linking isn't available on this deployment. Same posture as `CRON_SECRET` in
the reminders cron. **No plaintext fallback path exists in the code**, so a
misconfiguration cannot degrade into storing a bare token.

**Rotation.** `keyVersion` is a column, so rotation is: add
`BANK_TOKEN_ENCRYPTION_KEY_V2`, teach `decryptBankToken` to select the key by the parsed
version, encrypt new writes with the newest version, and re-encrypt old rows lazily —
each successful sync already loads and could rewrite its row. Not built this pass
(non-goal), but the column makes it a code change rather than a migration.

**Key loss.** Decryption failure is caught in `bankSync.ts` and flips the connection to
`CREDENTIAL_ERROR`, which the UI presents identically to `REAUTH_REQUIRED`: "Reconnect
this bank." The fix path is the one story 4 already builds. That is the whole disaster
story — no data is lost, only the connection, because every synced transaction is an
ordinary `Transaction` row that stands on its own.

**Never:** the ciphertext is not in `exportUserData` (2.1 below), not in any `Frontend*`
type, not in a log line, not in an error message.

### 2.1 `lib/services/userData.ts` impact (three separate required changes)

1. **`exportUserData`** — `BankConnection.accessTokenCipher` **must never appear in an
   export.** An export is a file that leaves the trust boundary, and an encrypted token
   in it is a credential-exfiltration path that is _also useless_ on restore, since a
   restore may happen under a different key. **Default taken: connections and sync
   batches are omitted from the export entirely**, and `Transaction.syncBatchId` /
   `Transaction.plaidTransactionId` are exported as `null`. Consequence: a restored
   transaction that originally came from a bank feed comes back as an ordinary
   transaction with no provenance, and the user re-links to resume syncing. See 12.1 —
   this default is deliberately conservative and is one of the two items flagged for a
   product call.
2. **`wipeUserData`** (the ordered delete sequence at `userData.ts:198-206`) gains, in
   this position:
   ```ts
   await tx.transaction.deleteMany({ where: { userId } });
   await tx.importBatch.deleteMany({ where: { userId } });
   await tx.syncBatch.deleteMany({ where: { userId } }); // new
   await tx.category.deleteMany({ where: { userId } });
   await tx.account.deleteMany({ where: { userId } });
   await tx.bankConnection.deleteMany({ where: { userId } }); // new, last
   ```
   `bankConnection` goes **after** `account` because `Account.bankConnectionId` is
   `SetNull` and deleting accounts first keeps the sequence deterministic.
3. **`USER_DATA_FORMAT_VERSION`** does not need to change under the omit-everything
   default, because no key is added to or removed from `userDataFileSchema` — a point in
   that default's favour. Two caveats to state rather than gloss: `importUserData` must
   give `syncBatchId` and `plaidTransactionId` the same explicit `null` treatment it
   already gives `importBatchId` (`userData.ts:320-321`), so a restored transaction never
   carries a dangling sync id; and the omission is forward-compatible only because the
   schema strips unknown keys — a future export that _does_ include connection metadata
   would be silently dropped by an older build, not rejected. If 12.1 is answered
   "export the metadata", the version **does** bump.

### 2.2 Provider-side revocation on every deletion path

Deleting rows locally leaves a **live, billable** Item at the provider that keeps sending
webhooks for a user who no longer exists. Three paths must revoke:

- `disconnectBankConnection` (5.6) — the explicit path.
- `deleteAccount` (`lib/services/accounts.ts:113`) — when the account being deleted holds
  the last link on its connection, disconnect that connection too.
- `deleteUserAccount` (`lib/services/accountDeletion.ts`) — revoke every one of the
  user's connections **before** `wipeUserData` runs, while the tokens are still readable.

All three are **best-effort**: wrap in try/catch, log the provider error code, continue
with the local deletion. A provider outage must not block a user from deleting their own
data. Non-revoked items are an accepted, named residue (risk 14.4).

---

## 3. Provider client — `lib/plaid/client.ts` (new)

**Recommendation: raw `fetch` behind a thin module, no SDK dependency.** `package.json`
is deliberately lean and CLAUDE.md says extend before abstracting. The calls are four
JSON POSTs; the SDK's genuine value is its webhook-verification helper, and that is one
JWT/JWK verification we can do with `jose`… which is _also_ a new dependency. See
tradeoff 11.6 — the decision is raw `fetch` + a documented webhook verification step, and
senior-developer is authorized to add the official SDK instead **if** verification proves
materially harder than this assumes, reporting the change.

The module owns: base URL from `PLAID_ENV`, `PLAID_CLIENT_ID` / `PLAID_SECRET` headers,
JSON encode/decode, typed errors. It contains **no business logic and no Prisma access**.
It exposes one function per provider operation listed in section 13.

`PLAID_CLIENT_ID` / `PLAID_SECRET` unset ⇒ `isBankFeedConfigured()` is false and the
whole feature is hidden, exactly like the Google provider and reminders already do.

---

## 4. Validators

### 4.1 `lib/validators/bank-connections.ts` (new)

```ts
export const createLinkTokenSchema = z.object({
  /** present for update-mode (story 4 re-auth); absent for a fresh link */
  connectionId: z.string().min(1).optional(),
});

export const exchangePublicTokenSchema = z.object({
  publicToken: z.string().min(1),
});

/** the user's provider-account → existing-Account mapping (decision 3) */
export const linkAccountMappingSchema = z.object({
  providerAccountId: z.string().min(1),
  accountId: z.string().min(1),
});

export const completeLinkSchema = z.object({
  connectionId: z.string().min(1),
  mappings: z.array(linkAccountMappingSchema).min(1).max(50),
});

export const disconnectSchema = z.object({
  /** decision 13 is the only supported behavior this pass; the flag exists so
   * the UI must state it, not so it can be changed */
  keepTransactions: z.literal(true).default(true),
});

export const listSyncBatchesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
```

Mirrors `listImportBatchesQuerySchema` exactly, so history pagination is one pattern.

### 4.2 Webhook body — `lib/validators/bank-webhook.ts` (new)

Deliberately **permissive**: parse only the discriminators the route acts on, and ignore
unknown fields rather than rejecting them (a provider adding a field must not 400 the
webhook and cause retries).

```ts
export const bankWebhookSchema = z
  .object({
    webhook_type: z.string().min(1),
    webhook_code: z.string().min(1),
    item_id: z.string().min(1),
    error: z.object({ error_code: z.string() }).nullish(),
  })
  .loose();
```

---

## 5. Services

### 5.1 `lib/services/bankConnections.ts` (new) — link, cap, list, disconnect

```ts
export type FrontendBankConnection = {
  id: string;
  institutionName: string | null;
  status: 'ACTIVE' | 'REAUTH_REQUIRED' | 'DISCONNECTED' | 'CREDENTIAL_ERROR';
  linkedAccounts: Array<{
    accountId: string;
    accountName: string;
    providerAccountMask: string | null;
    providerBalance: string | null;          // decimal string, display-only
    providerBalanceAsOf: string | null;      // ISO
  }>;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  disconnectedAt: string | null;
};
// NOTE: no token field of any kind. Not encrypted, not masked, not present.

export const listBankConnections = (userId: string): Promise<FrontendBankConnection[]>;

/** Remaining app-wide link capacity. Drives the pre-check and the UI copy. */
export const getLinkCapacity = (): Promise<{ cap: number; used: number; remaining: number }>;

/** Fresh link, or update-mode re-auth when connectionId is given (story 4). */
export const createLinkToken = (
  userId: string,
  input: CreateLinkTokenInput,
): Promise<{ linkToken: string; expiration: string }>;

/**
 * Exchanges the public token, encrypts and stores the access token, and returns
 * the provider accounts that are *eligible* to link (decision 11), each with the
 * reason any ineligible sibling was excluded.
 */
export const exchangePublicToken = (
  userId: string,
  input: ExchangePublicTokenInput,
): Promise<{ connectionId: string; linkableAccounts: LinkableProviderAccount[] }>;

/** Applies the user's mappings. This is where the cap is ENFORCED. */
export const completeLink = (
  userId: string,
  input: CompleteLinkInput,
): Promise<FrontendBankConnection>;

export const disconnectBankConnection = (
  userId: string,
  connectionId: string,
): Promise<FrontendBankConnection>;
```

**Cap enforcement (decision 1/5) — normative:**

```ts
const cap = Number(process.env.BANK_LINK_MAX_ITEMS);
if (!Number.isInteger(cap) || cap <= 0) throw new BankFeedUnavailableError(...);

await prisma.$transaction(async (tx) => {
  // DELIBERATELY NOT userId-scoped. The cap is app-wide (the deployment owner
  // pays the provider per connection), not per-user. Do not "fix" this into a
  // userId filter — see decision 1 and section 12.2.
  const used = await tx.account.count({ where: { providerAccountId: { not: null } } });
  if (used + input.mappings.length > cap) {
    throw new LinkCapReachedError(
      `This deployment is limited to ${cap} linked bank accounts and ${used} are already in use.`,
    );
  }
  // ...apply mappings...
});
```

The count runs **inside** the transaction that writes the links; `getLinkCapacity`'s
pre-check before issuing the link token is UX only, to avoid making a user complete a bank
auth flow just to be refused.

**`completeLink` validation, before anything is written:**

1. Every `accountId` in `mappings` resolves under `where: { id, userId }` — this is the
   ownership check, per the repo's no-permission-layer convention.
2. No mapped `Account` already has a non-null `providerAccountId` (one link per account).
3. No `providerAccountId` is already taken app-wide — the `@unique` is the real guard;
   catch the constraint violation and surface it as a typed error.
4. **Type compatibility (decision 11), blocking not advisory.** The provider's account
   type/subtype must be in the allowlist, and must be compatible with the `AccountType`
   the user picked:

   | Provider type                                 | Allowed app `AccountType` |
   | --------------------------------------------- | ------------------------- |
   | depository / checking                         | `CHECKING`                |
   | depository / savings, money market, CD        | `SAVINGS`                 |
   | depository / cash management, prepaid         | `CHECKING` or `CASH`      |
   | credit / credit card                          | `CREDIT_CARD`             |
   | credit / any other subtype                    | **refused**               |
   | loan, investment, brokerage, or anything else | **refused at link time**  |

   An unknown/unmapped subtype is **refused**, not defaulted — fail closed. Refusals are
   reported per-account with the provider's type in the message ("This looks like a loan
   account; Ledger only supports checking, savings, credit card, and cash"), so the user
   understands why an account from their bank isn't offered.
   A mismatch (provider says credit, user picked `SAVINGS`) throws
   `AccountTypeMismatchError` — we do **not** trust the pick, and we do **not** silently
   rewrite the user's `Account.type`.

**`disconnectBankConnection`** — see 5.6.

### 5.2 `lib/services/bankSync.ts` (new) — the sync engine

```ts
export type SyncRunResult = {
  batchId: string | null;
  imported: number;
  updated: number;
  removed: number;
  skippedDuplicates: number;
  pendingSkipped: number;
};

/** One connection, one run. Idempotent enough to be safely retried. */
export const syncConnection = (userId: string, connectionId: string): Promise<SyncRunResult>;

/** Cron drain (decision 15). Not userId-scoped — it iterates every user, like
 *  sendDueReminders already does. */
export const runPendingSyncs = (limit: number): Promise<{ connections: number; failures: number }>;

/** Webhook handler's only write: mark pending / flip status. Cheap, no provider call. */
export const recordWebhook = (
  providerItemId: string,
  webhookCode: string,
  errorCode: string | null,
): Promise<void>;
```

**`syncConnection` order of operations (normative):**

1. Load the connection `where: { id: connectionId, userId }`. Not found ⇒
   `ServiceValidationError`. Status `DISCONNECTED` ⇒ no-op return. Status
   `REAUTH_REQUIRED` / `CREDENTIAL_ERROR` ⇒ no-op return (do not burn provider calls on a
   connection that cannot succeed).
2. Decrypt the token. Failure ⇒ set `status: 'CREDENTIAL_ERROR'`, return a no-op result.
   **Do not throw the decryption error upward** — its message could carry key material
   detail into a log.
3. Create the `SyncBatch` row up front, `status: ACTIVE`. Creating it first means a run
   that dies mid-page still has its inserted rows attributed and therefore still undoable
   (this is exactly why `SyncBatchStatus` has a `FAILED` value).
4. Page the provider's cursor endpoint from `connection.syncCursor` (null on the first
   run) until it reports no more pages, accumulating `added` / `modified` / `removed`.
   Cap the page loop at a constant (e.g. 25 pages) so a pathological item cannot run
   forever in a serverless invocation; hitting the cap leaves `syncPending: true` so the
   next tick continues.
5. Map provider rows to app rows (5.5), dropping `pending: true` rows and counting them
   as `pendingSkipped` (decision 9).
6. Dedupe (5.3), categorize (5.5), insert, apply `modified`, apply `removed` (5.4) — all
   inside one `prisma.$transaction`, together with writing the new cursor and the batch
   counts. **The cursor and the rows commit atomically**: persisting a cursor for rows
   that failed to insert would silently lose those transactions forever.
7. On success: `status: ACTIVE`, `completedAt`, `lastSyncedAt`, `syncPending: false`,
   clear `lastErrorCode`. Refresh the provider-reported balances onto the linked
   `Account` rows (5.7).
8. On provider error: mark the batch `FAILED` with the provider's error code; if the code
   means "needs login", flip the connection to `REAUTH_REQUIRED`; if it means "permission
   revoked", flip to `DISCONNECTED`. Leave `syncPending` as-is for retryable errors.
9. **After** the transaction commits, fire `matchTransfers(userId, { from, to })` bounded
   to the batch's date range, in the same swallowing try/catch `commitImport` uses
   (`csvImport.ts:244-248`). This matters more here than for CSV: bank sync is the first
   scenario where both legs of a transfer arrive automatically across two linked
   accounts.

### 5.3 Duplicate detection (decision 8)

**Tier 1 — provider identity, exact.** A provider row whose `plaidTransactionId` already
exists on this user is not an insert. It is a candidate for the `modified` path or a
no-op. This is exact, cheap, index-backed, and is what makes repeated/overlapping syncs
safe.

**Tier 2 — cross-source, fuzzy.** A provider row with no `plaidTransactionId` match may
still be the same real-world transaction the user typed by hand or imported from CSV. The
existing `duplicateKey` (`csvImport.ts:42`) **cannot be reused as-is**: it requires an
exact payee match, and provider `merchant_name` / `name` strings essentially never equal a
user-typed or CSV-exported payee. Reusing it would make every synced transaction look new
on an account that also receives CSV imports — the single most likely failure of this
feature.

New matcher, in `lib/services/bankSync.ts` (not in `csvImport.ts` — the CSV key is
correct for CSV and must not change):

```ts
/** Candidate is the same transaction when ALL of:
 *  - same accountId
 *  - same type (INCOME/EXPENSE)
 *  - amount equal to the cent: Number(a).toFixed(2) === Number(b).toFixed(2)
 *  - |date difference| <= BANK_DEDUPE_DAY_TOLERANCE days
 * Payee is a TIEBREAKER among multiple candidates, never a requirement. */
const BANK_DEDUPE_DAY_TOLERANCE = 3;
```

- **±3 days**, not exact-day: the provider's transaction date and a statement/manual date
  genuinely differ by a business day or two. 3 is narrower than `transfers.ts`'s
  `MATCH_WINDOW_DAYS = 5` (which must absorb a weekend _plus_ a holiday between two
  different institutions' postings) and wide enough for a weekend. Stated tolerance, one
  constant, one place.
- **Amount must be exact to the cent.** No tolerance. A same-amount coincidence within 3
  days on the same account is overwhelmingly the same transaction; a near-amount match is
  overwhelmingly not.
- **Payee normalization** (tiebreaker only): lowercase, strip non-alphanumerics, collapse
  whitespace, drop trailing digit runs and common noise tokens (store numbers, `POS`,
  `DEBIT`, `PURCHASE`, city/state trailers). When two existing rows both satisfy the
  amount+date test, the one whose normalized payee shares the longest common prefix with
  the provider's normalized payee wins; ties break to the nearest date, then the oldest
  row. **Exported as a named function so it is unit-testable in isolation.**
- **Scan bounding** follows `loadExistingKeys` (`csvImport.ts:66-84`): load existing
  candidate rows once per run, bounded to the run's date range padded by
  `BANK_DEDUPE_DAY_TOLERANCE` days on each side, `where: { userId, accountId: { in: [...] } }`.
  Never an unbounded history scan.
- **Direction of the skip:** when tier 2 matches, the provider row is **skipped** and
  counted in `skippedDuplicates`. The user's existing row is left completely untouched —
  we do not back-fill `plaidTransactionId` onto it, because a false positive would then
  permanently bind a wrong row to a provider id and make future `modified`/`removed`
  events corrupt real data. Accepted cost: that transaction will never receive provider
  updates. **[architect addition — flagged, not assumed]**

### 5.4 Pending vs. posted (decision 9)

**Pending rows are not ingested.** Only `pending: false` rows become `Transaction` rows.

Rationale: a pending row's amount and payee both routinely change before it posts (tips,
holds, currency), so ingesting it means every pending row needs a mutate-or-replace
reconciliation against `pending_transaction_id`, plus the user editing/categorizing a row
that then changes underneath them, plus budgets and statement totals moving without user
action. Skipping pending costs the user visibility for 1-3 days and costs the
implementation nothing. This is the conservative default for a real-money app.

`pendingSkipped` is recorded per run, and the connection surfaces "N pending transactions
at your bank, not yet in your ledger" so the omission is visible, not silent.

**Reversal path if product wants pending rows later** (documented so the choice isn't a
dead end): insert pending rows with `plaidTransactionId` set, and on a later run, when a
posted row arrives carrying `pending_transaction_id`, look up the row whose
`plaidTransactionId` equals that value and **update it in place** to the posted id,
amount, and date — never insert-and-delete, which would lose the user's categorization.
That requires no schema change beyond what 1.5 already adds. **[NEEDS PRODUCT CALL — 12.4]**

**`modified` and `removed` handling (both tiers of posted rows):**

- `modified`: `updateMany({ where: { userId, plaidTransactionId }, data: { amount, type, date, payee } })`.
  **Do not touch `categoryId`, `note`, `isTransfer`, `isPayment`, `skippedAt`, or any
  reimbursement field** — those are the user's, not the provider's.
- `removed`: delete `where: { userId, plaidTransactionId: { in: removedIds } }`, **except**
  rows with an active reimbursement link, which are left in place and counted. Same
  "block, don't cascade" posture as everywhere else in this repo; a provider correction
  must not silently break a reimbursement the user built.

### 5.5 Provider row → `Transaction` mapping

- **`payee` = `merchant_name ?? name`.** One choice, and it drives three things: tier-2
  dedupe (5.3), `CategoryRule` matching, and display. `merchant_name` is the cleaner
  string when present; `name` is the raw descriptor fallback. `note` is left `null` —
  we do not stuff provider metadata into a user-facing field.
- **Sign → `TransactionType`** — the single most dangerous line in this feature. Plaid's
  convention is that a **positive** amount means money leaving the account (a debit /
  charge) and a **negative** amount means money arriving (a credit / payment / refund),
  **for both depository and credit accounts**. So:
  ```ts
  const type = providerAmount > 0 ? 'EXPENSE' : 'INCOME';
  const amount = Math.abs(providerAmount); // matches commitImport (csvImport.ts:229)
  ```
  Getting this backwards silently inverts every credit-card transaction, which no test of
  a checking account would catch. **Senior-developer must verify this convention against
  current provider docs for BOTH depository and credit accounts before implementing, and
  the unit test plan must include a credit-account charge and a credit-account payment as
  distinct cases.** See section 13.
- **`isPayment` / `isTransfer` are never set by sync.** `matchTransfers` sets `isTransfer`
  after the run (5.2 step 9); `isPayment` stays a user action.
- **Categorization** reuses the existing engine verbatim: load the user's `CategoryRule`
  rows once per run, `compileRuleMatcher` each once, and test `` `${payee} ${note ?? ''}` ``
  — the identical shape `previewImport` uses (`csvImport.ts:108-114`). No new matching
  mechanism. Unmatched ⇒ `categoryId: null` ⇒ the row appears in the existing categorize
  queue, which is exactly story 7.
- **Amount storage** matches CSV: `Math.abs(amount)` + the `type` enum. Never a signed
  amount.
- **Currency**: if the provider reports a currency other than the row's expected one, the
  row is **skipped and counted**, not converted — multi-currency is an explicit non-goal
  and silently ingesting a foreign-currency amount as if it were local is a money bug.

### 5.6 Disconnect (decision 13)

```ts
export const disconnectBankConnection = async (
  userId: string,
  connectionId: string,
): Promise<FrontendBankConnection> => {
  // 1. load where { id: connectionId, userId } — ownership check
  // 2. best-effort provider item removal (2.2); log the code, never block on it
  // 3. one prisma.$transaction:
  //      account.updateMany({ where: { userId, bankConnectionId: connectionId },
  //        data: { bankConnectionId: null, providerAccountId: null,
  //                providerBalance: null, providerAvailableBalance: null,
  //                providerBalanceAsOf: null, providerAccountMask: null } })
  //      bankConnection.update({ ..., status: 'DISCONNECTED', disconnectedAt: new Date(),
  //        accessTokenCipher: '', syncPending: false })
};
```

- **Transactions are kept** — they are real money that really happened, and this is the
  same coexistence posture CSV already has.
- `plaidTransactionId` on kept rows is **preserved**. Nulling it would let a re-link
  re-import everything as new; keeping it means a re-link's tier-1 dedupe recognizes them
  instantly. The `@unique` is not a problem because the provider reissues the same
  transaction ids for the same item.
- **The stored ciphertext is cleared** on disconnect. A disconnected item's token has no
  legitimate use, and not storing it is strictly better than storing it.
- `SyncBatch` rows are kept so sync history stays readable after disconnect.

### 5.7 Balance reconciliation (decision 10)

The app's balance is and stays **derived**: `startingBalance + net(transactions)`
(`accounts.ts:19-50`). Sync writes `providerBalance`, `providerAvailableBalance`, and
`providerBalanceAsOf` onto the linked `Account`, and `toFrontendAccount` gains:

```ts
providerBalance: string | null; // null for every unlinked account
providerBalanceAsOf: string | null;
```

**`balance` (derived) keeps its exact current meaning and computation. Nothing about
existing accounts changes.**

The UI shows both and explains divergence rather than alarming, because divergence is
_expected and legitimate_ for at least four reasons:

1. Pending transactions are excluded (decision 9) but are in the bank's balance.
2. The lookback window (decision 14) means transactions older than 90 days were never
   synced, so `startingBalance` is not the balance at the start of synced history unless
   the user set it that way.
3. Manual and CSV rows on the same account are in the derived balance and not in the
   bank's view of what it told us.
4. The provider's balance has its own `asOf` lag.

**Explicitly not built:** no plug/adjustment transaction, no `startingBalance` rewrite, no
"reconcile now" action. All three are silent-money-mutation features and are out of scope.
A "your derived balance differs by X" hint with the four reasons above is the whole
treatment.

### 5.8 `lib/services/syncBatches.ts` (new) — history and undo

Deliberately shaped as a near-mirror of `lib/services/importBatches.ts` so the history UI
and its tests are one pattern.

```ts
export type FrontendSyncBatch = {
  id: string;
  connectionId: string;
  institutionName: string | null;
  status: 'ACTIVE' | 'UNDONE' | 'FAILED';
  fetchedCount: number;
  importedCount: number;
  skippedDuplicates: number;
  updatedCount: number;
  removedCount: number;
  pendingSkipped: number;
  dateFrom: string | null;
  dateTo: string | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
};

export const listSyncBatches = (
  userId: string,
  query: ListSyncBatchesQuery,
): Promise<{ batches: FrontendSyncBatch[]; nextCursor: string | null }>;

export const getSyncBatch = (userId: string, batchId: string): Promise<FrontendSyncBatch>;

/** Soft undo (decision 12). Never throws on reimbursement links — it reports them. */
export const undoSyncBatch = (
  userId: string,
  batchId: string,
): Promise<{
  batch: FrontendSyncBatch;
  deletedTransactions: number;
  keptReimbursementLinked: number;
}>;
```

**`undoSyncBatch` is the soft variant, and the asymmetry with CSV is deliberate.** A CSV
batch is user-initiated: the user chose the file, so a hard block ("go unlink those
reimbursements first") is a reasonable thing to demand of them. A sync batch **arrives
unattended** — the user did not ask for these specific rows at this moment — so a hard
block leaves them stuck with an unwanted batch and no single action that clears it.
Instead:

```ts
await prisma.$transaction(async (tx) => {
  const linkedIds = await tx.transaction.findMany({
    where: {
      userId,
      syncBatchId: batchId,
      OR: [{ reimbursementExpenseLinks: { some: {} } }, { reimbursementIncomeLinks: { some: {} } }],
    },
    select: { id: true },
  });
  const deleted = await tx.transaction.deleteMany({
    where: { userId, syncBatchId: batchId, id: { notIn: linkedIds.map((t) => t.id) } },
  });
  // linked rows survive with syncBatchId intact, so they stay attributable
  const batch = await tx.syncBatch.update({
    where: { id: batchId },
    data: { status: 'UNDONE', undoneAt: new Date() },
  });
});
```

The undo confirmation copy must state both numbers ("Removes 41 transactions. 2 are linked
to reimbursements and will be kept."), and must carry the same warning
`import-batch-tracking.md` decision 6 established: edits made since sync — recategorized,
retyped, or skipped — are lost, because there is still no `updatedAt`/edit tracking on
`Transaction`.

Undo does **not** rewind the connection's `syncCursor`. Undone rows will therefore not
come back on the next sync (the provider has already reported them). That is the intended
semantic — undo means "I don't want these," not "fetch them again." A user who wants them
back re-links, which starts a fresh cursor. **[architect addition — flagged, not assumed]**

### 5.9 New typed errors — `lib/services/common.ts` (extend, don't create a new module)

```ts
/** No encryption key / no provider credentials configured on this deployment. 503. */
export class BankFeedUnavailableError extends Error {}

/** App-wide linked-account cap reached (decision 1). 409, message names the cap. */
export class LinkCapReachedError extends Error {}

/** Provider account type is not linkable, or conflicts with the chosen Account. 422. */
export class AccountTypeMismatchError extends ServiceValidationError {}

/** Provider call failed. Carries the provider's error CODE only — never a payload,
 *  never a token. 502. */
export class BankProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
  }
}
```

`AccountTypeMismatchError` subclasses `ServiceValidationError` so existing
`instanceof` checks still fire, following the `ReimbursementConflictError` precedent
(`common.ts:40`).

---

## 6. Routes

All session routes start with the existing `getServerAuthSession()` guard → 401. The
webhook route is the sole exception and is gated by a shared secret instead.

| Method | Path                                    | Purpose                                    |
| ------ | --------------------------------------- | ------------------------------------------ |
| GET    | `/api/bank/connections`                 | list connections + capacity (2 svc calls)  |
| POST   | `/api/bank/link-token`                  | create link token (fresh or update-mode)   |
| POST   | `/api/bank/connections/exchange`        | exchange public token → linkable accounts  |
| POST   | `/api/bank/connections/complete`        | apply mappings; **cap enforced here**      |
| POST   | `/api/bank/connections/[id]/disconnect` | disconnect, keep transactions              |
| POST   | `/api/bank/connections/[id]/sync`       | manual "sync now"                          |
| GET    | `/api/bank/sync-batches`                | paginated sync history                     |
| GET    | `/api/bank/sync-batches/[id]`           | run detail                                 |
| POST   | `/api/bank/sync-batches/[id]/undo`      | soft undo                                  |
| POST   | `/api/bank/webhook`                     | provider webhook — **no session**          |
| GET    | `/api/cron/bank-sync`                   | cron drain — **no session**, `CRON_SECRET` |

`GET /api/bank/connections` calls **both** `listBankConnections(userId)` and
`getLinkCapacity()` and returns `{ connections, capacity: { cap, used, remaining } }`.
Capacity is app-wide deployment state, **not** a property of a connection — do not fold it
into `FrontendBankConnection`. Composing two service reads in one handler is not business
logic and does not violate the thin-handler rule.

Status mapping: `ServiceValidationError` → 400/404 as today; `AccountTypeMismatchError` →
422 with `code: 'ACCOUNT_TYPE_MISMATCH'`; `LinkCapReachedError` → 409 with
`code: 'LINK_CAP_REACHED'` plus `{ cap, used }` so the UI can render the exact numbers;
`BankFeedUnavailableError` → 503 with `code: 'BANK_FEED_UNAVAILABLE'`;
`BankProviderError` → 502 with the provider code.

`POST`, not `DELETE`, on `/disconnect` and `/undo`: both are state transitions on a
retained row, following the `/api/import/batches/[id]/undo` precedent.

### 6.1 `POST /api/bank/webhook` — design

Two independent gates, both required:

1. **A shared secret in the webhook URL path or a header**, verified with
   sha256 + `timingSafeEqual`, copying `app/api/cron/reminders/route.ts:9-14` exactly.
   Env: `BANK_WEBHOOK_SECRET`. **Unset ⇒ 500, fail closed** — never an unauthenticated
   endpoint that can flip sync state for arbitrary items.
2. **The provider's own request verification** (signed JWT header + JWK — see section 13).
   Independent of gate 1; a valid secret with an invalid provider signature is rejected.

Behavior: parse permissively (4.2), call `recordWebhook`, **return 200 fast**. The route
does **no provider calls and no ingestion** — it sets `syncPending: true` (for sync-update
codes) or flips status (for login-required / permission-revoked codes) and returns.
Rationale: webhooks are retried on non-2xx, serverless invocations are time-bounded, and
ingestion under a retry storm is how you get duplicate work. Real-time sync is already a
disclosed non-goal.

An unknown `item_id` returns 200 and does nothing — a webhook for a disconnected item must
not 404 into a provider retry loop.

### 6.2 `GET /api/cron/bank-sync` — design

Copy of `app/api/cron/reminders/route.ts` verbatim in structure: `CRON_SECRET` bearer,
sha256 `timingSafeEqual`, fail-closed 500 when unset. Body calls
`runPendingSyncs(limit)`, which selects
`where: { syncPending: true, status: 'ACTIVE' }` (the `@@index([syncPending, status])`
from 1.2), takes a bounded page, and runs them sequentially with a per-connection
try/catch so one failing institution doesn't abort the drain.

`vercel.json` gains a second entry alongside the existing reminders cron:

```json
{
  "crons": [
    { "path": "/api/cron/reminders", "schedule": "0 13 * * *" },
    { "path": "/api/cron/bank-sync", "schedule": "0 */4 * * *" }
  ]
}
```

Every 4 hours is a starting point, not a requirement — best-effort sync is disclosed.
**Note for senior-developer: Vercel's Hobby plan limits cron frequency; confirm the
schedule is permitted on the target plan before committing to it.**

---

## 7. Changes to existing services

- **`lib/services/accounts.ts`** — `toFrontendAccount` gains `providerBalance`,
  `providerBalanceAsOf`, `bankConnectionId`, `institutionName`, and `lastSyncedAt`; the
  three `include` blocks gain `bankConnection: { select: { institutionName: true, lastSyncedAt: true, status: true } }`.
  **Trap, same class as the `app/api/transactions/route.ts` param list:**
  `toFrontendAccount`'s parameter is an inline structural type (`accounts.ts:19-28`) and
  it has **three** call sites — `listAccounts` (line 52), `createAccount` (line 64), and
  `updateAccount` (line 84), each with its own `include` block. Adding a field to the
  mapper breaks all three at compile time until every `include` matches; change the
  mapper signature and all three includes together.
  The `balance` computation is **unchanged**. `lastImportAt` stays CSV-only; sync recency
  is a separate field so the two ingestion paths remain distinguishable.
  `deleteAccount` gains the provider-revocation step from 2.2.
- **`lib/services/transactions.ts`** — `FrontendTransaction` gains
  `syncBatchId: string | null` and `sourceLabel`-style provenance alongside the existing
  `importBatchFilename`, so a row can say "from Chase sync" the way it already says "from
  march.csv". The shared `include` gains
  `syncBatch: { select: { id: true, connection: { select: { institutionName: true } } } }`.
  `listTransactionsQuerySchema` gains `syncBatchId` (and
  `app/api/transactions/route.ts`'s GET must add it to the enumerated search params — the
  handler reads params one by one, so schema + service alone is not enough; this is the
  exact trap `import-batch-tracking.md` section 5 documents).
- **`lib/services/accountDeletion.ts`** — revoke provider items before `wipeUserData`
  (2.2).
- **`lib/services/userData.ts`** — the three changes in 2.1.
- **`lib/services/csvImport.ts`** — **unchanged.** Its `duplicateKey` stays exactly as it
  is; the bank matcher is separate (5.3). This is deliberate: CSV dedupe is correct for
  CSV, and loosening it would change shipped behavior for a feature that isn't asking for
  it.
- **`lib/services/categorize.ts`** — **unchanged.** Sync imports `compileRuleMatcher` and
  reuses it, per CLAUDE.md's extend-before-abstract rule. No second matching mechanism.
- **`lib/services/transfers.ts`** — **unchanged.** Sync calls `matchTransfers` with a
  date range, the same way `commitImport` does.

---

## 8. Environment variables

`.env.example` gains one commented block, in the style of the existing VAPID / CRON
entries:

```bash
# optional: enables bank account linking (Plaid). All five must be set together —
# any one missing and the feature is hidden and every bank route returns 503.
# PLAID_CLIENT_ID="your-client-id"
# PLAID_SECRET="your-secret"
# PLAID_ENV="sandbox"                       # sandbox | production
# BANK_WEBHOOK_SECRET="replace-with-a-random-value"
# 32 random bytes, base64: `openssl rand -base64 32`. Encrypts the stored bank
# access tokens (AES-256-GCM). LOSING THIS VALUE MEANS EVERY LINKED BANK MUST BE
# RE-LINKED — no transaction data is lost, only the connections. Back it up
# separately from the database; a backup holding both is a backup holding
# plaintext credentials.
# BANK_TOKEN_ENCRYPTION_KEY="replace-with-32-random-bytes-base64"
#
# hard cap on TOTAL linked bank accounts across the whole deployment — the
# deployment owner pays the provider per connection. A link attempt past the cap
# is refused with a named error, never queued. Unset means bank linking is off.
# BANK_LINK_MAX_ITEMS="10"
# days of history requested on the first sync of a new connection. Default 90.
# BANK_SYNC_INITIAL_LOOKBACK_DAYS="90"
```

---

## 9. File-by-file breakdown

**Schema / migration**

- `prisma/schema.prisma` — _(modify)_ two enums, `BankConnection`, `SyncBatch`, four
  `Account` columns + relation, two `Transaction` columns + relation, two `User`
  back-relations.
- `prisma/migrations/<ts>_add_bank_feed/migration.sql` — _(new)_ plain
  `prisma migrate dev`; no backfill needed (1.7).
- `prisma/seed.ts` — **no change** (verified: writes no bank fields).

**Crypto / provider client**

- `lib/crypto/bankTokens.ts` — _(new)_ encrypt/decrypt/configured (section 2).
- `lib/plaid/client.ts` — _(new)_ thin `fetch` wrapper, no Prisma, no business logic
  (section 3).
- `lib/plaid/types.ts` — _(new)_ the provider response shapes we consume.

**Validators**

- `lib/validators/bank-connections.ts` — _(new)_ 4.1.
- `lib/validators/bank-webhook.ts` — _(new)_ 4.2.
- `lib/validators/transactions.ts` — _(modify)_ `syncBatchId` on the list query.

**Services**

- `lib/services/bankConnections.ts` — _(new)_ link, cap, list, disconnect (5.1, 5.6).
- `lib/services/bankSync.ts` — _(new)_ sync engine, dedupe, mapping (5.2-5.5).
- `lib/services/syncBatches.ts` — _(new)_ history + soft undo (5.8).
- `lib/services/common.ts` — _(modify)_ four typed errors (5.9).
- `lib/services/accounts.ts` — _(modify)_ balance fields + revocation on delete.
- `lib/services/transactions.ts` — _(modify)_ sync provenance + filter.
- `lib/services/accountDeletion.ts` — _(modify)_ revoke before wipe.
- `lib/services/userData.ts` — _(modify)_ export omission, wipe ordering, import nulls.

**Routes**

- `app/api/bank/connections/route.ts` — _(new)_ GET.
- `app/api/bank/link-token/route.ts` — _(new)_ POST.
- `app/api/bank/connections/exchange/route.ts` — _(new)_ POST.
- `app/api/bank/connections/complete/route.ts` — _(new)_ POST, 409 on cap.
- `app/api/bank/connections/[id]/disconnect/route.ts` — _(new)_ POST.
- `app/api/bank/connections/[id]/sync/route.ts` — _(new)_ POST.
- `app/api/bank/sync-batches/route.ts` — _(new)_ GET, cursor-paginated.
- `app/api/bank/sync-batches/[id]/route.ts` — _(new)_ GET.
- `app/api/bank/sync-batches/[id]/undo/route.ts` — _(new)_ POST.
- `app/api/bank/webhook/route.ts` — _(new)_ POST, no session (6.1).
- `app/api/cron/bank-sync/route.ts` — _(new)_ GET, `CRON_SECRET` (6.2).
- `app/api/transactions/route.ts` — _(modify)_ read the `syncBatchId` search param.

**Pages / components** (shapes only — `ui-designer` owns the visual spec)

- `app/(protected)/settings/` — _(modify)_ a "Bank connections" card, in the same slot
  pattern as the reminders card, hidden when the feature is unconfigured.
- `components/bank/bank-connections.tsx` — _(new)_ list, status/re-auth affordances,
  disconnect, capacity copy.
- `components/bank/link-flow.tsx` — _(new)_ client: Plaid Link launch + the
  provider-account → `Account` mapping step, including per-account refusal reasons.
- `components/bank/sync-history.tsx` — _(new)_ list + undo trigger, mirroring
  `components/import/import-history.tsx`.
- `components/bank/undo-sync-modal.tsx` — _(new)_ confirm copy naming both the deleted
  count and the kept-because-linked count (5.8).
- `components/accounts/*` — _(modify)_ dual-balance display (5.7).
- `.env.example` — _(modify)_ section 8. `vercel.json` — _(modify)_ 6.2.

**Tests** (senior-developer writes against the tester's plan)

- `tests/unit/lib/bankTokens.test.ts` — round-trip, tampered ciphertext rejected, wrong
  key rejected, missing key throws `BankFeedUnavailableError`, IV differs across two
  encryptions of the same plaintext, version prefix parsed.
- `tests/unit/services/bankConnections.test.ts` — cap refusal at the boundary
  (`used + n === cap` allowed, `+1` refused), cap counted app-wide not per-user,
  type allowlist per row of the 5.1 table, mismatch blocked, duplicate
  `providerAccountId` refused, disconnect keeps transactions and clears link fields and
  clears the ciphertext.
- `tests/unit/services/bankSync.test.ts` — tier-1 dedupe, tier-2 at ±3 days (2 days
  matches, 4 days does not), amount off by a cent does not match, payee tiebreaker,
  **credit-account charge → EXPENSE and credit-account payment → INCOME as separate
  cases**, pending skipped and counted, `modified` preserves `categoryId`, `removed`
  spares reimbursement-linked rows, cursor+rows commit atomically, decrypt failure ⇒
  `CREDENTIAL_ERROR` and no throw, `matchTransfers` called with the run's range.
- `tests/unit/services/syncBatches.test.ts` — pagination mirroring
  `importBatches.test.ts`, soft undo keeps linked rows and reports both counts, undo of
  an already-undone batch.
- `tests/unit/services/userData.test.ts` — _(extend)_ export contains no
  `accessTokenCipher` anywhere (assert on the serialized JSON string, not just the shape),
  wipe removes connections and sync batches.
- `tests/e2e/bank-link.spec.ts`, `tests/e2e/bank-sync-history.spec.ts` — provider calls
  stubbed at the `lib/plaid/client.ts` boundary.

---

## 10. Data flow summary

```
Link:     client → POST /api/bank/link-token → bankConnections.createLinkToken
                 → Plaid Link (client) → public_token
                 → POST /exchange → encryptBankToken → BankConnection row
                 → POST /complete → [cap check INSIDE $transaction] → Account link fields

Sync:     provider webhook → POST /api/bank/webhook → recordWebhook
                           → BankConnection.syncPending = true
          Vercel cron → GET /api/cron/bank-sync → runPendingSyncs
                      → syncConnection(userId, connectionId)
                      → decrypt → cursor pages → drop pending → dedupe (tier1, tier2)
                      → categorize (compileRuleMatcher) → $transaction{ insert + modify
                        + remove + cursor + SyncBatch counts } → matchTransfers(range)

Undo:     POST /api/bank/sync-batches/[id]/undo → undoSyncBatch
                      → delete unlinked rows, keep + count linked, status = UNDONE
```

Every Prisma query above is `where: { userId, ... }` scoped, except the two documented
app-wide queries: the cap count (5.1) and the cron drain's pending-connection select
(6.2).

---

## 11. Key tradeoffs

### 11.1 Separate `SyncBatch` model vs. a `source` enum on `ImportBatch`

**Chosen: separate model.** Reusing `ImportBatch` requires making `filename` and
`filenameNormalized` nullable — and those two columns are not incidental, they are the
entire CSV duplicate-import gate (`findActiveBatchByFilename`, `importBatches.ts:68`) and
they are enumerated as non-null in `userData.ts`'s export/import contract (lines 123-136,
288-306). Making them nullable changes the export format (version bump) and weakens a
shipped, tested mechanism for a feature that doesn't need it. `SyncBatch` also carries
fields `ImportBatch` cannot express (`syncCursor` linkage, `updatedCount`,
`removedCount`, `pendingSkipped`, a _nullable_ date range for an empty run).
**Cost, stated plainly:** a second nullable FK on `Transaction`, and four existing readers
must now handle both — `transactions.ts` provenance, `accounts.ts` `lastImportAt` (kept
CSV-only, with `lastSyncedAt` added separately), the undo services (deliberately different
semantics anyway, 11.3), and `userData.ts`. All four are enumerated in section 9. Verdict:
duplication in the new code beats destabilizing the shipped code.

### 11.2 Env-var cap vs. a settable admin value

**Chosen: env var.** There is no admin concept, no role, and no ops surface in this app,
and the PM lists an admin/fleet view as a non-goal. A settable value would require
inventing all three. An env var is also the right blast radius: the person who pays the
provider bill is the person who deploys.
**Cost:** changing the cap needs a redeploy, and the count is app-wide, which is the one
documented exception to `userId` scoping.

### 11.3 Soft sync undo vs. CSV's hard block

**Chosen: soft.** CSV's hard block is right for CSV because the batch is user-initiated —
the user chose that file, so demanding they clear the links first is a reasonable ask.
A sync batch arrives unattended; a hard block would leave the user holding a batch they
never asked for with no single action that removes it. The soft variant preserves the
actual invariant that matters (a reimbursement link is never silently broken) while still
letting the undo complete.
**Cost:** a partially-undone batch is a state `ImportBatch` can't be in, so the UI must
report two numbers, and `status: UNDONE` no longer strictly implies "zero rows remain."

### 11.4 Not ingesting pending rows

**Chosen: skip.** Covered in 5.4. **Cost:** 1-3 days of visibility lag and a permanent
source of legitimate balance divergence (5.7), both of which the UI must explain rather
than hide.

### 11.5 Tier-2 dedupe skips the provider row rather than adopting the existing one

**Chosen: skip, don't adopt.** Writing `plaidTransactionId` onto the user's existing row
would give it provider updates, but a tier-2 false positive would then permanently bind a
wrong row to a provider id, and every later `modified`/`removed` for that id would corrupt
real user data. Skipping keeps a false positive's damage to "one transaction never gets
provider updates."
**Cost:** exactly that.

### 11.6 Raw `fetch` vs. the official SDK

**Chosen: raw `fetch` behind `lib/plaid/client.ts`.** Four JSON POSTs against a lean
dependency list, consistent with CLAUDE.md's extend-before-abstract rule. The SDK's real
value is its webhook-verification helper.
**Cost, and the escape hatch:** if implementing signed-webhook verification by hand proves
materially harder than a JWK fetch + ES256 verify, senior-developer may add the official
SDK instead and report the deviation — this is a pre-authorized fallback, not a silent
one.

### 11.7 Webhook-marks + cron-drains vs. synchronous webhook ingestion

**Chosen: mark and drain.** No queue exists in this app and real-time sync is a disclosed
non-goal; ingesting synchronously in a retried, time-bounded serverless invocation is how
duplicate work and partial runs happen. **Cost:** up to one cron interval of latency.

---

## 12. Open items that need a product/user call before implementation

These are the ones where a wrong assumption costs real money or real credentials. They are
flagged, not silently defaulted.

**12.1 — RESOLVED: nothing about bank connections appears in the data export.**
Connections and sync batches are omitted entirely; `syncBatchId`/`plaidTransactionId`
export as `null`. Matches the existing treatment of BYOK API keys (excluded by omission).
The encrypted token was never going to be exported regardless (credential-exfil path,
useless on restore under a different key) — this resolves the remaining question of
whether non-secret metadata (institution name, status) should be, and the answer is no.

**12.2 — RESOLVED: the cap counts provider _Items_, not linked accounts.** `BANK_LINK_MAX_ACCOUNTS`
is renamed `BANK_LINK_MAX_ITEMS` and the check in 5.1 counts `BankConnection` rows
(one per Item), not `Account.providerAccountId` rows — this matches what the cap is
actually protecting against (per-Item billing), and lets a user link multiple accounts
at one bank without spending extra cap budget. Every reference to the env var name has
been updated throughout this doc to `BANK_LINK_MAX_ITEMS`; 5.1's query counts
`BankConnection` rows.

**12.3 — `Transaction.plaidTransactionId` is a column on an existing model that the task
brief did not enumerate.** It is designed in because the provider's `modified` and
`removed` sets identify rows by that id and nothing else — without it, sync cannot honor
corrections or removals at all, and tier-1 dedupe is impossible. Confirming it is
in-scope is a formality, but per CLAUDE.md it is flagged rather than assumed.

**12.4 — Confirm pending transactions are not ingested (decision 9).** 5.4 gives the
rationale and the exact reversal path if the answer is "show them." This changes what the
user sees day to day, so it is a product call, not an architecture one.

**12.5 — Provider environment and cost.** This plan assumes a sandbox-first rollout with
`PLAID_ENV` switchable. Who holds the production provider account and what the per-Item
cost is are outside this document but gate the cap's actual value.

---

## 13. Provider API surface — UNVERIFIED, confirm before implementation

**This section is recall, not verification.** No network access was available while
writing this plan, so every name below is stated from knowledge of Plaid's API as of the
author's cutoff and **must be checked against current Plaid documentation by
senior-developer before any code is written.** The _architecture_ above does not depend on
these exact names — it depends on the steps ("exchange the short-lived public token for a
long-lived access token", "fetch incremental changes with an opaque cursor") — so a name
change is a mechanical fix in `lib/plaid/client.ts`, not a redesign. Report any deviation
before implementing.

| Purpose                      | Endpoint (recalled)                                                                                     | Confidence                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Create a Link token          | `POST /link/token/create`                                                                               | high                                                   |
| Update-mode re-auth token    | same endpoint, with the item's `access_token`                                                           | high                                                   |
| Exchange public token        | `POST /item/public_token/exchange` → `access_token`, `item_id`                                          | high                                                   |
| Incremental transaction sync | `POST /transactions/sync` with `cursor` → `added` / `modified` / `removed` / `next_cursor` / `has_more` | high                                                   |
| Account list + balances      | `POST /accounts/get`, `POST /accounts/balance/get`                                                      | high                                                   |
| Remove item (revocation)     | `POST /item/remove`                                                                                     | high                                                   |
| Webhook verification key     | `POST /webhook_verification_key/get` (JWK; header is an ES256 JWT)                                      | **medium — verify carefully, this is a security gate** |

Fields the mapping in 5.5 depends on: `transaction_id`, `account_id`, `pending`,
`pending_transaction_id`, `amount`, `date`, `authorized_date`, `name`, `merchant_name`,
`iso_currency_code`. Webhook shape: `webhook_type`, `webhook_code`, `item_id`, `error`.
Webhook codes the design reacts to: a sync-updates-available code under
`webhook_type: TRANSACTIONS`, and item-level codes for login-required and
permission-revoked. Initial lookback is requested at link-token creation (recalled as a
`transactions.days_requested` option) — **verify; if it is not settable, the 90-day
lookback in decision 14 becomes a client-side filter on the first run instead, which is a
one-line change in `syncConnection`.**

**Highest-risk item to verify: the amount sign convention for credit accounts** (5.5).
Getting it backwards inverts every credit-card transaction silently.

---

## 14. Risks

1. **Sign-convention inversion on credit accounts** (5.5) — silent, money-wrong, and not
   caught by any checking-account test. Mitigated by the named unit cases in section 9 and
   the verification requirement in 13.
2. **Tier-2 dedupe false negatives** — a user who both CSV-imports and syncs the same
   account gets doubled transactions if the ±3-day/exact-amount test is too tight, and
   missing transactions if too loose. The tolerance is a single named constant so it can
   be tuned from feedback without a redesign.
3. **Encryption key loss** — every connection must be re-linked. No transaction data is
   lost. Mitigated by the `.env.example` warning (section 8) and by degrading into the
   `REAUTH_REQUIRED` path that story 4 already builds.
4. **Non-revoked provider items** after a provider outage during a deletion path (2.2) —
   the deployment keeps being billed for an item nobody uses, and webhooks keep arriving
   for it. Mitigated by the unknown-`item_id` no-op in 6.1; a reconciliation sweep is a
   named future item, not built.
5. **Cap is enforced app-wide with no per-user limit** — one user can consume the entire
   deployment's capacity. That follows directly from decision 1 + decision 4 and is
   accepted, but it is worth knowing before the first refusal reaches a second user.
6. **Cursor/rows atomicity** — persisting the cursor outside the insert transaction would
   silently and permanently lose transactions. 5.2 step 6 is normative, and the test plan
   asserts it.
7. **Webhook secret in a URL path** (if that form is chosen over a header) leaks into
   provider-side logs. Prefer a header if the provider supports one; the second gate
   (provider signature verification) is what makes this survivable either way.
8. **Undo does not rewind the cursor** (5.8) — undone rows never return. Intended, but it
   must be in the confirmation copy or it will read as data loss.

## 15. Implementation checklist (senior-developer)

- [x] **Section 12 resolved with the user.** 12.1: export omits connections/sync batches
      entirely. 12.2: cap counts provider Items (`BANK_LINK_MAX_ITEMS`), not accounts.
      12.3: `plaidTransactionId` confirmed in-scope. 12.4: pending rows not ingested,
      confirmed. 12.5 (provider prod account + per-Item cost) remains open — it doesn't
      block writing code, but gates the real value of `BANK_LINK_MAX_ITEMS` before this
      goes live with real bank data.
- [ ] **Verify section 13 against current Plaid docs**, especially the credit-account
      amount sign and the webhook verification mechanism. Report deviations.
- [ ] `lib/crypto/bankTokens.ts` + its unit tests **before** anything stores a token
- [ ] `prisma/schema.prisma`: two enums, `BankConnection`, `SyncBatch`, `Account` link +
      balance columns, `Transaction.plaidTransactionId` + `syncBatchId`, back-relations
- [ ] `npm run prisma:migrate -- --name add_bank_feed` (no backfill needed);
      `npm run prisma:generate`
- [ ] `lib/plaid/client.ts` + `lib/plaid/types.ts` (raw `fetch`; SDK fallback per 11.6)
- [ ] `lib/services/common.ts`: `BankFeedUnavailableError`, `LinkCapReachedError`,
      `AccountTypeMismatchError`, `BankProviderError`
- [ ] `lib/validators/bank-connections.ts`, `lib/validators/bank-webhook.ts`
- [ ] `lib/services/bankConnections.ts` — cap enforced **inside** the `$transaction`, with
      the "deliberately not userId-scoped" comment from 5.1 verbatim
- [ ] `lib/services/bankSync.ts` — dedupe tiers, pending skip, mapping, atomic
      cursor+rows, `matchTransfers` in a swallowing try/catch
- [ ] `lib/services/syncBatches.ts` — history + soft undo
- [ ] `lib/services/userData.ts` — export omission, `wipeUserData` ordering,
      `importUserData` nulls (**all three**)
- [ ] `lib/services/accounts.ts`, `accountDeletion.ts` — provider revocation on both
      deletion paths
- [ ] `lib/services/transactions.ts` + `app/api/transactions/route.ts` — sync provenance
      and the `syncBatchId` search param (schema + service + **handler param list**)
- [ ] Routes (section 6), incl. webhook double gate and the cron drain
- [ ] `.env.example` block, `vercel.json` cron entry (confirm plan frequency limits)
- [ ] UI per the ui-designer spec
- [ ] Tests per section 9 / the tester's plan
- [ ] `npm run format:fix && npm run lint && npm run test && npm run test:e2e`
