/**
 * Notification-template HTTP layer.
 *
 * Thin, like every controller here: read validated input, resolve the tenant
 * from the request context, call the service, send the envelope. Which
 * placeholders a message may use, and what happens when a draft names one it
 * cannot fill, live in `templates.service.ts` and `placeholders.ts`.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendNoContent, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import * as templateService from './templates.service';
import type { TemplateActor } from './templates.service';
import {
  listTemplatesQuerySchema,
  previewTemplateSchema,
  templateParamsSchema,
  upsertTemplateSchema,
} from './templates.validation';

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

function actorOf(req: Request): TemplateActor {
  if (!req.auth) throw new UnauthenticatedError();
  return { userId: req.auth.userId, email: req.auth.email };
}

/**
 * Not paginated. There are sixteen keys across three channels and the screen is
 * a single list an operator scans — paginating it would add a page control to
 * something that has never had a second page and never will.
 */
export const listTemplates = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const filters = query(req, listTemplatesQuerySchema);
  const rows = await templateService.listTemplates(businessId, filters);
  sendSuccess(res, rows);
});

export const getTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { key, channel } = params(req, templateParamsSchema);
  sendSuccess(res, await templateService.getTemplate(businessId, key, channel));
});

export const upsertTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { key, channel } = params(req, templateParamsSchema);
  const input = body(req, upsertTemplateSchema);
  const view = await templateService.upsertTemplate(
    businessId,
    key,
    channel,
    input,
    actorOf(req),
    metadataOf(req),
  );
  // 200 rather than 201: the address is fixed by the key and channel, so this
  // never creates a resource at a URL the caller did not already have.
  sendSuccess(res, view);
});

export const resetTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { businessId } = tenantOf(req);
  const { key, channel } = params(req, templateParamsSchema);
  await templateService.resetTemplate(businessId, key, channel, actorOf(req), metadataOf(req));
  sendNoContent(res);
});

/**
 * Renders a draft against sample data. Reads nothing and writes nothing, but is
 * a POST because the draft is the payload — a body an operator is still editing
 * does not belong in a query string, in a proxy log, or in browser history.
 */
export const previewTemplate = asyncHandler(async (req: Request, res: Response) => {
  const { key, channel } = params(req, templateParamsSchema);
  const input = body(req, previewTemplateSchema);
  sendSuccess(res, templateService.previewTemplate(key, channel, input));
});
