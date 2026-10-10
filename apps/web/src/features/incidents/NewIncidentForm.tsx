import { useState, type SubmitEvent } from 'react';

import { toApiError } from '../../api/apiError';
import { createIncident } from '../../api/endpoints';
import { CreateIncidentBodySchema, type Incident } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { useApiClient } from '../../state/auth/AuthContext';
import { describeError } from '../../state/describeError';
import { SelectField } from '../../ui/SelectField';
import { TextField } from '../../ui/TextField';
import { PRIORITY_OPTIONS, SERVICE_OPTIONS } from '../shared/options';
import { SidePanel } from '../shared/SidePanel';

const { form } = fr.incidents;

interface Draft {
  readonly shortDescription: string;
  readonly priority: string;
  readonly category: string;
  readonly service: string;
  readonly assignmentGroup: string;
}

type DraftField = keyof Draft;
type DraftErrors = Partial<Record<DraftField, string>>;

const EMPTY_DRAFT: Draft = {
  shortDescription: '',
  priority: '3',
  category: '',
  service: '',
  assignmentGroup: '',
};

const DRAFT_FIELDS = new Set<PropertyKey | undefined>(Object.keys(EMPTY_DRAFT));

function isDraftField(key: PropertyKey | undefined): key is DraftField {
  return DRAFT_FIELDS.has(key);
}

/** The draft as the API body, or one French message per invalid field. */
function parseDraft(draft: Draft) {
  const parsed = CreateIncidentBodySchema.safeParse({ ...draft, priority: Number(draft.priority) });
  if (parsed.success) return { body: parsed.data, errors: {} };
  const errors: DraftErrors = {};
  for (const issue of parsed.error.issues) {
    const [field] = issue.path;
    if (isDraftField(field)) errors[field] = form.errors[field];
  }
  return { body: null, errors };
}

interface NewIncidentFormProps {
  readonly onCancel: () => void;
  readonly onCreated: (incident: Incident) => void;
}

/** "Déclarer un incident": the POST /incidents form, validated by the contract schema. */
export function NewIncidentForm({ onCancel, onCreated }: NewIncidentFormProps) {
  const client = useApiClient();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: DraftField) {
    return (value: string) => {
      setDraft((previous) => ({ ...previous, [field]: value }));
    };
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const { body, errors: fieldErrors } = parseDraft(draft);
    setErrors(fieldErrors);
    setFailure(null);
    if (body === null) return;
    setSubmitting(true);
    try {
      onCreated(await createIncident(client, body));
    } catch (error) {
      setFailure(describeError(toApiError(error)));
      setSubmitting(false);
    }
  }

  return (
    <SidePanel title={form.title} closeLabel={form.cancel} onClose={onCancel}>
      <form className="panel-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <TextField
          label={form.shortDescription}
          required
          value={draft.shortDescription}
          onChange={update('shortDescription')}
          errorMessage={errors.shortDescription}
        />
        <SelectField
          label={fr.filters.priority}
          required
          value={draft.priority}
          options={PRIORITY_OPTIONS}
          onChange={update('priority')}
          errorMessage={errors.priority}
        />
        <SelectField
          label={fr.filters.service}
          required
          value={draft.service}
          emptyLabel={form.choose}
          options={SERVICE_OPTIONS}
          onChange={update('service')}
          errorMessage={errors.service}
        />
        <TextField
          label={form.category}
          required
          value={draft.category}
          onChange={update('category')}
          errorMessage={errors.category}
        />
        <TextField
          label={form.assignmentGroup}
          required
          value={draft.assignmentGroup}
          onChange={update('assignmentGroup')}
          errorMessage={errors.assignmentGroup}
        />
        {failure === null ? null : (
          <p className="form-alert" role="alert">
            {failure}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button button--secondary" onClick={onCancel}>
            {form.cancel}
          </button>
          <button type="submit" className="button button--primary" disabled={submitting}>
            {submitting ? form.submitting : form.submit}
          </button>
        </div>
      </form>
    </SidePanel>
  );
}
