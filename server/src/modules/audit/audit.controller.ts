/**
 * Audit-read HTTP layer.
 *
 * Controllers stay thin: read validated input, resolve the tenant from the
 * request context, call the query layer, send the envelope. Every rule about
 * which rows a caller may see lives in audit.query.ts, where the workspace is
 * bound into the SQL rather than checked afterwards.
 *
 * The CSV route is the one handler here that is not thin, for the reasons
 * reports.controller.ts sets out: it writes its own response body, so nothing
 * can be corrected after the first byte and everything that may fail happens
 * before any output is produced. It also writes an audit entry of its own —
 * somebody taking a copy of the trail out of the product is exactly the event
 * the trail exists to record, and that recursion is the point rather than an
 * oddity.
 */
import type { Request, Response } from 'express';
import { createLogger } from '../../config/logger';
import { requestIdOf } from '../../middleware/requestContext';
import { tenantOf } from '../../middleware/tenant';
import { params, query } from '../../middleware/validate';
import { UnauthenticatedError } from '../../utils/errors';
import { asyncHandler, sendPage, sendSuccess } from '../../utils/http';
import { CSV_BOM, csvLine, safeFilename } from '../analytics/csv';
import * as auditQuery from './audit.query';
import { AuditActions, recordAudit } from './audit.service';
import {
  auditEntryIdParamsSchema,
  exportAuditEntriesQuerySchema,
  listAuditEntriesQuerySchema,
} from './audit.validation';

const log = createLogger('audit-read');

export const listAuditEntries = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const filters = query(req, listAuditEntriesQuerySchema);

  const result = await auditQuery.listAuditEntries(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  );

  sendPage(
    res,
    result.rows,
    { page: result.page, pageSize: result.pageSize, totalItems: result.totalItems },
    // The zone the `from`/`to` filters were cut in. Without it a client cannot
    // label the date pickers honestly, since the boundaries are the workspace's
    // days rather than the reader's.
    { timezone: tenant.businessTimezone },
  );
});

export const getAuditEntry = asyncHandler(async (req: Request, res: Response) => {
  const tenant = tenantOf(req);
  const { id } = params(req, auditEntryIdParamsSchema);
  sendSuccess(res, await auditQuery.getAuditEntry(tenant.businessId, id));
});

/**
 * Awaits the socket when it is full.
 *
 * Resolving on `close` as well as `drain` matters: a client that walks away
 * mid-download never drains, and waiting for an event that will not arrive would
 * hold the request — and its database connection — open indefinitely.
 *
 * A near-twin of the helper in reports.controller.ts. The duplication is
 * deliberate for now: sharing it means a module that owns CSV streaming, and
 * two call sites is not yet enough to justify inventing one.
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

export const exportAuditEntries = asyncHandler(async (req: Request, res: Response) => {
  if (!req.auth) throw new UnauthenticatedError();
  const tenant = tenantOf(req);
  const filters = query(req, exportAuditEntriesQuerySchema);

  // Runs before any output, so a failure here is still a clean JSON error, and
  // so the caller can be told in a header whether the cap truncated the file.
  const totalItems = await auditQuery.countAuditEntries(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  );
  const truncated = totalItems > auditQuery.CSV_MAX_ROWS;

  // Written before the first byte rather than after the last, for the same
  // reason as the appointment export: once the response has started, an audit
  // failure could no longer be reported to the caller, so the record is made
  // while the request can still fail cleanly.
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
      report: 'audit-logs',
      format: 'csv',
      // Spelled out rather than spreading the parsed query, so a filter added
      // later cannot silently start (or stop) being recorded.
      filters: {
        action: filters.action ?? null,
        entityType: filters.entityType ?? null,
        entityId: filters.entityId ?? null,
        actorUserId: filters.actorUserId ?? null,
        from: filters.from ?? null,
        to: filters.to ?? null,
        search: filters.search ?? null,
      },
      matchedRows: totalItems,
      rowLimit: auditQuery.CSV_MAX_ROWS,
      truncated,
    },
  });

  const bounded = filters.from !== undefined || filters.to !== undefined;
  const period = bounded ? `${filters.from ?? 'start'}-to-${filters.to ?? 'end'}` : 'all';
  const filename = safeFilename(`audit-log-${tenant.businessSlug}-${period}.csv`);

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The file names people, addresses and what they did; no shared cache may
  // keep a copy of it.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Report-Row-Limit', String(auditQuery.CSV_MAX_ROWS));
  res.setHeader('X-Report-Matched-Rows', String(totalItems));
  res.setHeader('X-Report-Truncated', String(truncated));

  // The BOM precedes the header row so Excel reads the whole file as UTF-8.
  await writeChunk(res, CSV_BOM + csvLine(auditQuery.CSV_COLUMNS.map((column) => column.header)));

  let written = 0;
  for await (const batch of auditQuery.streamAuditEntries(
    tenant.businessId,
    tenant.businessTimezone,
    filters,
  )) {
    // The client hung up: stop querying rather than finish a file nobody wants.
    if (res.destroyed) break;

    let chunk = '';
    for (const row of batch) {
      chunk += csvLine(auditQuery.CSV_COLUMNS.map((column) => column.value(row)));
    }
    await writeChunk(res, chunk);
    written += batch.length;
  }

  res.end();
  log.info({ businessId: tenant.businessId, rows: written, truncated }, 'audit trail exported');
});
