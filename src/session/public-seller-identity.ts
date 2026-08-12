const MAX_SELLER_LOGIN_ID_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export function normalizePublicSellerLoginIdV1(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_SELLER_LOGIN_ID_LENGTH
    || normalized === '[redacted]'
    || CONTROL_CHARACTER.test(normalized)
  ) return null;
  return normalized;
}
