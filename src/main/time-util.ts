/** Filesystem-safe local timestamp slug: YYYYMMDD-HHMMSS. Shared by the preview screenshot filenames
 *  and the saved-plan filenames (was duplicated verbatim as stamp() in preview.ts and planStamp() in ipc.ts). */
export function fileStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
