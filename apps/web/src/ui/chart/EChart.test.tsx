import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fakeEcharts } from '../../test/fakeEcharts';
import { EChart } from './EChart';
import type { ChartOption } from './echartsCore';

const lineOption: ChartOption = { series: [{ type: 'line', data: [1, 2, 3] }] };
const barOption: ChartOption = { series: [{ type: 'bar', data: [4, 5] }] };

function onlyChart() {
  expect(fakeEcharts.charts).toHaveLength(1);
  const [chart] = fakeEcharts.charts;
  if (chart === undefined) throw new Error('no chart was created');
  return chart;
}

describe('EChart', () => {
  it('initialises ECharts on its container and applies the option', () => {
    const { getByRole } = render(<EChart option={lineOption} ariaLabel="Volume par jour" />);

    const chart = onlyChart();
    expect(chart.element).toBe(getByRole('img', { name: 'Volume par jour' }));
    expect(chart.theme).toBe('light');
    expect(chart.options).toEqual([lineOption]);
  });

  it('sets the new option when it changes, on the same instance', () => {
    const { rerender } = render(<EChart option={lineOption} ariaLabel="Volume" />);
    rerender(<EChart option={barOption} ariaLabel="Volume" />);

    expect(onlyChart().options.at(-1)).toEqual(barOption);
  });

  it('disposes the instance on unmount', () => {
    const { unmount } = render(<EChart option={lineOption} ariaLabel="Volume" />);
    unmount();

    expect(onlyChart().disposed).toBe(true);
  });

  it('renders the text summary for screen readers', () => {
    const { getByText } = render(
      <EChart option={lineOption} ariaLabel="Volume" summary={<p>3 incidents</p>} />,
    );

    expect(getByText('3 incidents')).toBeInTheDocument();
  });
});
