import type { IncidentState, Priority } from '../../api/schemas';
import { fr } from '../../i18n/fr';

/** "P1" … "P4", coloured from critical to low. */
export function PriorityBadge({ priority }: { readonly priority: Priority }) {
  return (
    <span className={`badge badge--p${String(priority)}`} title={fr.priority.names[priority]}>
      {fr.priority.short(priority)}
    </span>
  );
}

/** "Nouveau", "En cours"… as a pill. */
export function IncidentStateBadge({ state }: { readonly state: IncidentState }) {
  return <span className={`badge badge--state-${state}`}>{fr.incidentState[state]}</span>;
}

/** "Dépassé" in red, or a muted "Dans les délais". */
export function SlaBadge({ breached }: { readonly breached: boolean }) {
  return breached ? (
    <span className="badge badge--breach">{fr.incidents.slaBreached}</span>
  ) : (
    <span className="badge badge--muted">{fr.incidents.slaOk}</span>
  );
}
