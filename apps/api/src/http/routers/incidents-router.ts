import type { RequestHandler } from 'express';
import { Router } from 'express';

import { toIncident } from '../../domain/incident.js';
import { planIncidentUpdate } from '../../domain/incident-update.js';
import { slaDueAt } from '../../domain/sla.js';
import type { Clock } from '../../ports/clock.js';
import type { IncidentRepository } from '../../ports/repositories.js';
import { HttpError } from '../errors.js';
import { requireRole } from '../middlewares/auth.js';
import {
  CreateIncidentBodySchema,
  IncidentListQuerySchema,
  IncidentParamsSchema,
  PatchIncidentBodySchema,
  requestedRange,
} from '../schemas.js';
import { validBody, validParams, validQuery } from '../validate.js';

export interface IncidentsRouterDeps {
  incidents: IncidentRepository;
  clock: Clock;
}

function notFound(number: string): HttpError {
  return new HttpError('NOT_FOUND', `Incident ${number} not found`);
}

function list({ incidents, clock }: IncidentsRouterDeps): RequestHandler {
  return async (req, res) => {
    const { from, to, ...query } = validQuery(IncidentListQuerySchema, req);
    const now = clock();
    const page = await incidents.list({ ...query, range: requestedRange({ from, to }, now) });
    res.json({
      items: page.items.map((record) => toIncident(record, now)),
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
    });
  };
}

function getOne({ incidents, clock }: IncidentsRouterDeps): RequestHandler {
  return async (req, res) => {
    const { number } = validParams(IncidentParamsSchema, req);
    const record = await incidents.findByNumber(number);
    if (record === null) throw notFound(number);
    res.json(toIncident(record, clock()));
  };
}

function create({ incidents, clock }: IncidentsRouterDeps): RequestHandler {
  return async (req, res) => {
    const body = validBody(CreateIncidentBodySchema, req);
    const openedAt = clock();
    const result = await incidents.create({
      ...body,
      openedAt,
      slaDueAt: slaDueAt(openedAt, body.priority),
    });
    if (result.status === 'unknown_assignment_group') {
      throw new HttpError('VALIDATION_FAILED', 'Request validation failed', [
        { location: 'body', path: 'assignmentGroup', message: 'Unknown assignment group' },
      ]);
    }
    res.status(201).json(toIncident(result.incident, openedAt));
  };
}

function update({ incidents, clock }: IncidentsRouterDeps): RequestHandler {
  return async (req, res) => {
    const { number } = validParams(IncidentParamsSchema, req);
    const patch = validBody(PatchIncidentBodySchema, req);
    const current = await incidents.findByNumber(number);
    if (current === null) throw notFound(number);
    const now = clock();
    const updated = await incidents.update(number, planIncidentUpdate(current, patch, now));
    if (updated === null) throw notFound(number);
    res.json(toIncident(updated, now));
  };
}

/** Mounted behind authenticate(): every route needs at least the viewer role. */
export function incidentsRouter(deps: IncidentsRouterDeps): Router {
  const router = Router();
  router.get('/', list(deps));
  router.get('/:number', getOne(deps));
  router.post('/', requireRole('analyst'), create(deps));
  router.patch('/:number', requireRole('analyst'), update(deps));
  return router;
}
