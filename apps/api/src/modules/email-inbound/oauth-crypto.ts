import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * OAuth credential envelope — AES-256-GCM (same shape as the rest of
 * the integration surface). Re-uses `INTEGRATION_ENC_KEY` from the
 * environment. The IntegrationService helper has the same logic but
 * lives in a different module — duplicating ~20 lines here is cheaper
 * than building a crypto barrel or pulling in a new cross-module import
 * for an internal-only consumer.
 */
const FORMAT_DELIMITER = '.';

export function encryptJson(value: unknown): string {
  const envKey = process.env.INTEGRATION_ENC_KEY;
  if (!envKey) {
    throw new Error(
      'INTEGRATION_ENC_KEY env var is required to store OAuth credentials',
    );
  }
  const key = createHash('sha256').update(envKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(FORMAT_DELIMITER);
}

export function decryptJson<T = unknown>(envelope: string): T {
  const envKey = process.env.INTEGRATION_ENC_KEY;
  if (!envKey) {
    throw new Error('INTEGRATION_ENC_KEY env var is required');
  }
  const [iv, tag, data] = envelope.split(FORMAT_DELIMITER);
  if (!iv || !tag || !data) {
    throw new Error('Malformed credential envelope');
  }
  const key = createHash('sha256').update(envKey).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as T;
}
