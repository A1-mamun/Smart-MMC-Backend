-- Make User.mobile and Student.mobile globally unique.
--
-- Why both:
--   * User.mobile is the new login identifier; uniqueness here is the
--     canonical "one account per phone" guarantee. The previous
--     `users_mobile_idx` was a non-unique btree index used only for
--     lookup performance — it did NOT prevent duplicate rows. The
--     existing comment on User.mobile in schema.prisma described an
--     intent that was never actually applied.
--   * Student.mobile carries the same phone and is the dedup key used
--     by the `enroll-existing` flow (it matches an incoming admit by
--     mobile and reuses the existing Student row). Adding @unique
--     here is a defensive duplicate safeguard against bad imports or
--     accidental double-admits that bypass the User flow. The
--     enroll-existing flow reuses a Student row by mobile rather than
--     creating a new one, so this never blocks legitimate re-admits.
--
-- Postgres treats NULL values as distinct in a UNIQUE index, so the
-- many admin User rows with NULL mobile continue to coexist (matching
-- the original comment's intent).
--
-- Pre-flight (run before applying this migration):
--   SELECT mobile, COUNT(*) FROM users    WHERE mobile IS NOT NULL GROUP BY mobile HAVING COUNT(*) > 1;
--   SELECT mobile, COUNT(*) FROM students WHERE isDeleted = false       GROUP BY mobile HAVING COUNT(*) > 1;
-- Both queries returned 0 rows on the live database at the time of
-- writing, so the constraint can be applied without dedup.
--
-- The previous non-unique `users_mobile_idx` / `students_mobile_idx`
-- indexes are dropped because the new unique indexes cover the same
-- lookup paths and Postgres can reuse them transparently.

CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");
CREATE UNIQUE INDEX "students_mobile_key" ON "students"("mobile");

DROP INDEX "users_mobile_idx";
DROP INDEX "students_mobile_idx";
