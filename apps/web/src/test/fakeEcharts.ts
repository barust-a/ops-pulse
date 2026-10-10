import type { ChartEngine, ChartInstance, ChartOption, ChartTheme } from '../ui/chart/echartsCore';

interface FakeChart extends ChartInstance {
  readonly element: HTMLElement;
  readonly theme: ChartTheme;
  readonly options: ChartOption[];
  disposed: boolean;
}

interface FakeEcharts extends ChartEngine {
  readonly charts: FakeChart[];
  reset(): void;
}

const charts: FakeChart[] = [];

/** Records what the wrapper asks of ECharts, since jsdom has no canvas to draw on. */
export const fakeEcharts: FakeEcharts = {
  charts,
  init(element, theme) {
    const chart: FakeChart = {
      element,
      theme,
      options: [],
      disposed: false,
      setOption(option) {
        chart.options.push(option);
      },
      resize() {
        // Nothing to lay out without a canvas.
      },
      dispose() {
        chart.disposed = true;
      },
    };
    charts.push(chart);
    return chart;
  },
  reset() {
    charts.length = 0;
  },
};
