import { describe, expect, it } from 'vitest';

import { bcryptPasswords, hashPassword } from './bcrypt-passwords.js';

describe('bcryptPasswords', () => {
  it('accepts the password a hash was made from', async () => {
    const hash = await hashPassword('correct horse', 4);
    await expect(bcryptPasswords.verify('correct horse', hash)).resolves.toBe(true);
  });

  it('rejects another password', async () => {
    const hash = await hashPassword('correct horse', 4);
    await expect(bcryptPasswords.verify('battery staple', hash)).resolves.toBe(false);
  });

  it('rejects any password for an unknown account', async () => {
    await expect(bcryptPasswords.verify('anything', null)).resolves.toBe(false);
  });

  it('hashes with cost 12 by default', async () => {
    await expect(hashPassword('x')).resolves.toMatch(/^\$2b\$12\$/);
  });
});
