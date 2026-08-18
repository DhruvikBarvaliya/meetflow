/**
 * Writes the generated OpenAPI document to `docs/openapi.json`.
 *
 * The file is a build artefact, not a source of truth: it is regenerated from
 * the zod schemas every time, so a schema change that is not reflected here
 * shows up as a diff rather than as a contract that quietly went stale. Run it
 * from CI on every pull request and fail the build when the working tree is
 * dirty afterwards — that turns "someone forgot to update the docs" into a
 * broken build instead of a support ticket.
 *
 *   npm --workspace server run openapi:export
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from '../docs/openapi';

/** `<repo>/docs/openapi.json`, from either `src/scripts` or `dist/scripts`. */
const OUTPUT_PATH = path.resolve(__dirname, '../../../docs/openapi.json');

function main(): void {
  const document = buildOpenApiDocument();

  const operations = Object.values(document.paths ?? {}).reduce<number>(
    (total, item) =>
      total +
      Object.keys(item ?? {}).filter((key) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(key),
      ).length,
    0,
  );

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  // Trailing newline: without one, every diff of this file reports the last
  // line as changed whenever anything near it moves.
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `OpenAPI ${document.openapi} written to ${OUTPUT_PATH}\n` +
      `  paths      ${Object.keys(document.paths ?? {}).length}\n` +
      `  operations ${operations}\n` +
      `  schemas    ${Object.keys(document.components?.schemas ?? {}).length}\n`,
  );
}

try {
  main();
  // Sequelize builds a connection pool when the model modules are imported —
  // reached here only because the validation schemas source their enums from
  // the models. Nothing connects, but the explicit exit keeps the script from
  // depending on that staying true.
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `Failed to export the OpenAPI document: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(1);
}
