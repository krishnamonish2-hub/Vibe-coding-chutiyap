import bcrypt from 'bcrypt';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes
export const DEFAULT_ROUNDS = 12;

export function checkPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
}

export async function hashPassword(password, rounds = DEFAULT_ROUNDS) {
  const problem = checkPasswordStrength(password);
  if (problem) throw new Error(`password ${problem}`);
  return bcrypt.hash(password, rounds);
}

// Used when the email is unknown, so a failed login takes about as long whether or not the account exists.
let dummyHash;
async function getDummyHash() {
  dummyHash ??= await bcrypt.hash('messmind-dummy-password-for-timing', DEFAULT_ROUNDS);
  return dummyHash;
}

export async function verifyPassword(password, hash) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    await bcrypt.compare('x', hash ?? (await getDummyHash()));
    return false;
  }
  if (!hash) {
    await bcrypt.compare(password, await getDummyHash());
    return false;
  }
  return bcrypt.compare(password, hash);
}
