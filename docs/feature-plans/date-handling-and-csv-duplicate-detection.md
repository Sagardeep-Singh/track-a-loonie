# Date handling and CSV duplicate detection

Duplicate transactions in a CSV import are being missed because the dedupe key
compares dates in different shapes. This plan fixes that bug first, then tightens
date handling across the app so every "calendar date" goes through one helper and
is stored as UTC midnight.

## Root cause

`lib/services/csvImport.ts:duplicateKey` builds the key from
`accountId|YYYY-MM-DD|amount|payee`, but the date part is taken differently per
side:

- **Existing DB rows**: `date.toISOString().slice(0, 10)`, so always `2026-10-05`.
- **Preview rows**: `row.date` is the _raw CSV string_ (validator is
  `z.string()`), and the key does `row.date.slice(0, 10)` on it as is. Any bank
  format that is not ISO (`10/05/2026`, `05/10/2026`, `Oct 5, 2026`,
  `2026-10-5`, `20261005`) produces a key like `10/05/2026` that can never match.
  This is the main reason duplicates are missed at preview.
- **Parsing**: the row date is parsed with `new Date(raw)`. For non-ISO strings
  and ISO strings without a `Z` (`2026-10-05T00:00:00`) JS uses the _server's
  local timezone_, so the stored value is not UTC midnight. On a server east of
  UTC this lands on the previous UTC day, so the stored date (and its key) is off
  by one.
- **Ambiguity**: `new Date('05/10/2026')` is always read as May 10 (US order).
  A Canadian bank exporting `DD/MM/YYYY` gets the wrong date stored, and a later
  import of the same account from a different export (or the same bank after a
  format change) will not match.

Commit-time dedupe hides part of this because `importRowSchema` coerces to a
`Date` first, but preview still shows the row as "not a duplicate" and checks it,
so it gets imported unless the commit re-check happens to catch it.

## Goals

- One shared parser turns any supported CSV date into a canonical `YYYY-MM-DD`
  and a UTC-midnight `Date`. No `new Date(raw)` on user-supplied strings anywhere.
- Preview and commit build the dedupe key from the same canonical date.
- The user picks (or confirms) the CSV's date format when it is ambiguous.
- Rows with an unparseable date are reported, not silently turned into
  `Invalid Date`.
- Small follow-ups for other date drift spots found during the audit.

## Non-goals

- Fuzzy "same transaction, posted a day later" matching (see open question 1).
- Storing a per-user timezone.
- Changing `prisma/schema.prisma` (the column stays `DateTime`; only a data
  migration is added).

## Plan

### Phase 1: fix the import dedupe bug

- [x] `lib/date.ts`: add calendar-date helpers, all UTC:
  - `toDateKey(date: Date): string` (`YYYY-MM-DD` from UTC parts). Replaces the
    scattered `toISOString().slice(0, 10)` calls in services.
  - `fromDateKey(key: string): Date` (UTC midnight; throws/returns null on an
    invalid calendar date like `2026-02-30`).
  - `todayDateKey(now?: Date): string` in the _local_ zone, for client defaults.
- [x] `lib/import.ts`: add `parseCsvDate(raw, format)` returning
      `YYYY-MM-DD | null`. Supported formats: `YYYY-MM-DD` (also with time and
      `/`), `MM/DD/YYYY`, `DD/MM/YYYY`, `YYYYMMDD`, `MMM D, YYYY` / `D MMM YYYY`.
      Two-digit years read as 20xx. Trims whitespace and strips a trailing time
      part. Validates the calendar date (no rollover of `02/30`).
- [x] `lib/import.ts`: add `detectCsvDateFormat(samples)` that inspects the
      date column and returns the format(s) consistent with every sample (for
      example a `13` or higher in the first slot rules out `MM/DD`). Returns
      `'ambiguous'` when both `MM/DD` and `DD/MM` fit every sample.
- [x] `components/import/import-view.tsx`: after the date column is chosen,
      run detection and show a "Date format" select (prefilled with the
      detected format, required when ambiguous). Normalize each row with
      `parseCsvDate` before posting to preview, so the API only ever gets
      `YYYY-MM-DD`. Rows that fail to parse (e.g. a "Total" footer) are skipped and
      called out with their line numbers; detection picks the format that
      reads the most rows, so one stray line doesn't sink it.
- [x] `lib/validators/csv-import.ts`: `rawImportRowSchema.date` becomes a strict
      `YYYY-MM-DD` string (`dateKeySchema` in new `lib/validators/date.ts`).
      `importRowSchema.date` uses `calendarDateSchema`, which also accepts the
      ISO timestamp the client echoes back from preview and reduces it to its
      UTC day.
- [x] `lib/services/csvImport.ts`:
  - `duplicateKey` takes a `Date` only and uses `toDateKey`. Preview converts
    with `fromDateKey` first, so both sides share one code path.
  - Replace `new Date(r.date)` / `new Date(row.date)` with `fromDateKey`.
  - Keep the ±1 day padding on `loadExistingKeys` (covers legacy rows below).
- [x] Legacy data: data migration
      `prisma/migrations/20261008120000_normalize_transaction_dates` snaps
      `Transaction.date` and `ImportBatch.dateFrom/dateTo` to the nearest UTC
      midnight (same pattern as `normalize_user_emails`). No-op on clean rows.

### Phase 2: tighten the rest of the app's date handling

- [x] `components/transactions/transaction-form.tsx` and
      `log-a-spend-mobile.tsx`: `todayIso()` uses UTC, so after ~8pm in
      Eastern time the "today" default is tomorrow. Switch to `todayDateKey()`
      (local calendar day).
- [x] `lib/validators/transactions.ts`: `date: z.coerce.date()` accepts any
      string and parses non-ISO input in server-local time. Use the same strict
      `YYYY-MM-DD` to UTC midnight transform as the import validator.
- [x] `lib/validators/transfers.ts` (`matchTransfersRequestSchema`) and the
      `from`/`to` in `lib/validators/transactions.ts:195`: same strict date
      transform.
- [x] `components/transactions/match-transfers-dialog.tsx` presets: compute
      from the local calendar day, not `toISOString()`.
- [x] Replace remaining `toISOString().slice(0, 10)` for calendar dates
      (`lib/transactions/transaction-scope.ts:dayKey`,
      `lib/services/categorize.ts`) with `toDateKey` so there is one helper.
- [x] Leave `lib/transactions/transaction-filters.ts:getCurrentMonthRange` on
      local time (it is the user's "this month"), but document why it differs.

### Tests

- [x] `tests/unit/lib/import.test.ts`: `parseCsvDate` for each format, two-digit
      years, whitespace, trailing time, invalid dates (`02/30/2026`, `13/13/2026`,
      empty, garbage). `detectCsvDateFormat` for unambiguous US, unambiguous
      DD/MM, ambiguous, mixed/invalid samples.
- [x] `tests/unit/lib/date.test.ts`: `toDateKey`, `fromDateKey` (invalid
      dates), `todayDateKey` near midnight with a fixed `now`.
- [x] `tests/unit/services/csvImport.test.ts`: preview flags a duplicate when
      the existing row is `2026-10-05T00:00:00Z` and the CSV row is the same day
      (regression for this bug); legacy row stored at `2026-10-05T04:00:00Z`
      still matches; in-file duplicate detection still works; commit re-check
      uses the same key.
- [x] `tests/unit/validators/date.test.ts` (new) plus cases in
      `csvImport.test.ts` and `validators/transactions.test.ts`: rejects
      non-ISO and invalid calendar dates; accepts `YYYY-MM-DD` and yields UTC
      midnight.
- [x] Run tests with `TZ=Asia/Kolkata`, `TZ=America/Vancouver` and `TZ=Pacific/Auckland` once to prove
      nothing depends on the server zone.
- [x] e2e (`tests/e2e/import-date-formats.spec.ts`, new): import a `DD/MM/YYYY` CSV, re-import
      it, every row is flagged duplicate; ambiguous file requires a format
      pick; a bad date is skipped and called out.
- [x] `npm run format:fix && npm run lint`, `npm run test`.
- [ ] `npm run test:e2e` (no database in the dev container; runs in CI).

## Open questions

Decided: auto-detect, with a required pick only when the dates read both
ways (1), and normalize legacy rows with a data migration (2). Still open:

1. **Posting-date drift**: some banks re-export a pending transaction with a
   posting date one or two days later. If that shows up, a follow-up could flag
   a "possible duplicate" (same account, amount and payee within ±2 days) at
   preview, unchecked by default but not auto-skipped.
2. **Payee normalization**: the key also compares payee exactly. Trimming,
   case-folding and collapsing whitespace would be cheap to add.
3. **Remember the format per account**: not done; detection covers most files.
