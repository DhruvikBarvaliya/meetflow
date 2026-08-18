/**
 * `/api/v1/customers`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to customers: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * `requirePermission` runs before `validate` so a caller who may not see
 * customers at all learns nothing from the shape of the validation errors.
 *
 * One rule cannot be expressed here: writing the internal `notes` field also
 * needs CUSTOMERS_NOTES_MANAGE, and whether a request writes a note depends on
 * the body it carries. The service enforces that per request.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './customers.controller';
import {
  createCustomerSchema,
  customerIdParamSchema,
  listCustomerAppointmentsQuerySchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from './customers.validation';

export const customersRouter = Router();

customersRouter.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ query: listCustomersQuerySchema }),
  controller.list,
);

customersRouter.post(
  '/',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ body: createCustomerSchema }),
  controller.create,
);

customersRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ params: customerIdParamSchema }),
  controller.get,
);

customersRouter.get(
  '/:id/appointments',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ params: customerIdParamSchema, query: listCustomerAppointmentsQuerySchema }),
  controller.listAppointments,
);

customersRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params: customerIdParamSchema, body: updateCustomerSchema }),
  controller.update,
);

customersRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params: customerIdParamSchema }),
  controller.remove,
);
