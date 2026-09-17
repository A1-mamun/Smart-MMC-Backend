import config from '../config';
import { toIntl } from './phone';
import { URLSearchParams } from 'node:url';

/**
 * Upstream response from BulkSMSBD.net. The gateway returns ONLY a status
 * code as plain text (e.g. "202" on success or an error code like "1012").
 * We wrap that into a discriminated union so callers don't need to deal
 * with HTTP details.
 */
export type BulkSmsResponse =
  { ok: true; code: '202'; raw: string; count: number } | { ok: false; code: string; raw: string };

/**
 * BulkSMSBD.net error code → human-readable explanation. The full list is
 * documented in their API spec; we only surface the codes that map to
 * user-actionable errors (the rest fall through to a generic message).
 */
const ERROR_MESSAGES: Record<string, string> = {
  '1001': 'Invalid API key format',
  '1002': 'Invalid phone number(s)',
  '1003': 'Invalid sender ID',
  '1005': 'Message type missing',
  '1006': 'Message body missing',
  '1007': 'Message body too long',
  '1011': 'Invalid country code',
  '1012': 'Invalid API key',
  '1013': 'Account disabled — contact BulkSMSBD support',
  '1014': 'Insufficient balance',
  '1015': 'Invalid request URL',
  '1016': 'Sender ID not registered for this account',
  '1017': 'Mobile number is blocked',
  '1018': 'Sender ID disabled',
  '1019': 'Empty message content',
  '1020': 'Empty mobile number',
  '1021': 'Empty sender ID',
  '1031': 'Spam detected — message blocked',
  '1032': 'Forbidden words detected — message blocked',
};

export const explainUpstreamCode = (code: string): string =>
  ERROR_MESSAGES[code] || `Upstream returned error code ${code}`;

const requireConfig = (): { apiKey: string; senderId: string; baseUrl: string } => {
  const apiKey = config.bulkSmsApiKey || '';
  const senderId = config.bulkSmsSenderId || '';
  const baseUrl = config.bulkSmsBaseUrl || 'http://bulksmsbd.net/api';

  if (!apiKey || !senderId) {
    throw Object.assign(new Error('BulkSMSBD is not configured'), {
      statusCode: 500,
      publicMessage: 'SMS gateway credentials are not configured',
    });
  }

  return { apiKey, senderId, baseUrl };
};

/**
 * Send a single text SMS to one or many recipients. Recipients must already
 * be normalised to `8801XXXXXXXXX` format via `toIntl()` — this function
 * does not re-normalise so callers can decide which numbers to use and
 * drop invalid ones explicitly.
 *
 * BulkSMSBD's docs describe a plain-text response (e.g. "202"), but the
 * live endpoint actually returns a JSON object:
 *   { response_code: 202, message_id: 13145326,
 *     success_message: "SMS Submitted Successfully 1",
 *     error_message: "" }
 * We accept both shapes — if the body parses as JSON and carries
 * `response_code === 202` we treat it as success; otherwise we fall back
 * to the legacy plain-text comparison.
 */
export const sendViaBulkSmsBd = async (opts: {
  numbers: string[];
  message: string;
}): Promise<BulkSmsResponse> => {
  const { apiKey, senderId, baseUrl } = requireConfig();

  if (opts.numbers.length === 0) {
    return { ok: false, code: '1020', raw: 'EMPTY_NUMBER' };
  }

  // Make sure we only forward well-formed numbers — defensive double-check.
  const cleaned = opts.numbers.map(toIntl).filter((n): n is string => Boolean(n));
  if (cleaned.length === 0) {
    return { ok: false, code: '1002', raw: 'NO_VALID_NUMBERS' };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    type: 'text',
    number: cleaned.join(','),
    senderid: senderId,
    message: opts.message,
  });

  const url = `${baseUrl.replace(/\/$/, '')}/smsapi?${params.toString()}`;

  let raw: string;
  try {
    const res = await globalThis.fetch(url, { method: 'GET' });
    raw = (await res.text()).trim();
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      raw: err instanceof Error ? err.message : 'network error',
    };
  }

  // 1. JSON response (current BulkSMSBD behaviour).
  //    Success example: {"response_code":202,"message_id":13145326,
  //                      "success_message":"SMS Submitted Successfully 1",
  //                      "error_message":""}
  //    Error example:   {"response_code":1011,"error_message":"..."}
  try {
    const parsed = JSON.parse(raw) as {
      response_code?: number | string;
      error_message?: string;
    };
    if (parsed && typeof parsed === 'object') {
      const codeNum =
        typeof parsed.response_code === 'string'
          ? Number.parseInt(parsed.response_code, 10)
          : parsed.response_code;
      if (codeNum === 202) {
        return { ok: true, code: '202', raw, count: cleaned.length };
      }
      // Surface the gateway's own error text (if any) so the UI/log
      // shows something meaningful instead of "UNKNOWN".
      const upstreamCode =
        parsed.response_code !== undefined && parsed.response_code !== null
          ? String(parsed.response_code)
          : raw || 'UNKNOWN';
      return {
        ok: false,
        code: upstreamCode,
        raw: parsed.error_message?.trim() || raw,
      };
    }
  } catch {
    // Not JSON — fall through to the plain-text path below.
  }

  // 2. Plain-text response (legacy behaviour).
  if (raw === '202') {
    return { ok: true, code: '202', raw, count: cleaned.length };
  }

  return { ok: false, code: raw || 'UNKNOWN', raw };
};

/**
 * Fetch the current account balance from BulkSMSBD.net. The endpoint
 * returns a numeric string (e.g. "1234.56"). Any non-numeric response is
 * surfaced as 0 with the raw text on the side.
 */
export const getBalance = async (): Promise<{
  balance: number;
  raw: string;
}> => {
  const { apiKey, baseUrl } = requireConfig();

  const url = `${baseUrl.replace(/\/$/, '')}/getBalanceApi?api_key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await globalThis.fetch(url, { method: 'GET' });

    const raw = (await res.text()).trim();

    const data = JSON.parse(raw);

    // BulkSMSBD returns response_code 202 on success
    if (data.response_code !== 202) {
      return {
        balance: 0,
        raw,
      };
    }

    return {
      balance:
        typeof data.balance === 'number' && Number.isFinite(data.balance)
          ? Number(data.balance.toFixed(2))
          : 0,
      raw,
    };
  } catch (err) {
    return {
      balance: 0,
      raw: err instanceof Error ? err.message : 'network error',
    };
  }
};
