import { describe, expect, it } from 'vitest';

import { canEditIncidents } from './permissions';

describe('canEditIncidents', () => {
  it.each([
    ['viewer', false],
    ['analyst', true],
    ['admin', true],
  ] as const)('%s → %s', (role, expected) => {
    expect(canEditIncidents(role)).toBe(expected);
  });
});
