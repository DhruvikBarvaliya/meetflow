/**
 * `/api/v1/teams`
 *
 * Mounted on the management router, which has already applied
 * `authenticate -> apiRateLimit -> requireTenant`; this file therefore only
 * declares what each endpoint additionally requires. The permission guard runs
 * before validation so a caller who may not touch teams learns nothing about
 * the shape of the payload.
 */
import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { PERMISSIONS } from '../auth/permissions';
import * as controller from './teams.controller';
import {
  addTeamMemberSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  updateTeamMemberSchema,
  updateTeamSchema,
} from './teams.validation';

export const teamsRouter = Router();

teamsRouter.get(
  '/',
  requirePermission(PERMISSIONS.TEAMS_READ),
  validate({ query: listTeamsQuerySchema }),
  controller.listTeams,
);

teamsRouter.post(
  '/',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ body: createTeamSchema }),
  controller.createTeam,
);

teamsRouter.get(
  '/:id',
  requirePermission(PERMISSIONS.TEAMS_READ),
  validate({ params: teamIdParamsSchema }),
  controller.getTeam,
);

teamsRouter.patch(
  '/:id',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ params: teamIdParamsSchema, body: updateTeamSchema }),
  controller.updateTeam,
);

teamsRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ params: teamIdParamsSchema }),
  controller.deleteTeam,
);

teamsRouter.post(
  '/:id/members',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ params: teamIdParamsSchema, body: addTeamMemberSchema }),
  controller.addTeamMember,
);

teamsRouter.patch(
  '/:id/members/:memberId',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ params: teamMemberParamsSchema, body: updateTeamMemberSchema }),
  controller.updateTeamMember,
);

teamsRouter.delete(
  '/:id/members/:memberId',
  requirePermission(PERMISSIONS.TEAMS_MANAGE),
  validate({ params: teamMemberParamsSchema }),
  controller.removeTeamMember,
);
