import { INCIDENT_STATES, PRIORITIES, SERVICES } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import type { SelectOption } from '../../ui/SelectField';

export const STATE_OPTIONS: readonly SelectOption[] = INCIDENT_STATES.map((state) => ({
  value: state,
  label: fr.incidentState[state],
}));

export const PRIORITY_OPTIONS: readonly SelectOption[] = PRIORITIES.map((priority) => ({
  value: String(priority),
  label: fr.priority.names[priority],
}));

export const SERVICE_OPTIONS: readonly SelectOption[] = SERVICES.map((service) => ({
  value: service,
  label: service,
}));
