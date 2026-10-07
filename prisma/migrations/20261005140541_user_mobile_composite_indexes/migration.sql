-- Reorganize the User model indexes for the post-`User.studentId` schema.
--
-- Why these changes:
--   - `mobile` is the canonical login handle for every account type
--     (student / admin / super admin). The implicit `@unique` index
--     `users_mobile_key` continues to back `findUnique({ mobile })`
--     calls in the auth flow.
--   - The free-class signup and attendance scanner paths query
--     `findFirst({ mobile, isDeleted: false })`. The new composite
--     `(mobile, isDeleted)` index serves both: the leading `mobile`
--     column matches the soft-delete lookup, AND because Postgres
--     can use the leading column of a B-tree as a prefix index, it
--     ALSO serves single-column `findUnique({ mobile })` if the
--     unique index is ever unavailable (defence-in-depth).
--   - The admin user list (`getAllUsersFromDB`) filters by `role`
--     and soft-delete `isDeleted`. The new `(role, isDeleted)`
--     composite subsumes the previous standalone `role` and
--     `isDeleted` indexes (the leading-column rule means a query
--     filtering by `role` alone still uses the composite).
--   - `status` and `isFreeAccount` stay single-column because
--     they're queried in isolation (the auth middleware checks
--     `status` for the ACTIVE/BANNED gate; the dashboard counts
--     free-class users by `isFreeAccount`).
--
-- Drop order matters — Postgres can't drop an index that's still
-- referenced by a constraint. We drop the unused standalone
-- indexes first, then create the composites in their place.

-- Drop the standalone indexes that the new composites subsume.
DROP INDEX IF EXISTS "users_role_idx";
DROP INDEX IF EXISTS "users_isDeleted_idx";

-- Add the composite indexes that serve the hot query paths.
CREATE INDEX "users_mobile_isDeleted_idx" ON "users"("mobile", "isDeleted");
CREATE INDEX "users_role_isDeleted_idx" ON "users"("role", "isDeleted");

-- Pre-flight checks (run before applying, not part of the migration):
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "users" WHERE "mobile" = $1;
--     → should use Bitmap Index Scan on users_mobile_key (or
--       users_mobile_isDeleted_idx as fallback).
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM "users"
--     WHERE "role" = $1 AND "isDeleted" = false ORDER BY "createdAt" DESC LIMIT $2;
--     → should use Index Scan on users_role_isDeleted_idx.