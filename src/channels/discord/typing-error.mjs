const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function discordTypingRetryAfterMs(error) {
  if (error?.status !== 429) return undefined;
  const seconds = error.retryAfter ?? error.retry_after;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(seconds * 1_000));
}

// Only fixed classifications and bounded metadata leave the transport.
export function classifyDiscordTypingError(error) {
  if (error?.name === 'TimeoutError') return { kind: 'timeout' };
  if (error?.name === 'AbortError') return { kind: 'abort' };
  const status = error?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    const result = { kind: 'http', status };
    if (Number.isSafeInteger(error.providerCode) && error.providerCode >= 0) result.providerCode = error.providerCode;
    const retryAfterMs = discordTypingRetryAfterMs(error);
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
    return result;
  }
  const cause = error?.cause;
  for (const code of [error?.code, cause?.code, cause?.cause?.code]) {
    if (NETWORK_CODES.has(code)) return { kind: 'network', code };
  }
  return cause?.name === 'TypeError' ? { kind: 'network' } : { kind: 'unknown' };
}
