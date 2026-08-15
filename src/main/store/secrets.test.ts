import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret, isEncrypted } from './secrets'

// In the unit-test (non-Electron) context, safeStorage is undefined, so encryption "isn't available" and the
// helpers degrade to plaintext passthrough. These tests lock the SAFETY invariants that hold regardless of
// whether a real keychain is present — the parts that must never regress.

describe('secrets helper', () => {
  it('treats a non-prefixed value as legacy plaintext (round-trips unchanged)', () => {
    expect(decryptSecret('sk-plaintext-legacy-key')).toBe('sk-plaintext-legacy-key')
    expect(isEncrypted('sk-plaintext-legacy-key')).toBe(false)
  })

  it('never leaks ciphertext as a key: an undecryptable enc:v1 value yields empty, not the ciphertext', () => {
    const fake = 'enc:v1:bm90LXJlYWwtY2lwaGVydGV4dA=='
    expect(isEncrypted(fake)).toBe(true)
    expect(decryptSecret(fake)).toBe('') // can't decrypt here → '' rather than handing back base64 garbage
  })

  it('is idempotent — an already-encrypted value is never double-wrapped', () => {
    const already = 'enc:v1:c29tZS1jaXBoZXJ0ZXh0'
    expect(encryptSecret(already)).toBe(already)
  })

  it('keeps an empty secret empty (nothing to protect)', () => {
    expect(encryptSecret('')).toBe('')
    expect(decryptSecret('')).toBe('')
  })

  it('degrades to plaintext when no keychain is available rather than losing the key', () => {
    // No safeStorage in the test process, so this is the graceful-degradation path: store as-is.
    expect(encryptSecret('sk-live-key')).toBe('sk-live-key')
  })
})
