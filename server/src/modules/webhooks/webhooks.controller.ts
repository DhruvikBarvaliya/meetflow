/**
 * Webhooks HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve the tenant from the
 * request context, call the service, send the envelope. Every rule about who
 * may subscribe to what — and, more importantly, about what may be read back —
 * lives in webhooks.service.ts.
 *
 * Nothing here shapes a response body of its own. That is deliberate in this
 * module above all others: the endpoint row carries a signing secret, so the
 * projection is a security rule rather than a presentation detail, and it lives
 * in the service where a reviewer looking for the rule will find it.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import type { WebhookActor } from './webhooks.service';
import * as webhookService from './webhooks.service';
import {
  createWebhookSchema,
  listDeliveriesQuerySchema,
  listWebhooksQuerySchema,
  updateWebhookSchema,
  webhookIdParamsSchema,
} from './webhooks.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): WebhookActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

export const listWebhooks = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const filters = query(req, listWebhooksQuerySchema);
  const result = await webhookService.listEndpoints(businessId, filters);
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});

/**
 * 201 with the signing secret in the body — the only response in the API that
 * carries one, and the only time this one is ever readable.
 */
export const createWebhook = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const endpoint = await webhookService.createEndpoint(
    businessId,
    body(req, createWebhookSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, endpoint, {
    // Stated in the response rather than only in the documentation: this is the
    // one moment the secret exists outside the database, and a client that does
    // not store it now has to delete the endpoint and register another.
    secretRetrievable: false,
  });
});

export const getWebhook = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, webhookIdParamsSchema);
  sendSuccess(res, await webhookService.getEndpoint(businessId, id));
});

export const updateWebhook = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, webhookIdParamsSchema);
  const endpoint = await webhookService.updateEndpoint(
    businessId,
    id,
    body(req, updateWebhookSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, endpoint);
});

export const deleteWebhook = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, webhookIdParamsSchema);
  await webhookService.deleteEndpoint(businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

/**
 * 202-shaped semantics under a 201: the delivery row exists, the attempt has
 * not happened yet. The client polls the delivery history for the outcome,
 * which is the same thing every other subscriber's event does.
 */
export const sendWebhookTest = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, webhookIdParamsSchema);
  const delivery = await webhookService.sendTestEvent(
    businessId,
    id,
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, delivery);
});

export const listWebhookDeliveries = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { id } = params(req, webhookIdParamsSchema);
  const filters = query(req, listDeliveriesQuerySchema);
  const result = await webhookService.listDeliveries(businessId, id, filters);
  sendPage(res, result.rows, {
    page: result.page,
    pageSize: result.pageSize,
    totalItems: result.totalItems,
  });
});
