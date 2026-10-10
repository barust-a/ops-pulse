import { fetchChangeOutcomes, type DateRange } from '../../api/endpoints';
import { CLOSE_CODES, type ChangeOutcome } from '../../api/schemas';
import { formatInteger } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import { useApiClient } from '../../state/auth/AuthContext';
import { useApiQuery, type QueryResult } from '../../state/useApiQuery';
import { Card } from '../../ui/Card';
import { DataSummaryTable } from '../../ui/chart/DataSummaryTable';
import { EChart } from '../../ui/chart/EChart';
import { EmptyState } from '../../ui/StatusViews';
import { QueryFallback } from '../shared/QueryFallback';
import { closeCodeCounts, closeCodeOption } from './closeCodeOption';

interface CloseCodeCardProps {
  readonly range: DateRange;
  readonly service: string | null;
}

interface CloseCodeBodyProps {
  readonly result: QueryResult<ChangeOutcome[]>;
  readonly service: string | null;
}

/** The card body: skeleton, error, empty message or the chart. */
function CloseCodeBody({ result, service }: CloseCodeBodyProps) {
  if (result.status !== 'success') return <QueryFallback result={result} heightPx={260} />;
  // The aggregate takes no service parameter: the shared service filter applies here, as on the table.
  const outcomes =
    service === null ? result.data : result.data.filter((outcome) => outcome.service === service);
  const counts = closeCodeCounts(outcomes);
  if (counts.services.length === 0) return <EmptyState title={fr.changes.empty} />;
  const rows = counts.services.map((rowService, index) => [
    rowService,
    ...CLOSE_CODES.map((code) => formatInteger(counts.counts[code][index] ?? 0)),
  ]);
  return (
    <EChart
      option={closeCodeOption(counts)}
      ariaLabel={fr.changes.closeCodesAria}
      heightPx={260}
      summary={
        <DataSummaryTable
          caption={fr.changes.closeCodesSummary}
          columns={[fr.filters.service, ...CLOSE_CODES.map((code) => fr.closeCode[code])]}
          rows={rows}
        />
      }
    />
  );
}

/** "Codes de clôture par service": stacked bars of successful / failed / backed-out changes. */
export function CloseCodeCard({ range, service }: CloseCodeCardProps) {
  const client = useApiClient();
  const result = useApiQuery(`${range.from}|${range.to}`, (signal) =>
    fetchChangeOutcomes(client, range, signal),
  );

  return (
    <Card title={fr.changes.closeCodesTitle} hint={fr.changes.closeCodesHint}>
      <CloseCodeBody result={result} service={service} />
    </Card>
  );
}
