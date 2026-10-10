import { z } from 'zod';

import { RoleSchema } from './roles.js';

/** Contract `User`: never carries the password hash. */
export const UserSchema = z.object({
  id: z.number().int().positive(),
  email: z.string(),
  role: RoleSchema,
});
export type User = z.infer<typeof UserSchema>;
