import { z } from 'zod';

import { ChangeSchema } from '../domain/change.js';
import { IncidentSchema } from '../domain/incident.js';
import {
  ChangeOutcomeSchema,
  DailyKpiSchema,
  HeatmapCellSchema,
  KpiSummarySchema,
  PriorityKpiSchema,
} from '../domain/kpi.js';
import { SERVICES } from '../domain/service.js';
import { UserSchema } from '../domain/user.js';
import { INCIDENT_SORTS } from '../ports/repositories.js';
import { ErrorResponseSchema } from './errors.js';
import { CreateIncidentBodySchema, LoginBodySchema, PatchIncidentBodySchema } from './schemas.js';

// The component schemas are generated from the same zod schemas the API validates and serialises
// with (JSON Schema 2020-12, the dialect OpenAPI 3.1 uses), so the document cannot drift from them.

type SchemaObject = z.core.JSONSchema.BaseSchema;

interface ParameterObject {
  name: string;
  in: 'query' | 'path';
  required?: boolean;
  description?: string;
  schema: SchemaObject;
}

interface ResponseObject {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

interface OperationObject {
  tags: string[];
  summary: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: ParameterObject[];
  requestBody?: { required: true; content: Record<string, { schema: SchemaObject }> };
  responses: Record<string, ResponseObject>;
}

type PathItem = Partial<Record<'get' | 'post' | 'patch', OperationObject>>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, SchemaObject>;
    securitySchemes: Record<string, { type: 'http'; scheme: 'bearer'; bearerFormat: 'JWT' }>;
  };
}

function ref(name: string): SchemaObject {
  return { $ref: `#/components/schemas/${name}` };
}

function json(schema: SchemaObject): Record<string, { schema: SchemaObject }> {
  return { 'application/json': { schema } };
}

function ok(description: string, schema: SchemaObject): ResponseObject {
  return { description, content: json(schema) };
}

const ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '400': 'VALIDATION_FAILED: the request does not match its schema',
  '401': 'UNAUTHENTICATED: missing, invalid or expired bearer token',
  '403': 'FORBIDDEN: the role does not allow this action',
  '404': 'NOT_FOUND',
  '429': 'RATE_LIMITED: 5 attempts per minute and per IP',
};

function errors(...statuses: string[]): Record<string, ResponseObject> {
  return Object.fromEntries(
    statuses.map((status) => [status, ok(ERROR_DESCRIPTIONS[status] ?? status, ref('Error'))]),
  );
}

function page(item: string): SchemaObject {
  return {
    type: 'object',
    required: ['items', 'page', 'pageSize', 'total'],
    properties: {
      items: { type: 'array', items: ref(item) },
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      total: { type: 'integer', minimum: 0 },
    },
  };
}

function itemsOf(schema: SchemaObject): SchemaObject {
  return { type: 'object', required: ['items'], properties: { items: { type: 'array', items: schema } } };
}

function query(name: string, schema: SchemaObject, description?: string): ParameterObject {
  return description === undefined
    ? { name, in: 'query', schema }
    : { name, in: 'query', schema, description };
}

const BEARER = [{ bearerAuth: [] }];
const DATE = { type: 'string', format: 'date' } as const;
const RANGE = [
  query('from', DATE, 'First day, YYYY-MM-DD (default: 29 days before `to`)'),
  query('to', DATE, 'Last day included, YYYY-MM-DD (default: today, UTC)'),
];
const SERVICE = query('service', { type: 'string', enum: [...SERVICES] });
const PAGING = [
  query('page', { type: 'integer', minimum: 1, default: 1 }),
  query('pageSize', { type: 'integer', minimum: 1, maximum: 100, default: 25 }),
];
const NUMBER: ParameterObject = {
  name: 'number',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: String.raw`^INC\d{7}$` },
};

function component(schema: z.ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  return z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
}

function viewer(tag: string, summary: string, extra: Partial<OperationObject>): OperationObject {
  return { tags: [tag], summary, security: BEARER, responses: {}, ...extra };
}

const SYSTEM_AND_AUTH_PATHS: Record<string, PathItem> = {
  '/health': {
    get: {
      tags: ['system'],
      summary: 'Liveness and database status',
      responses: {
        '200': ok('API up; `db` tells whether PostgreSQL answers', {
          type: 'object',
          required: ['status', 'db', 'version'],
          properties: {
            status: { const: 'ok' },
            db: { type: 'string', enum: ['up', 'down'] },
            version: { type: 'string' },
          },
        }),
      },
    },
  },
  '/auth/login': {
    post: {
      tags: ['auth'],
      summary: 'Exchange credentials for a bearer token',
      requestBody: { required: true, content: json(ref('LoginRequest')) },
      responses: {
        '200': ok('Authenticated', {
          type: 'object',
          required: ['token', 'user'],
          properties: { token: { type: 'string' }, user: ref('User') },
        }),
        ...errors('400', '401', '429'),
      },
    },
  },
  '/auth/me': {
    get: viewer('auth', 'The authenticated user', {
      responses: { '200': ok('The user', ref('User')), ...errors('401') },
    }),
  },
  '/auth/saml/metadata': {
    get: {
      tags: ['auth'],
      summary: 'SAML 2.0 service-provider metadata (when SAML_ENABLED=true)',
      responses: {
        '200': {
          description: 'SP metadata XML',
          content: { 'application/samlmetadata+xml': { schema: { type: 'string' } } },
        },
        ...errors('404'),
      },
    },
  },
};

const INCIDENT_PATHS: Record<string, PathItem> = {
  '/incidents': {
    get: viewer('incidents', 'Search incidents (viewer+)', {
      parameters: [
        ...RANGE,
        SERVICE,
        query('priority', { type: 'integer', enum: [1, 2, 3, 4] }, '1 = critical'),
        query('state', component(IncidentSchema.shape.state)),
        query('q', { type: 'string', maxLength: 100 }, 'Matches the number or short description'),
        ...PAGING,
        query('sort', { type: 'string', enum: [...INCIDENT_SORTS], default: '-openedAt' }),
      ],
      responses: { '200': ok('A page of incidents', page('Incident')), ...errors('400', '401') },
    }),
    post: viewer('incidents', 'Open an incident (analyst+)', {
      requestBody: { required: true, content: json(ref('CreateIncidentRequest')) },
      responses: { '201': ok('Created', ref('Incident')), ...errors('400', '401', '403') },
    }),
  },
  '/incidents/{number}': {
    get: viewer('incidents', 'One incident (viewer+)', {
      parameters: [NUMBER],
      responses: { '200': ok('The incident', ref('Incident')), ...errors('400', '401', '404') },
    }),
    patch: viewer('incidents', 'Change state and/or priority (analyst+)', {
      description: 'Resolving stamps resolvedAt, reopening clears it, a new priority moves slaDueAt.',
      parameters: [NUMBER],
      requestBody: { required: true, content: json(ref('PatchIncidentRequest')) },
      responses: {
        '200': ok('The updated incident', ref('Incident')),
        ...errors('400', '401', '403', '404'),
      },
    }),
  },
};

const CHANGE_AND_KPI_PATHS: Record<string, PathItem> = {
  '/changes': {
    get: viewer('changes', 'Search changes by planned start (viewer+)', {
      parameters: [
        ...RANGE,
        SERVICE,
        query('state', component(ChangeSchema.shape.state)),
        query('type', component(ChangeSchema.shape.type)),
        ...PAGING,
      ],
      responses: { '200': ok('A page of changes', page('Change')), ...errors('400', '401') },
    }),
  },
  '/kpis/summary': {
    get: viewer('kpis', 'KPIs over a range, from the Dataiku daily table', {
      description: 'Rates are weighted by their denominators; zeros while Dataiku has not computed the range.',
      parameters: [...RANGE, SERVICE],
      responses: { '200': ok('Summary', ref('KpiSummary')), ...errors('400', '401') },
    }),
  },
  '/kpis/daily': {
    get: viewer('kpis', 'Daily KPIs per service, from the Dataiku daily table', {
      parameters: [...RANGE, SERVICE],
      responses: { '200': ok('Daily rows', itemsOf(ref('DailyKpi'))), ...errors('400', '401') },
    }),
  },
  '/kpis/by-priority': {
    get: viewer('kpis', 'Live incident count, MTTR and SLA breach rate per priority', {
      parameters: RANGE,
      responses: { '200': ok('One item per priority', itemsOf(ref('PriorityKpi'))), ...errors('400', '401') },
    }),
  },
  '/kpis/heatmap': {
    get: viewer('kpis', 'Live incidents opened per weekday (Mon = 0) and UTC hour', {
      parameters: RANGE,
      responses: { '200': ok('The 7 × 24 grid', itemsOf(ref('HeatmapCell'))), ...errors('400', '401') },
    }),
  },
  '/kpis/change-outcomes': {
    get: viewer('kpis', 'Live count of changes closed per service and close code', {
      parameters: RANGE,
      responses: { '200': ok('Counts', itemsOf(ref('ChangeOutcome'))), ...errors('400', '401') },
    }),
  },
};

const COMPONENTS: OpenApiDocument['components'] = {
  schemas: {
    Error: component(ErrorResponseSchema),
    User: component(UserSchema),
    LoginRequest: component(LoginBodySchema, 'input'),
    Incident: component(IncidentSchema),
    CreateIncidentRequest: component(CreateIncidentBodySchema, 'input'),
    PatchIncidentRequest: component(PatchIncidentBodySchema, 'input'),
    Change: component(ChangeSchema),
    KpiSummary: component(KpiSummarySchema),
    DailyKpi: component(DailyKpiSchema),
    PriorityKpi: component(PriorityKpiSchema),
    HeatmapCell: component(HeatmapCellSchema),
    ChangeOutcome: component(ChangeOutcomeSchema),
  },
  securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
};

const TAGS: OpenApiDocument['tags'] = [
  { name: 'system', description: 'Health and documentation' },
  { name: 'auth', description: 'Login with email and password (JWT), SAML extension point' },
  { name: 'incidents', description: 'Incident records' },
  { name: 'changes', description: 'Change records' },
  { name: 'kpis', description: 'Supervision statistics' },
];

const DESCRIPTION =
  'Operations supervision: ServiceNow-shaped incidents and changes, and the KPIs the Dataiku flow computes. ' +
  'Errors always use the `Error` shape. Viewer < analyst < admin.';

export function buildOpenApiDocument(version: string): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Ops Pulse API', version, description: DESCRIPTION },
    servers: [{ url: '/api/v1' }],
    tags: TAGS,
    paths: { ...SYSTEM_AND_AUTH_PATHS, ...INCIDENT_PATHS, ...CHANGE_AND_KPI_PATHS },
    components: COMPONENTS,
  };
}
