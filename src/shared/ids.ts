import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(prefix: string): string {
  const now = Date.now();
  let time = '';
  let value = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[value % 32] + time;
    value = Math.floor(value / 32);
  }

  const random = randomBytes(10);
  let suffix = '';
  for (const byte of random) {
    suffix += CROCKFORD[byte >> 3];
  }

  return `${prefix}_${time}${suffix}`;
}

export function newSecretToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
