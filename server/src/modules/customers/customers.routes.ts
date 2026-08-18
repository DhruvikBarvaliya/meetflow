/**
 * `/api/v1/customers`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore declares
 * only what is specific to customers: the permission each verb needs and the
 * schema each request must satisfy.
 *
 * The permission check runs before `validate` so a caller who may not see
 * customers at all learns nothing from the shape of the validation errors.
 *
 * Two rules cannot be expressed here:
 *
 *  - **Reads use `requireAnyPermission`.** `customers:read` and
 *    `customers:read:assigned` are the same capability at two widths, and the
 *    router cannot choose between them: which people a member may see is a
 *    property of the rows, not of the route. It lets both through and the
 *    service narrows to the customers booked with that provider — and answers
 *    404, never 403, for anyone outside that set. This is the same shape the
 *    appointments module uses for `appointments:read` / `:read:own`, and for
 *    the same reason.
 *  - **Writing the internal `notes` field also needs CUSTOMERS_NOTES_MANAGE**,
 *    and whether a request writes a note depends on the body it carries. The
 *    service enforces that per request.
 *
 * The write routes stay on the single `customers:manage` and take no scope:
 * `customers:read:assigned` widens who may *look*, and a role that may edit the
 * address book has always been able to see all of it.
 */
import { Router } from 'express';
import { requireAnyPermission, requirePermission } from '../../middleware/tenant';
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

const READ_PERMISSIONS = [PERMISSIONS.CUSTOMERS_READ, PERMISSIONS.CUSTOMERS_READ_ASSIGNED] as const;

customersRouter.get(
  '/',
  requireAnyPermission(...READ_PERMISSIONS),
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
  requireAnyPermission(...READ_PERMISSIONS),
  validate({ params: customerIdParamSchema }),
  controller.get,
);

customersRouter.get(
  '/:id/appointments',
  requireAnyPermission(...READ_PERMISSIONS),
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
