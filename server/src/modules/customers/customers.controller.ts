/**
 * Customers HTTP layer.
 *
 * Controllers stay thin: read validated input, take the tenant from the proven
 * membership, call the service, shape the response. All business rules live in
 * customers.service.ts.
 */
import type { Request, Response } from 'express';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { body, params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendCreated, sendNoContent, sendPage, sendSuccess } from '../../utils/http';
import type { RequestMetadata } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import * as customerService from './customers.service';
import {
  createCustomerSchema,
  customerIdParamSchema,
  listCustomerAppointmentsQuerySchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from './customers.validation';

/**
 * The note capability is resolved here, from the same effective permission set
 * `requirePermission` uses, because it cannot be declared on the route: whether
 * a request writes a note depends on the body it carries.
 */
function actorOf(req: Request): customerService.CustomerActor {
  if (!req.auth) throw new UnauthenticatedError();
  return {
    userId: req.auth.userId,
    email: req.auth.email,
    canManageNotes: tenantOf(req).permissions.has(PERMISSIONS.CUSTOMERS_NOTES_MANAGE),
  };
}

function metadataOf(req: Request): RequestMetadata {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: requestIdOf(req),
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const filters = query(req, listCustomersQuerySchema);
  const { rows, totalItems } = await customerService.listCustomers(
    tenantOf(req).businessId,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const customer = await customerService.createCustomer(
    tenantOf(req).businessId,
    body(req, createCustomerSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendCreated(res, customer);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, customerIdParamSchema);
  const detail = await customerService.getCustomer(tenantOf(req).businessId, id);
  sendSuccess(res, detail);
});

export const listAppointments = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, customerIdParamSchema);
  const filters = query(req, listCustomerAppointmentsQuerySchema);
  const { rows, totalItems } = await customerService.listCustomerAppointments(
    tenantOf(req).businessId,
    id,
    filters,
  );
  sendPage(res, rows, { page: filters.page, pageSize: filters.pageSize, totalItems });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, customerIdParamSchema);
  const customer = await customerService.updateCustomer(
    tenantOf(req).businessId,
    id,
    body(req, updateCustomerSchema),
    actorOf(req),
    metadataOf(req),
  );
  sendSuccess(res, customer);
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params(req, customerIdParamSchema);
  await customerService.deleteCustomer(tenantOf(req).businessId, id, actorOf(req), metadataOf(req));
  sendNoContent(res);
});
