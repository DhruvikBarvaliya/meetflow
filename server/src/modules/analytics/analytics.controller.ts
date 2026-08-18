/**
 * Analytics HTTP layer.
 *
 * Controllers stay thin: read the validated window, take the tenant and its
 * timezone from the proven membership, call the service. Every aggregate lives
 * in analytics.service.ts.
 *
 * The window is echoed back in `meta` rather than folded into `data`, so each
 * panel's payload is nothing but the figures it was asked for while a client
 * can still tell which period — and, importantly, which *clock* — produced them.
 */
import type { Request, Response } from 'express';
import { tenantOf } from '../../middleware/tenant';
import { query } from '../../middleware/validate';
import { asyncHandler, sendSuccess } from '../../utils/http';
import * as service from './analytics.service';
import { type AnalyticsRangeQuery, analyticsRangeQuerySchema } from './analytics.validation';

interface AnalyticsRequest {
  businessId: string;
  timezone: string;
  filters: AnalyticsRangeQuery;
}

function analyticsRequestOf(req: Request): AnalyticsRequest {
  const tenant = tenantOf(req);
  return {
    businessId: tenant.businessId,
    timezone: tenant.businessTimezone,
    filters: query(req, analyticsRangeQuerySchema),
  };
}

function rangeMeta(context: AnalyticsRequest): Record<string, unknown> {
  return {
    range: {
      from: context.filters.from,
      to: context.filters.to,
      timezone: context.timezone,
    },
  };
}

export const overview = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.overview(context.businessId, context.timezone, context.filters);
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const trends = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.trends(context.businessId, context.timezone, context.filters);
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const staff = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.staffPerformance(
    context.businessId,
    context.timezone,
    context.filters,
  );
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const services = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.servicePerformance(
    context.businessId,
    context.timezone,
    context.filters,
  );
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const locations = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.locationPerformance(
    context.businessId,
    context.timezone,
    context.filters,
  );
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const peakTimes = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.peakTimes(context.businessId, context.timezone, context.filters);
  sendSuccess(res, data, 200, rangeMeta(context));
});

export const customers = asyncHandler(async (req: Request, res: Response) => {
  const context = analyticsRequestOf(req);
  const data = await service.customerAnalytics(
    context.businessId,
    context.timezone,
    context.filters,
  );
  sendSuccess(res, data, 200, rangeMeta(context));
});
