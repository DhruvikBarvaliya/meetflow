/**
 * Reports HTTP layer.
 *
 * The JSON route is an ordinary thin controller. The CSV route is not, and the
 * difference is worth stating: it writes its own response body, so it owns two
 * things a normal handler never has to think about.
 *
 *  - **Nothing can be corrected after the first byte.** Once a status line and
 *    headers are on the wire, an error cannot become a 500 with a JSON envelope;
 *    errorHandler correctly refuses to try. Everything that may fail — validating
 *    the window, counting the matches, writing the audit record — therefore
 *    happens *before* any output is produced.
 *  - **Backpressure is real.** A 50,000-row export outruns a slow client, and a
 *    handler that ignores `write()` returning false buffers the whole file in
 *    the process. Each batch waits for the socket to drain.
 */
import type { Request, Response } from 'express';
import { createLogger } from '../../config/logger';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendPage } from '../../utils/http';
import { AuditActions, recordAudit } from '../audit/audit.service';
import { CSV_BOM, csvLine, safeFilename } from './csv';
import * as service from './reports.service';
import { appointmentExportQuerySchema, appointmentReportQuerySchema } from './reports.validation';

const log = createLogger('reports');

export const appointments = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const filters = query(req, appointmentReportQuerySchema);

  const { rows, totalItems } = await service.appointmentReport(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  );

  sendPage(
    res,
    rows,
    { page: filters.page, pageSize: filters.pageSize, totalItems },
    // The zone the `startsAtLocal` column was rendered in; without it the
    // client cannot label the column honestly.
    { timezone: tenant.businessTimezone },
  );
});

/**
 * Awaits the socket when it is full.
 *
 * Resolving on `close` as well as `drain` matters: a client that walks away
 * mid-download never drains, and waiting for an event that will not arrive would
 * hold the request — and its database connection — open indefinitely.
 */
function writeChunk(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

export const exportAppointments = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw new UnauthenticatedError();
  const tenant = tenantOf(req);
  const filters = query(req, appointmentExportQuerySchema);

  // Runs before any output: it validates the window (a 422 is still possible
  // here) and tells the caller, in a header, whether the cap truncated the file.
  const totalItems = await service.countAppointmentReport(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  );
  const truncated = totalItems > service.CSV_MAX_ROWS;

  // Deliberately written before the first byte rather than after the last.
  // A bulk export of customer data is the event the audit log exists to record,
  // and once the response has started an audit failure could no longer be
  // reported to the caller — so the record is made while the request can still
  // fail cleanly.
  await recordAudit({
    businessId: tenant.businessId,
    actorType: 'USER',
    actorUserId: req.auth.userId,
    actorLabel: req.auth.email,
    action: AuditActions.REPORT_EXPORTED,
    entityType: 'report',
    entityId: null,
    requestId: requestIdOf(req),
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    metadata: {
      report: 'appointments',
      format: 'csv',
      // Spelled out rather than spreading the parsed query, so a filter added
      // later cannot silently start (or stop) being recorded.
      filters: {
        from: filters.from ?? null,
        to: filters.to ?? null,
        status: filters.status ?? null,
        serviceId: filters.serviceId ?? null,
        staffProfileId: filters.staffProfileId ?? null,
        locationId: filters.locationId ?? null,
      },
      matchedRows: totalItems,
      rowLimit: service.CSV_MAX_ROWS,
      truncated,
    },
  });

  const bounded = filters.from !== undefined || filters.to !== undefined;
  const period = bounded ? `${filters.from ?? 'start'}-to-${filters.to ?? 'end'}` : 'all';
  const filename = safeFilename(`appointments-${tenant.businessSlug}-${period}.csv`);

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The file contains customer contact details; no shared cache may keep it.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Report-Row-Limit', String(service.CSV_MAX_ROWS));
  res.setHeader('X-Report-Matched-Rows', String(totalItems));
  res.setHeader('X-Report-Truncated', String(truncated));

  // The BOM precedes the header row so Excel reads the whole file as UTF-8.
  await writeChunk(res, CSV_BOM + csvLine(service.CSV_COLUMNS.map((column) => column.header)));

  let written = 0;
  for await (const batch of service.streamAppointmentReport(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  )) {
    // The client hung up: stop querying rather than finish a file nobody wants.
    if (res.destroyed) break;

    let chunk = '';
    for (const row of batch) {
      chunk += csvLine(service.CSV_COLUMNS.map((column) => column.value(row)));
    }
    await writeChunk(res, chunk);
    written += batch.length;
  }

  res.end();
  log.info(
    { businessId: tenant.businessId, rows: written, truncated },
    'appointment report exported',
  );
});
