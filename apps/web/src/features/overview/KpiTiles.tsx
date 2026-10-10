import type { KpiSummary } from '../../api/schemas';
import { formatDuration, formatInteger, formatPercent } from '../../i18n/format';
import { fr } from '../../i18n/fr';

type Tone = 'neutral' | 'good' | 'warning' | 'critical';

interface Tile {
  readonly id: keyof typeof fr.overview.tiles;
  readonly value: string;
  readonly tone: Tone;
}

function rateTone(rate: number, warningAt: number, criticalAt: number): Tone {
  if (rate >= criticalAt) return 'critical';
  if (rate >= warningAt) return 'warning';
  return 'good';
}

function tilesFor(summary: KpiSummary): Tile[] {
  return [
    { id: 'openIncidents', value: formatInteger(summary.openIncidents), tone: 'neutral' },
    { id: 'mttr', value: formatDuration(summary.mttrMinutes), tone: 'neutral' },
    { id: 'p90', value: formatDuration(summary.p90ResolutionMinutes), tone: 'neutral' },
    {
      id: 'slaBreachRate',
      value: formatPercent(summary.slaBreachRate),
      tone: rateTone(summary.slaBreachRate, 0.05, 0.15),
    },
    {
      id: 'changeFailureRate',
      value: formatPercent(summary.changeFailureRate),
      tone: rateTone(summary.changeFailureRate, 0.05, 0.15),
    },
    {
      id: 'anomalies',
      value: formatInteger(summary.anomalies),
      tone: summary.anomalies > 0 ? 'critical' : 'good',
    },
  ];
}

/** The row of six KPI tiles: "Incidents ouverts", "MTTR", "Résolution p90"… */
export function KpiTiles({ summary }: { readonly summary: KpiSummary }) {
  return (
    <ul className="kpi-grid" aria-label={fr.overview.title}>
      {tilesFor(summary).map((tile) => (
        <li key={tile.id} className={`kpi kpi--${tile.tone}`}>
          <p className="kpi__label">{fr.overview.tiles[tile.id]}</p>
          <p className="kpi__value">{tile.value}</p>
          <p className="kpi__hint">{fr.overview.tileHints[tile.id]}</p>
        </li>
      ))}
    </ul>
  );
}
