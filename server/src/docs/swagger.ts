/**
 * The browsable API contract.
 *
 *   GET <mount>/              Swagger UI
 *   GET <mount>/openapi.json  the raw document
 *
 * The document is built once, at first use, and then served from memory: it is a
 * pure function of the zod schemas, which cannot change while the process runs,
 * so rebuilding it per request would only burn CPU. Building lazily rather than
 * at import keeps a fault in the generator out of application boot — the API
 * still serves traffic if only its documentation is broken.
 *
 * `Cache-Control: no-store` on the JSON is deliberate. A deploy changes the
 * contract without changing its URL, and a client holding a cached copy of the
 * previous revision is worse than one that fetches it again.
 */
import { Router, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument, type OpenApiDocument } from './openapi';

let cached: OpenApiDocument | null = null;

/** The generated document, built on first use. */
export function openApiDocument(): OpenApiDocument {
  if (!cached) {
    cached = buildOpenApiDocument();
  }
  return cached;
}

export const docsRouter = Router();

docsRouter.get('/openapi.json', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(openApiDocument());
});

docsRouter.use(
  '/',
  swaggerUi.serve,
  // Resolved per request rather than captured at mount time, so the router can
  // be created before the document is ever built.
  (req: Request, res: Response, next: (error?: unknown) => void) => {
    swaggerUi.setup(openApiDocument(), {
      customSiteTitle: 'MeetFlow API',
      swaggerOptions: {
        // Deep-link so a shared URL lands on the operation it names.
        deepLinking: true,
        // Operations stay collapsed: the surface is large enough that an
        // expanded page is unreadable.
        docExpansion: 'none',
        // The filter box is the fastest way through ~120 operations.
        filter: true,
        persistAuthorization: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: 1,
        tryItOutEnabled: true,
      },
    })(req, res, next);
  },
);
