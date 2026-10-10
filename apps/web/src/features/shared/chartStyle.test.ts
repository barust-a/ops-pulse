import { describe, expect, it } from 'vitest';

import { escapeHtml, serviceColor } from './chartStyle';

describe('chartStyle', () => {
  it('escapes HTML in tooltip text', () => {
    expect(escapeHtml('<img src=x onerror="a">&')).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;',
    );
  });

  it('gives unknown services a neutral colour', () => {
    expect(serviceColor('payments')).toBe('#4f7cff');
    expect(serviceColor('mainframe')).toBe('#7c8799');
  });
});
