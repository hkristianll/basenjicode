import { safeStorage } from 'electron'

/**
 * Encrypt cloud API keys before they touch disk, using Electron's `safeStorage` (DPAPI on Windows, the
 * Keychain on macOS, libsecret on Linux). Without this, `apiKey` bearer tokens land verbatim in
 * `%APPDATA%/NordCode/settings.json` — readable by any local process or in a backup. The plaintext only ever
 * lives in memory (decrypted on load, re-encrypted on save).
 *
 * Values are stored as `enc:v1:<base64 ciphertext>`. A value WITHOUT that prefix is treated as plaintext —
 * which covers a legacy settings.json written before encryption, and the graceful-degradation case where the
 * OS keychain is unavailable (then we can't do better than today, so we store plaintext rather than lose the key).
 */
const PREFIX = 'enc:v1:'

/** True only when the OS keychain backing safeStorage is actually usable (and the module exists — it is
 *  undefined outside an Electron main process, e.g. in unit tests). Never throws. */
function encryptionAvailable(): boolean {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Encrypt a secret for at-rest storage. Idempotent (an already-encrypted value passes through unchanged) and
 *  safe when the keychain is unavailable (returns the plaintext, matching pre-encryption behavior). */
export function encryptSecret(plain: string): string {
  if (!plain) return '' // nothing to protect
  if (isEncrypted(plain)) return plain // never double-wrap
  if (!encryptionAvailable()) return plain // can't encrypt here — degrade to plaintext, same as before
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return plain
  }
}

/** Reverse encryptSecret. A non-prefixed value is returned as-is (legacy plaintext). A prefixed value that
 *  can't be decrypted (keychain gone, profile copied to another machine) yields '' rather than leaking ciphertext. */
export function decryptSecret(stored: string): string {
  if (!stored || !isEncrypted(stored)) return stored ?? ''
  if (!encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}
