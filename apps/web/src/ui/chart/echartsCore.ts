import type { BarSeriesOption, HeatmapSeriesOption, LineSeriesOption } from 'echarts/charts';
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import type {
  GridComponentOption,
  LegendComponentOption,
  MarkPointComponentOption,
  TooltipComponentOption,
  VisualMapComponentOption,
} from 'echarts/components';
import {
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import type { TooltipComponentFormatterCallbackParams } from 'echarts';
import type { ComposeOption } from 'echarts/core';
// Aliased: a bare `use(...)` call reads as the React hook to lint.
import { init, use as registerModules } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

// Only the charts and components the dashboard draws are registered: tree-shaking keeps the
// bundle to a fraction of the full `echarts` import.
registerModules([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type ChartOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | HeatmapSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | MarkPointComponentOption
  | VisualMapComponentOption
>;

export type ChartTheme = 'light' | 'dark';

/** What a tooltip `formatter` receives: one point, or every series at the hovered axis value. */
export type TooltipParams = TooltipComponentFormatterCallbackParams;

/** The slice of an ECharts instance the wrapper uses: the seam tests replace. */
export interface ChartInstance {
  setOption(option: ChartOption): void;
  resize(): void;
  dispose(): void;
}

export interface ChartEngine {
  init(element: HTMLElement, theme: ChartTheme): ChartInstance;
}

export const echarts: ChartEngine = {
  init(element, theme) {
    const instance = init(element, theme === 'dark' ? 'dark' : undefined, { renderer: 'canvas' });
    return {
      setOption(option) {
        // notMerge: a filter change can drop a series, which a merge would keep on screen.
        instance.setOption(option, { notMerge: true });
      },
      resize() {
        instance.resize();
      },
      dispose() {
        instance.dispose();
      },
    };
  },
};
