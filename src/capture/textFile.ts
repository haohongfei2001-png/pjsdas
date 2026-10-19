/** Local-only text import. File content stays quoted data, never a user instruction. */
export const CAPTURE_FILE_MAX_BYTES = 32 * 1024
export const CAPTURE_TEXT_MAX_LENGTH = 8_000
export type CaptureFileError = 'format' | 'size' | 'encoding' | 'binary' | 'empty' | 'length'
export class CaptureTextFileError extends Error {
  constructor(readonly code: CaptureFileError) { super(code); this.name = 'CaptureTextFileError' }
}
export interface CaptureTextFile {
  name: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}
export async function readCaptureTextFile(file: CaptureTextFile, draft: string): Promise<string> {
  if (!/\.(txt|md)$/i.test(file.name)) throw new CaptureTextFileError('format')
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > CAPTURE_FILE_MAX_BYTES) throw new CaptureTextFileError('size')
  const bytes = await file.arrayBuffer()
  if (bytes.byteLength > CAPTURE_FILE_MAX_BYTES || bytes.byteLength !== file.size) throw new CaptureTextFileError('size')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new CaptureTextFileError('encoding') }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new CaptureTextFileError('binary')
  if (!text.trim()) throw new CaptureTextFileError('empty')
  const quote = text.replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n').map(line => `> ${line}`).join('\n')
  return appendCaptureQuote(draft, quote)
}

export function appendCaptureQuote(draft: string, quote: string): string {
  const next = draft ? `${draft}\n\n${quote}` : quote
  if (next.length > CAPTURE_TEXT_MAX_LENGTH) throw new CaptureTextFileError('length')
  return next
}
