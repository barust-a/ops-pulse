import { LoginResponseSchema, type LoginResponse } from '../../api/schemas';

type Session = LoginResponse;

/** The session in memory, mirrored to sessionStorage so a reload keeps the user signed in. */
export interface SessionStore {
  read(): Session | null;
  save(session: Session): void;
  clear(): void;
}

const STORAGE_KEY = 'ops-pulse.session';

function restore(storage: Storage): Session | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = LoginResponseSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    console.warn('Ignoring a stored session with an unexpected shape', parsed.error.issues);
  } catch (error) {
    console.warn('Ignoring a stored session that is not JSON', error);
  }
  storage.removeItem(STORAGE_KEY);
  return null;
}

export function createSessionStore(storage: Storage): SessionStore {
  let current = restore(storage);
  return {
    read() {
      return current;
    },
    save(session) {
      current = session;
      storage.setItem(STORAGE_KEY, JSON.stringify(session));
    },
    clear() {
      current = null;
      storage.removeItem(STORAGE_KEY);
    },
  };
}
