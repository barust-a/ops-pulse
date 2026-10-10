import { describe, expect, it } from 'vitest';

import { analystUser } from '../../test/fixtures';
import { anonymous, authReducer } from './authReducer';

describe('authReducer', () => {
  it('authenticates with the token and user', () => {
    expect(authReducer(anonymous, { type: 'loggedIn', token: 'jwt', user: analystUser })).toEqual({
      status: 'authenticated',
      token: 'jwt',
      user: analystUser,
    });
  });

  it('logs out back to anonymous', () => {
    const signedIn = authReducer(anonymous, { type: 'loggedIn', token: 'jwt', user: analystUser });

    expect(authReducer(signedIn, { type: 'loggedOut' })).toEqual({ status: 'anonymous' });
  });
});
