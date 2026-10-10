import type { User } from '../../api/schemas';

export type AuthState =
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly token: string; readonly user: User };

export type AuthAction =
  | { readonly type: 'loggedIn'; readonly token: string; readonly user: User }
  | { readonly type: 'loggedOut' };

export const anonymous: AuthState = { status: 'anonymous' };

export function authReducer(_state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'loggedIn': {
      return { status: 'authenticated', token: action.token, user: action.user };
    }
    case 'loggedOut': {
      return anonymous;
    }
  }
}
