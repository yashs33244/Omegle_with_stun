/** Crockford base32: no I, L, O or U, so a code read off a recording is unambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Short per-call code shown as a watermark over the partner's video: 40 bits
 * of a 64-bit FNV-1a hash of the server's room id, as "XXXX-XXXX". It holds
 * no personal data; the operator can hash a reported room id to match a
 * recording that surfaces later.
 */
export function watermarkCode(roomId: string): string {
  let hash = FNV_OFFSET;
  for (const char of roomId.toLowerCase()) {
    hash ^= BigInt(char.charCodeAt(0));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += ALPHABET[Number(hash & 31n)];
    hash >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
