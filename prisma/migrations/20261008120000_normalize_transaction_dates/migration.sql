-- Transaction dates are calendar days stored as UTC midnight (see lib/date.ts).
-- CSV imports used to parse the bank's date with `new Date(raw)` on the server,
-- which reads non-ISO strings in the server's local timezone, so some rows were
-- stored a few hours off midnight (04:00 for a server in Eastern time, 18:30
-- the day before for one in India). The CSV duplicate check compares UTC days,
-- so those rows could slip past it.
--
-- Snap every such value to the *nearest* UTC midnight, which recovers the
-- original calendar day for any server offset from UTC-12 to UTC+11:59. An
-- exact 12:00 tie keeps its own day (offset -12:00 rather than +12:00, since
-- this app's users are mostly west of UTC). Rows already at midnight are not
-- touched, so this is a no-op on a clean database.
UPDATE "Transaction"
SET "date" = date_trunc('day', "date" + interval '12 hours' - interval '1 millisecond')
WHERE "date" <> date_trunc('day', "date");

UPDATE "ImportBatch"
SET "dateFrom" = date_trunc('day', "dateFrom" + interval '12 hours' - interval '1 millisecond')
WHERE "dateFrom" <> date_trunc('day', "dateFrom");

UPDATE "ImportBatch"
SET "dateTo" = date_trunc('day', "dateTo" + interval '12 hours' - interval '1 millisecond')
WHERE "dateTo" <> date_trunc('day', "dateTo");
