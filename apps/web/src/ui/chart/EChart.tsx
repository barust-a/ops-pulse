import { useEffect, useRef, type ReactNode } from 'react';

import { echarts, type ChartInstance, type ChartOption } from './echartsCore';
import { useColorScheme } from './useColorScheme';

interface EChartProps {
  readonly option: ChartOption;
  /** What the chart shows, read by screen readers in place of the canvas. */
  readonly ariaLabel: string;
  readonly heightPx?: number;
  /** A text equivalent of the data (usually a DataSummaryTable), visually hidden. */
  readonly summary?: ReactNode;
}

/**
 * A typed ECharts canvas: created on mount and on colour-scheme change, updated when `option`
 * changes, resized with its container and disposed on unmount.
 */
export function EChart({ option, ariaLabel, heightPx = 300, summary }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);
  const theme = useColorScheme();

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) throw new Error('EChart container is not mounted');
    const chart = echarts.init(element, theme);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    chartRef.current?.setOption(option);
  }, [option, theme]);

  return (
    <figure className="chart">
      <div
        ref={containerRef}
        className="chart__canvas"
        role="img"
        aria-label={ariaLabel}
        style={{ height: heightPx }}
      />
      {summary === undefined ? null : <div className="visually-hidden">{summary}</div>}
    </figure>
  );
}
