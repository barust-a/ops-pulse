import type { ChartOption } from '../../ui/chart/echartsCore';

/** One colour per service, kept across every chart so a service is recognisable at a glance. */
const SERVICE_COLORS: Readonly<Record<string, string>> = {
  payments: '#4f7cff',
  crm: '#14a38b',
  'data-platform': '#e0a526',
  identity: '#d6538a',
  network: '#8b6cf0',
  reporting: '#e46b3c',
};

const FALLBACK_COLOR = '#7c8799';

export const STATUS_COLORS = {
  good: '#14a38b',
  warning: '#e0a526',
  critical: '#e5484d',
  neutral: '#7c8799',
  accent: '#4f7cff',
} as const;

export function serviceColor(service: string): string {
  return SERVICE_COLORS[service] ?? FALLBACK_COLOR;
}

/** Settings every chart shares: transparent so the card shows through, same font and spacing. */
export const BASE_OPTION: ChartOption = {
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif' },
  animationDuration: 400,
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** ECharts tooltips are HTML: API strings are escaped before they reach one. */
export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
