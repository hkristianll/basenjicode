import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Write a text file atomically: write a sibling temp file, then rename it over the target. A crash or
 * power loss mid-write then leaves either the old file or the new one — never a half-written, corrupt
 * file. rename(2) is atomic on the same volume (and replaces the destination on Windows). Edits are
 * serialized per turn, so a fixed `.tmp` suffix can't collide.
 */
export async function writeTextAtomic(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.nordcode.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(content, 'utf8')
    await fh.sync() // force bytes to disk BEFORE the rename so power loss can't leave a 0-length file
  } finally {
    await fh.close()
  }
  try {
    await fs.rename(tmp, abs)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/** Atomic binary write (temp + fsync + rename) — for generated images and other non-text assets. */
export async function writeBytesAtomic(abs: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.nordcode.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.rename(tmp, abs)
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}
