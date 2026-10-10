import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import type { ChangePage, IncidentPage, LoginResponse } from '../api/schemas';
import {
  analystUser,
  change,
  changeOutcomes,
  dailyKpis,
  heatmap,
  incident,
  kpiSummary,
  priorityKpis,
} from './fixtures';

/** Matches the API on any origin: the client resolves `/api/v1` against `location.origin`. */
export function apiPath(path: string): string {
  return `*/api/v1${path}`;
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

const incidentPage: IncidentPage = {
  items: [
    incident(),
    incident({ number: 'INC0010002', priority: 1, state: 'new', slaBreached: false }),
  ],
  page: 1,
  pageSize: 25,
  total: 2,
};

const changePage: ChangePage = {
  items: [change(), change({ number: 'CHG0030008', closeCode: 'successful', service: 'crm' })],
  page: 1,
  pageSize: 25,
  total: 2,
};

const loginResponse: LoginResponse = { token: 'test-token', user: analystUser };

const defaultHandlers = [
  http.post(apiPath('/auth/login'), () => HttpResponse.json(loginResponse)),
  http.get(apiPath('/kpis/summary'), () => HttpResponse.json(kpiSummary)),
  http.get(apiPath('/kpis/daily'), () => HttpResponse.json({ items: dailyKpis })),
  http.get(apiPath('/kpis/by-priority'), () => HttpResponse.json({ items: priorityKpis })),
  http.get(apiPath('/kpis/heatmap'), () => HttpResponse.json({ items: heatmap })),
  http.get(apiPath('/incidents'), () => HttpResponse.json(incidentPage)),
  http.post(apiPath('/incidents'), () =>
    HttpResponse.json(incident({ number: 'INC0010999', state: 'new' }), { status: 201 }),
  ),
  http.patch(apiPath('/incidents/:number'), () =>
    HttpResponse.json(incident({ state: 'resolved' })),
  ),
  http.get(apiPath('/changes'), () => HttpResponse.json(changePage)),
  http.get(apiPath('/kpis/change-outcomes'), () => HttpResponse.json({ items: changeOutcomes })),
];

export const server = setupServer(...defaultHandlers);
