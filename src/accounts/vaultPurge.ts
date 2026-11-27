import type { TokenVaultService } from './tokenVaultService.ts';

/**
 * Best-effort vault credential purge after a successful Account removal (C4):
 * a failure never undoes the registry removal, but is never silent — it is
 * returned as a warning note appended to the removal confirmation message.
 */
export async function purgeRemovedAccountCredential(
  vault: Pick<TokenVaultService, 'deleteCredential'>,
  email: string,
): Promise<string> {
  try {
    await vault.deleteCredential(email);
    return '';
  } catch {
    return ' (warning: the vaulted credential could not be deleted — clear the token vault later)';
  }
}
