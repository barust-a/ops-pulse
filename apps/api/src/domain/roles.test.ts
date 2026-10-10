import { describe, expect, it } from 'vitest';

import { hasRole } from './roles.js';

describe('hasRole', () => {
  it.each([
    ['viewer', 'viewer', true],
    ['viewer', 'analyst', false],
    ['analyst', 'viewer', true],
    ['analyst', 'analyst', true],
    ['analyst', 'admin', false],
    ['admin', 'analyst', true],
    ['admin', 'admin', true],
  ] as const)('a %s meets the %s requirement: %s', (actual, required, expected) => {
    expect(hasRole(actual, required)).toBe(expected);
  });
});
