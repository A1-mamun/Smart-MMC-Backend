import { JwtPayload } from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/prisma';
import {
  explainUpstreamCode,
  getBalance as gatewayGetBalance,
  sendViaBulkSmsBd,
} from '../../utils/smsGateway';
import { toIntl } from '../../utils/phone';
import { TSendSms, TGetMyLogs } from './sms.validation';

const MAX_LOGS = 50;

const sendSmsToDB = async (payload: TSendSms, user: JwtPayload) => {
  // 1. Normalise every recipient up-front. Numbers that don't match a
  //    valid BD mobile get filtered out and the original index is
  //    reported back so callers can show "X / N skipped".
  const valid: { studentId: string; name: string; intl: string }[] = [];
  const skipped: { studentId: string; name: string; raw: string }[] = [];
  for (const r of payload.recipients) {
    const intl = toIntl(r.mobile);
    if (intl) {
      valid.push({ studentId: r.studentId, name: r.name, intl });
    } else {
      skipped.push({ studentId: r.studentId, name: r.name, raw: r.mobile });
    }
  }

  if (valid.length === 0) {
    throw Object.assign(new Error('No valid recipients'), {
      statusCode: 400,
      publicMessage: 'None of the selected recipients have a valid mobile number',
    });
  }

  // 2. Hit the gateway.
  const result = await sendViaBulkSmsBd({
    numbers: valid.map((v) => v.intl),
    message: payload.message,
  });

  const status: 'PENDING' | 'SUCCESS' | 'FAILED' = result.ok ? 'SUCCESS' : 'FAILED';

  // 3. Persist the log + activity entry. We deliberately keep this even
  //    on FAILED so the audit trail captures every attempt.
  const recipientsCsv = valid.map((v) => v.intl).join(',');
  const log = await prisma.smsLog.create({
    data: {
      recipients: recipientsCsv,
      message: payload.message,
      status,
      upstreamCode: result.code,
      errorMsg: result.ok ? null : explainUpstreamCode(result.code),
      count: result.ok ? result.count : 0,
      mode: payload.mode,
      sentById: user.userId,
    },
  });

  await prisma.activityLog.create({
    data: {
      actorId: user.userId,
      actorRole: user.role as 'SUPER_ADMIN' | 'ADMIN',
      action: result.ok ? 'SMS_SENT' : 'SMS_FAILED',
      entityType: 'SmsLog',
      entityId: log.id,
      description: result.ok
        ? `SMS sent to ${result.count} recipient(s)`
        : `SMS failed: ${explainUpstreamCode(result.code)}`,
      metadata: {
        mode: payload.mode,
        upstreamCode: result.code,
        skipped: skipped.length,
        count: result.ok ? result.count : 0,
      },
    },
  });

  return {
    log,
    skipped,
    result: {
      ok: result.ok,
      upstreamCode: result.code,
      message: result.ok
        ? `SMS sent to ${result.count} recipient(s)`
        : explainUpstreamCode(result.code),
    },
  };
};

const getBalanceFromDB = async () => {
  const upstream = await gatewayGetBalance();
  // console.log('Fetched SMS balance from upstream:', upstream);
  return {
    balance: upstream.balance,
    raw: upstream.raw,
    fetchedAt: new Date(),
  };
};

const getMySmsLogsFromDB = async (userId: string, query: TGetMyLogs) => {
  const limit = Math.min(query.limit ?? MAX_LOGS, MAX_LOGS);
  const where: Prisma.SmsLogWhereInput = { sentById: userId };

  const [data, total] = await Promise.all([
    prisma.smsLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sentBy: { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.smsLog.count({ where }),
  ]);

  return { data, meta: { total } };
};

export const SmsService = {
  sendSmsToDB,
  getBalanceFromDB,
  getMySmsLogsFromDB,
};
