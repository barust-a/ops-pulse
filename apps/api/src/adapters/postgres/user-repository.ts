import type pg from 'pg';
import { z } from 'zod';

import type { User } from '../../domain/user.js';
import { UserSchema } from '../../domain/user.js';
import type { UserCredentials, UserRepository } from '../../ports/repositories.js';

const CredentialsRowSchema = UserSchema.extend({ passwordHash: z.string() });

export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByEmail(email: string): Promise<UserCredentials | null> {
    // email is citext: the comparison ignores case.
    const result = await this.pool.query(
      `select id::int as id, email::text as email, role, password_hash as "passwordHash"
         from ops.users where email = $1`,
      [email],
    );
    if (result.rows.length === 0) return null;
    const { passwordHash, ...user } = CredentialsRowSchema.parse(result.rows[0]);
    return { user, passwordHash };
  }

  async findById(id: number): Promise<User | null> {
    const result = await this.pool.query(
      'select id::int as id, email::text as email, role from ops.users where id = $1',
      [id],
    );
    return result.rows.length === 0 ? null : UserSchema.parse(result.rows[0]);
  }
}
