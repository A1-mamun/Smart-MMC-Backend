/**
 * Bangladeshi mobile phone normaliser.
 *
 * The BulkSMSBD.net gateway only accepts international-format numbers
 * (E.164-style with country code) and rejects anything else. To make life
 * easier for staff we accept a number of common shapes and collapse them
 * to `8801XXXXXXXXX` (13 digits, no leading `+`).
 *
 * Accepted inputs:
 *   "01712345678"     -> "8801712345678"
 *   "+8801712345678"  -> "8801712345678"
 *   "8801712345678"   -> "8801712345678"
 *   "1712345678"      -> "8801712345678"
 *
 * Anything that doesn't look like a valid BD mobile (must start with `1`
 * after the country code, must be 10 digits long after the country code)
 * returns `null` so callers can reject the row instead of silently sending
 * a malformed request upstream.
 *
 * Valid Bangladeshi mobile prefixes (per BTRC) are: 013 / 014 / 015 / 016 /
 * 017 / 018 / 019.
 */
const BD_VALID_OPERATOR_PREFIXES = ['13', '14', '15', '16', '17', '18', '19'];

export const toIntl = (raw: string | null | undefined): string | null => {
  if (!raw) return null;

  // Strip everything that isn't a digit or a leading `+`.
  let trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith('+');
  if (hasPlus) trimmed = trimmed.slice(1);

  // Keep only digits.
  const digits = trimmed.replace(/\D+/g, '');

  // Must be 10 (local) or 13 (already intl without `+`) digits.
  if (digits.length === 10) {
    if (!BD_VALID_OPERATOR_PREFIXES.includes(digits.slice(0, 2))) return null;
    return `880${digits}`;
  }

  if (digits.length === 13) {
    // International form is `880` + `1X` + 8 digits. The operator prefix
    // (e.g. `17`) sits at indices 3-4 — slice(2, 4) would land on the
    // `0` and `1` of `017…`, which is wrong.
    if (!digits.startsWith('880')) return null;
    if (!BD_VALID_OPERATOR_PREFIXES.includes(digits.slice(3, 5))) return null;
    return digits;
  }

  // 11 digits with leading 0 (e.g. "01712345678") is also common in some
  // legacy exports.
  if (digits.length === 11 && digits.startsWith('0')) {
    const local = digits.slice(1);
    if (!BD_VALID_OPERATOR_PREFIXES.includes(local.slice(0, 2))) return null;
    return `880${local}`;
  }

  // 14 digits with leading 00880 is another common intl shape.
  if (digits.length === 14 && digits.startsWith('00880')) {
    const local = digits.slice(5);
    if (!BD_VALID_OPERATOR_PREFIXES.includes(local.slice(0, 2))) return null;
    return `880${local}`;
  }

  return null;
};
