import { useState, type SubmitEvent } from 'react';

import { toApiError } from '../../api/apiError';
import { updateIncident } from '../../api/endpoints';
import { UpdateIncidentBodySchema, type Incident, type UpdateIncidentBody } from '../../api/schemas';
import { formatDateTime } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import { useApiClient } from '../../state/auth/AuthContext';
import { describeError } from '../../state/describeError';
import { SelectField } from '../../ui/SelectField';
import { IncidentStateBadge, PriorityBadge, SlaBadge } from '../shared/Badges';
import { PRIORITY_OPTIONS, STATE_OPTIONS } from '../shared/options';
import { SidePanel } from '../shared/SidePanel';

const { detail } = fr.incidents;

/** Only the fields the analyst actually changed go into the PATCH body. */
function changedFields(incident: Incident, state: string, priority: string): UpdateIncidentBody {
  const parsed = UpdateIncidentBodySchema.safeParse({ state, priority: Number(priority) });
  if (!parsed.success) return {};
  const body: { state?: Incident['state']; priority?: Incident['priority'] } = {};
  if (parsed.data.state !== incident.state) body.state = parsed.data.state;
  if (parsed.data.priority !== incident.priority) body.priority = parsed.data.priority;
  return body;
}

interface UpdateFormProps {
  readonly incident: Incident;
  readonly onUpdated: (incident: Incident) => void;
}

/** "Mettre à jour": state and priority selects, for analysts and admins only. */
function IncidentUpdateForm({ incident, onUpdated }: UpdateFormProps) {
  const client = useApiClient();
  const [state, setState] = useState<string>(incident.state);
  const [priority, setPriority] = useState(String(incident.priority));
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const body = changedFields(incident, state, priority);
  const hasChanges = body.state !== undefined || body.priority !== undefined;

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setFailure(null);
    try {
      onUpdated(await updateIncident(client, incident.number, body));
    } catch (error) {
      setFailure(describeError(toApiError(error)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="panel-form" onSubmit={(event) => void handleSubmit(event)}>
      <SelectField label={fr.filters.state} value={state} options={STATE_OPTIONS} onChange={setState} />
      <SelectField
        label={fr.filters.priority}
        value={priority}
        options={PRIORITY_OPTIONS}
        onChange={setPriority}
      />
      {failure === null ? null : (
        <p className="form-alert" role="alert">
          {failure}
        </p>
      )}
      <button type="submit" className="button button--primary" disabled={!hasChanges || submitting}>
        {submitting ? detail.updating : detail.update}
      </button>
    </form>
  );
}

interface IncidentDetailPanelProps {
  readonly incident: Incident;
  readonly canEdit: boolean;
  readonly onClose: () => void;
  readonly onUpdated: (incident: Incident) => void;
}

/** "Incident INC0010001": every field of the incident, then the update form or a read-only note. */
export function IncidentDetailPanel({ incident, canEdit, onClose, onUpdated }: IncidentDetailPanelProps) {
  return (
    <SidePanel title={detail.title(incident.number)} closeLabel={detail.close} onClose={onClose}>
      <p className="side-panel__lead">{incident.shortDescription}</p>
      <div className="badge-row">
        <PriorityBadge priority={incident.priority} />
        <IncidentStateBadge state={incident.state} />
        <SlaBadge breached={incident.slaBreached} />
      </div>
      <dl className="detail-list">
        <dt>{fr.incidents.columns.service}</dt>
        <dd>{incident.service}</dd>
        <dt>{detail.category}</dt>
        <dd>{incident.category}</dd>
        <dt>{detail.assignmentGroup}</dt>
        <dd>{incident.assignmentGroup}</dd>
        <dt>{detail.openedAt}</dt>
        <dd>{formatDateTime(incident.openedAt)}</dd>
        <dt>{detail.slaDueAt}</dt>
        <dd>{formatDateTime(incident.slaDueAt)}</dd>
        <dt>{detail.resolvedAt}</dt>
        <dd>{incident.resolvedAt === null ? detail.notResolved : formatDateTime(incident.resolvedAt)}</dd>
        <dt>{detail.causedByChange}</dt>
        <dd className="mono">{incident.causedByChange ?? detail.none}</dd>
      </dl>
      {canEdit ? (
        <IncidentUpdateForm key={`${incident.number}-${incident.state}-${String(incident.priority)}`} incident={incident} onUpdated={onUpdated} />
      ) : (
        <p className="read-only-note">{detail.readOnly}</p>
      )}
    </SidePanel>
  );
}
