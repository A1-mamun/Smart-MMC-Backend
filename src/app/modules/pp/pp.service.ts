import { JwtPayload } from 'jsonwebtoken';
import prisma from '../../utils/prisma';
import { clearCacheByPattern } from '../../utils/clearCache';
import { TCreatePp, TRecordPpPayment } from './pp.validation';

/**
 * List PPs for the admin management page. We return the
 * lightweight `TPpWithStats` shape: each row has its base fields
 * plus `_count` for `students` and `payments`. The card UI
 * reads the count to render "N students referred" without
 * pulling the full per-student rows.
 *
 * Soft-deleted PPs are filtered out so the management list only
 * shows live entries. Detail endpoint filters the same way.
 */
const listPpsFromDB = () =>
  prisma.pp.findMany({
    where: { isDeleted: false },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      _count: { select: { students: true, payments: true } },
    },
  });

/**
 * Cheap narrow list for the admit form's PP select. Returns only
 * (id, name) so the dropdown is fast even with thousands of
 * students. Same soft-delete filter as `listPpsFromDB`.
 */
const listActivePpsFromDB = () =>
  prisma.pp.findMany({
    where: { isDeleted: false },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

/**
 * PP detail. The management page opens this in a dialog when the
 * admin clicks a card. Returns:
 *   - base PP fields + creator (small "added by" line)
 *   - `students`: minimal projection (id, name, ppFee) so the
 *     dialog can render the "students referred" table without a
 *     second query
 *   - `payments`: full payout history sorted newest-first, with
 *     the admin who paid each row so the dialog can show "by X"
 *   - the `_count` of both is also returned for parity with the
 *     list endpoint
 *
 * Returns `null` if the PP doesn't exist OR is soft-deleted, so
 * the controller can translate that to a 404.
 */
const getPpDetailFromDB = async (id: string) => {
  const pp = await prisma.pp.findFirst({
    where: { id, isDeleted: false },
    include: {
      createdBy: { select: { id: true, name: true, role: true } },
      students: {
        // Order by most-recent admission so the table matches
        // the natural "newest first" reading.
        orderBy: { admittedAt: 'desc' },
        select: {
          id: true,
          ppFee: true,
          user: { select: { name: true } },
        },
      },
      payments: {
        orderBy: { paidAt: 'desc' },
        include: {
          paidByUser: { select: { name: true } },
          student: { select: { id: true, user: { select: { name: true } } } },
        },
      },
      _count: { select: { students: true, payments: true } },
    },
  });
  if (!pp) return null;

  // Project per-student "paid" so the dialog's "Students referred"
  // table and the "Record payout" modal's auto-fill can show how
  // much commission is still owed for each student without a
  // second round-trip from the client. The `groupBy` is scoped to
  // this PP and to the students on the list — no risk of
  // double-counting payouts from a different PP, and the
  // transaction isolation between the two reads is good enough
  // for display purposes (a payout recorded in the gap shows up
  // on the next refetch).
  const studentIds = pp.students.map((s) => s.id);
  const paidRows = studentIds.length
    ? await prisma.ppPayment.groupBy({
        by: ['studentId'],
        where: {
          ppId: id,
          studentId: { in: studentIds },
        },
        _sum: { amount: true },
      })
    : [];
  const paidMap = new Map(
    paidRows
      .filter((r) => r.studentId !== null)
      .map((r) => [r.studentId as string, Number(r._sum.amount ?? 0)]),
  );
  return {
    ...pp,
    students: pp.students.map((s) => ({
      ...s,
      paid: paidMap.get(s.id) ?? 0,
    })),
  };
};

/**
 * Insert a new PP. The `name` is the only required field. The
 * actor's userId is the FK to `User`.
 *
 * We clear the `/pp*` cache after every write — `GET /pp`,
 * `GET /pp/active`, and `GET /pp/:id` are all wrapped in
 * `cache(60)` at the route layer, so without an explicit
 * invalidation a freshly-added PP wouldn't appear on the
 * management page (or the admit form's PP picker) for up to
 * a minute. We swallow cache errors: if Redis is down, the
 * cache expires in <= 60s anyway.
 */
const createPpInDB = async (data: TCreatePp, actor: JwtPayload) => {
  const created = await prisma.pp.create({
    data: {
      name: data.name,
      createdById: actor.userId as string,
    },
  });
  await clearCacheByPattern('cache:/api/v1/pp*').catch(() => undefined);
  return created;
};

/**
 * Soft-delete a PP. We use the standard `isDeleted` flag
 * (matching the rest of the schema) so the payout history is
 * never lost. The FK from `Student.ppId` is `ON DELETE SET NULL`,
 * so on a soft-delete the existing students keep their `ppFee`
 * but the `pp` relation becomes null — the student's PP section
 * on the detail page simply won't render. If an admin later
 * hard-deletes a PP, the same `ON DELETE SET NULL` keeps the
 * students intact (no orphan row).
 *
 * We swallow cache-clear errors: if Redis is down, the cache
 * expires in <= 60s anyway.
 */
const deletePpFromDB = async (id: string, actor: JwtPayload) => {
  // Look up the row first so we can return it to the controller
  // for the success toast. `findFirst` with `isDeleted: false`
  // gives us 404 semantics on a missing/already-deleted row.
  const existing = await prisma.pp.findFirst({
    where: { id, isDeleted: false },
  });
  if (!existing) return null;

  await prisma.pp.update({
    where: { id },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: actor.userId as string,
    },
  });
  await clearCacheByPattern('cache:/api/v1/pp*').catch(() => undefined);
  return existing;
};

/**
 * Record a payout to a PP. One row per disbursement — the ledger
 * is append-only. The `studentId` is optional; when set, the
 * row shows up on that student's detail page as part of their
 * per-student PP payment history.
 *
 * Defaults `paidAt` to "now" if the admin didn't provide one.
 * The `method` and `note` come from the form. We don't recompute
 * the PP's "due" anywhere — the frontend sums the student's
 * `ppFee` and the payment rows on the fly, so the ledger stays
 * the single source of truth.
 *
 * Returns the freshly-inserted row, with the `paidByUser`
 * projection hydrated so the UI can render "by X" without a
 * follow-up query.
 */
const recordPpPaymentInDB = async (
  data: TRecordPpPayment,
  actor: JwtPayload,
) => {
  const created = await prisma.ppPayment.create({
    data: {
      ppId: data.ppId,
      studentId: data.studentId ?? null,
      amount: data.amount,
      method: data.method,
      paidAt: data.paidAt ?? new Date(),
      paidBy: actor.userId as string,
      note: data.note,
    },
    include: {
      paidByUser: { select: { id: true, name: true } },
      student: { select: { id: true, user: { select: { name: true } } } },
    },
  });
  // If the payout was attributed to a student, the student's
  // per-student payout history also goes stale. Clear that too
  // so the student detail page reflects the new payment
  // immediately. Student endpoints are cached under
  // `cache:/api/v1/student*`.
  if (data.studentId) {
    await clearCacheByPattern('cache:/api/v1/student*').catch(
      () => undefined,
    );
  }
  // `GET /pp/:id` and `GET /pp` are wrapped in `cache(60)`. Without
  // explicit invalidation here, a freshly-recorded payout wouldn't
  // change the detail dialog's "Paid" / "Due" totals (or appear in
  // the payout history table) for up to a minute, and the
  // management list's per-card "Payouts" badge would lag too.
  await clearCacheByPattern('cache:/api/v1/pp*').catch(() => undefined);
  return created;
};

export const PpService = {
  listPpsFromDB,
  listActivePpsFromDB,
  getPpDetailFromDB,
  createPpInDB,
  deletePpFromDB,
  recordPpPaymentInDB,
};