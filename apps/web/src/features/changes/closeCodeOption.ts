import type { ChangeOutcome, CloseCode } from '../../api/schemas';
import { CLOSE_CODES } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import type { ChartOption } from '../../ui/chart/echartsCore';
import { BASE_OPTION, STATUS_COLORS } from '../shared/chartStyle';

const CLOSE_CODE_COLORS: Readonly<Record<CloseCode, string>> = {
  successful: STATUS_COLORS.good,
  unsuccessful: STATUS_COLORS.critical,
  backed_out: STATUS_COLORS.warning,
};

export interface CloseCodeCounts {
  readonly services: readonly string[];
  /** counts[code][i] is the number of changes of services[i] closed with `code`. */
  readonly counts: Readonly<Record<CloseCode, readonly number[]>>;
}

/** The API's (service, close code, count) rows pivoted into one aligned series per close code. */
export function closeCodeCounts(outcomes: readonly ChangeOutcome[]): CloseCodeCounts {
  const services = [...new Set(outcomes.map((outcome) => outcome.service))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const countByKey = new Map(
    outcomes.map((outcome) => [`${outcome.service}|${outcome.closeCode}`, outcome.count]),
  );
  function countFor(code: CloseCode): number[] {
    return services.map((service) => countByKey.get(`${service}|${code}`) ?? 0);
  }
  return {
    services,
    counts: {
      successful: countFor('successful'),
      unsuccessful: countFor('unsuccessful'),
      backed_out: countFor('backed_out'),
    },
  };
}

/** One stacked bar per service: successful, failed and backed-out changes. */
export function closeCodeOption({ services, counts }: CloseCodeCounts): ChartOption {
  return {
    ...BASE_OPTION,
    grid: { left: 40, right: 16, top: 40, bottom: 32 },
    legend: { top: 0 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: [...services] },
    yAxis: { type: 'value', minInterval: 1 },
    series: CLOSE_CODES.map((code) => ({
      type: 'bar',
      name: fr.closeCode[code],
      stack: 'closeCodes',
      barMaxWidth: 40,
      color: CLOSE_CODE_COLORS[code],
      emphasis: { focus: 'series' },
      data: [...counts[code]],
    })),
  };
}
