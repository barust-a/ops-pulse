import bcrypt from 'bcrypt';

import type { PasswordVerifier } from '../../ports/security.js';

/** The security baseline's cost factor (contract, "Security baseline"). */
const BCRYPT_COST = 12;

// A cost-12 hash of a random string nobody knows: comparing against it makes an unknown account
// take as long to reject as a wrong password.
const UNKNOWN_ACCOUNT_HASH = '$2b$12$xAOFRpOjFRxjhn1A0ka.hOtpoaSyVFefgHN.3l7zK2bXfb8FGtG6e';

export function hashPassword(password: string, cost = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(password, cost);
}

export const bcryptPasswords: PasswordVerifier = {
  async verify(password, passwordHash) {
    if (passwordHash === null) {
      await bcrypt.compare(password, UNKNOWN_ACCOUNT_HASH);
      return false;
    }
    return bcrypt.compare(password, passwordHash);
  },
};
