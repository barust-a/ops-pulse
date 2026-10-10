import type { Change } from '../../api/schemas';
import { formatDateTime } from '../../i18n/format';
import { fr } from '../../i18n/fr';

const { columns } = fr.changes;

/** "Réussi" / "Échec" / "Retour arrière" pill, or a dash while the change is open. */
function CloseCodeBadge({ closeCode }: { readonly closeCode: Change['closeCode'] }) {
  if (closeCode === null) return <span className="badge badge--muted">{fr.closeCode.none}</span>;
  return <span className={`badge badge--close-${closeCode}`}>{fr.closeCode[closeCode]}</span>;
}

/** "Liste des changements": one row per change request. */
export function ChangeTable({ changes }: { readonly changes: readonly Change[] }) {
  if (changes.length === 0) return <p className="table-empty">{fr.changes.empty}</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{fr.changes.tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{columns.number}</th>
            <th scope="col">{columns.shortDescription}</th>
            <th scope="col">{columns.type}</th>
            <th scope="col">{columns.risk}</th>
            <th scope="col">{columns.state}</th>
            <th scope="col">{columns.closeCode}</th>
            <th scope="col">{columns.service}</th>
            <th scope="col">{columns.plannedStart}</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.number}>
              <td className="mono">{change.number}</td>
              <td className="cell-description">{change.shortDescription}</td>
              <td>
                <span className={`badge badge--type-${change.type}`}>{fr.changeType[change.type]}</span>
              </td>
              <td>
                <span className={`badge badge--risk-${change.risk}`}>{fr.changeRisk[change.risk]}</span>
              </td>
              <td>{fr.changeState[change.state]}</td>
              <td>
                <CloseCodeBadge closeCode={change.closeCode} />
              </td>
              <td>{change.service}</td>
              <td className="nowrap">{formatDateTime(change.plannedStart)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
