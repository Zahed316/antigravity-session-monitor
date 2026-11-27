import { EMAIL_RE } from './tokenVaultService.ts';

/**
 * Resolves a requested re-auth target before any sign-out happens (M3).
 * Re-auth logs the current session out, so an unknown or malformed email must be
 * rejected here rather than reaching `AccountSwitcher.reauthAccount`. Pure, so the
 * guard is testable — it previously lived in a closure inside `activate()`.
 */
export function resolveReauthTarget(
  raw: unknown,
  accounts: ReadonlyArray<{ email: string }>,
): { email: string } | { error: 'invalid_email' | 'unknown_account' } {
  if (typeof raw !== 'string') return { error: 'invalid_email' };
  const normalized = raw.trim().toLowerCase();
  if (!normalized || !EMAIL_RE.test(normalized)) return { error: 'invalid_email' };
  if (!accounts.some((a) => a.email === normalized)) return { error: 'unknown_account' };
  return { email: normalized };
}