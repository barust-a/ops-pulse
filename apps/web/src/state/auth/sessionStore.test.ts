import { describe, expect, it, vi } from 'vitest';

import { analystUser } from '../../test/fixtures';
import { createSessionStore } from './sessionStore';

const session = { token: 'jwt', user: analystUser };

describe('createSessionStore', () => {
  it('starts empty', () => {
    expect(createSessionStore(sessionStorage).read()).toBeNull();
  });

  it('restores a saved session in a new store (page reload)', () => {
    createSessionStore(sessionStorage).save(session);

    expect(createSessionStore(sessionStorage).read()).toEqual(session);
  });

  it('forgets the session on clear', () => {
    const store = createSessionStore(sessionStorage);
    store.save(session);
    store.clear();

    expect(store.read()).toBeNull();
    expect(createSessionStore(sessionStorage).read()).toBeNull();
  });

  it('drops a tampered stored session', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sessionStorage.setItem('ops-pulse.session', JSON.stringify({ token: 'x', user: { role: 'root' } }));

    expect(createSessionStore(sessionStorage).read()).toBeNull();
    expect(sessionStorage.getItem('ops-pulse.session')).toBeNull();
  });
});
