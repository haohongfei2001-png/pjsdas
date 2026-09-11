import { WorkspaceSourceError } from './workspaceSource'

const VERSION = 'v1'

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url')
}

function base64ToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function parseKey(encodedKey: string) {
  let key: Uint8Array
  try {
    key = base64ToBytes(encodedKey.trim())
  } catch {
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'PJSDAS token encryption key is invalid.', false)
  }
  if (key.byteLength !== 32) {
    throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'PJSDAS token encryption key must decode to 32 bytes.', false)
  }
  return key
}

export async function encryptSecret(plaintext: string, encodedKey: string) {
  if (!plaintext) throw new WorkspaceSourceError('INVALID_SOURCE_CONFIG', 'Cannot encrypt an empty secret.', false)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(parseKey(encodedKey)), 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    new TextEncoder().encode(plaintext),
  ))
  return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`
}

export async function decryptSecret(envelope: string, encodedKey: string) {
  const [version, ivRaw, ciphertextRaw] = envelope.split('.')
  if (version !== VERSION || !ivRaw || !ciphertextRaw) {
    throw new WorkspaceSourceError('AUTH_INVALID', 'Stored Google authorization is not in a supported encrypted format.', false)
  }

  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(parseKey(encodedKey)), 'AES-GCM', false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(ivRaw)) },
      key,
      toArrayBuffer(base64ToBytes(ciphertextRaw)),
    )
    const value = new TextDecoder().decode(plaintext)
    if (!value) throw new Error('empty')
    return value
  } catch (caught) {
    if (caught instanceof WorkspaceSourceError) throw caught
    throw new WorkspaceSourceError('AUTH_INVALID', 'Stored Google authorization could not be decrypted.', false)
  }
}
