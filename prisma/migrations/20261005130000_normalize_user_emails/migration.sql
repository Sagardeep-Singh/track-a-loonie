-- Store every address in its canonical form (trimmed, lowercased), matching
-- `normalizeEmail` in lib/validators/email.ts, which all writes and lookups
-- now go through.
--
-- If two accounts differ only by case or surrounding spaces, lowercasing
-- would collide on the unique index. Stop with a clear message instead, so
-- they can be merged or one renamed by hand before re-running.
DO $$
DECLARE
  collisions INTEGER;
BEGIN
  SELECT COUNT(*) INTO collisions
  FROM (
    SELECT lower(trim("email"))
    FROM "User"
    GROUP BY lower(trim("email"))
    HAVING COUNT(*) > 1
  ) AS duplicated;

  IF collisions > 0 THEN
    RAISE EXCEPTION
      'normalize_user_emails: % address(es) are shared by more than one account once lowercased. Find them with: SELECT lower(trim(email)) AS normalized, array_agg(id) FROM "User" GROUP BY 1 HAVING COUNT(*) > 1;',
      collisions;
  END IF;
END $$;

UPDATE "User"
SET "email" = lower(trim("email"))
WHERE "email" <> lower(trim("email"));
