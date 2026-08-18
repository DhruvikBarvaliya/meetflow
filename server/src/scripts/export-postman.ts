/**
 * Writes a Postman collection to `docs/postman/MeetFlow.postman_collection.json`.
 *
 * The collection is generated *from the OpenAPI document*, not from a second
 * hand-maintained list of endpoints. That is the whole point: the document comes
 * from the zod schemas, so a request that exists in Postman exists in the API,
 * and a field Postman offers is a field the server will accept. Nothing here
 * knows what an endpoint is — it only knows how to translate one.
 *
 * The generated file is deterministic: the collection id is derived from its
 * name and every example value is fixed, so re-running the script on an
 * unchanged API produces a byte-identical file and a clean `git status`.
 *
 *   npm --workspace server run postman:export
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildOpenApiDocument } from '../docs/openapi';

/** `<repo>/docs/postman/…`, from either `src/scripts` or `dist/scripts`. */
const OUTPUT_PATH = path.resolve(
  __dirname,
  '../../../docs/postman/MeetFlow.postman_collection.json',
);

// ---------------------------------------------------------------------------
// The slice of OpenAPI this script reads
//
// Declared structurally rather than imported: the generator's own types model
// two spec versions at once, and everything below needs is the handful of keys
// an OpenAPI 3.0 document actually carries.
// ---------------------------------------------------------------------------

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  additionalProperties?: boolean | SchemaObject;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  nullable?: boolean;
}

interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: SchemaObject }>;
  };
  security?: Array<Record<string, string[]>>;
}

interface DocumentShape {
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OperationObject> | undefined>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
  };
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Postman collection format v2.1.0
// ---------------------------------------------------------------------------

interface PostmanVariable {
  key: string;
  value: string;
  type?: string;
  description?: string;
}

interface PostmanQueryParam {
  key: string;
  value: string;
  description?: string;
  disabled?: boolean;
}

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
  query?: PostmanQueryParam[];
  variable?: PostmanVariable[];
}

interface PostmanHeader {
  key: string;
  value: string;
  type?: string;
  description?: string;
  disabled?: boolean;
}

interface PostmanRequest {
  method: string;
  header: PostmanHeader[];
  url: PostmanUrl;
  description?: string;
  body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
  auth?: { type: 'noauth' };
}

interface PostmanEvent {
  listen: 'test' | 'prerequest';
  script: { type: 'text/javascript'; exec: string[] };
}

interface PostmanItem {
  name: string;
  request: PostmanRequest;
  response: unknown[];
  event?: PostmanEvent[];
}

interface PostmanFolder {
  name: string;
  description?: string;
  item: PostmanItem[];
}

interface PostmanCollection {
  info: {
    _postman_id: string;
    name: string;
    description: string;
    schema: string;
  };
  auth: { type: 'bearer'; bearer: Array<{ key: string; value: string; type: string }> };
  variable: PostmanVariable[];
  item: PostmanFolder[];
}

// ---------------------------------------------------------------------------
// Example values
//
// Fixed rather than random, so the committed file only changes when the API
// does. A UUID of all zeroes is obviously a placeholder, which is what a
// starting value in a collection should look like.
// ---------------------------------------------------------------------------

const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_INSTANT = '2025-03-01T09:00:00Z';
const PLACEHOLDER_DATE = '2025-03-01';
const MAX_EXAMPLE_DEPTH = 8;

/**
 * Starting values for fields whose rule is a zod `.refine()` rather than a
 * format.
 *
 * A timezone, an ISO date and an `HH:mm` window are all just `type: "string"` by
 * the time they reach OpenAPI — the predicate that constrains them lives in
 * JavaScript and has no JSON Schema equivalent. Left alone they would render as
 * `""`, which fails validation on the first send. These are keyed on field name
 * and consulted *only* when the schema itself yields nothing, so anything the
 * contract does describe always wins.
 */
const NAMED_PLACEHOLDERS: Record<string, string> = {
  timezone: 'Asia/Kolkata',
  locale: 'en-IN',
  currency: 'INR',
  // Calendar dates. The instant-valued `from`/`to` on the diary routes carry
  // `format: date-time` and so never reach this map.
  date: PLACEHOLDER_DATE,
  from: PLACEHOLDER_DATE,
  to: PLACEHOLDER_DATE,
  fromDate: PLACEHOLDER_DATE,
  toDate: PLACEHOLDER_DATE,
  earliestDate: PLACEHOLDER_DATE,
  latestDate: PLACEHOLDER_DATE,
  effectiveFrom: PLACEHOLDER_DATE,
  effectiveTo: PLACEHOLDER_DATE,
  // Wall-clock windows.
  startTime: '09:00',
  endTime: '17:00',
  // Opaque public handle: `apt_` plus 26 Crockford base32 characters.
  publicId: 'apt_00000000000000000000000000',
  password: 'MeetFlow!Demo123',
  currentPassword: 'MeetFlow!Demo123',
  newPassword: 'MeetFlow!Demo123',
  color: '#4F46E5',
  phone: '+91 98765 43210',
  firstName: 'Ada',
  lastName: 'Lovelace',
  displayName: 'Ada Lovelace',
  name: 'Example',
  title: 'Example',
  slug: 'example',
  key: 'example_key',
  label: 'Example question',
};

function resolveSchemaRef(ref: string, doc: DocumentShape): SchemaObject | undefined {
  const name = /^#\/components\/schemas\/(.+)$/.exec(ref)?.[1];
  return name ? doc.components?.schemas?.[name] : undefined;
}

function resolveParameterRef(ref: string, doc: DocumentShape): ParameterObject | undefined {
  const name = /^#\/components\/parameters\/(.+)$/.exec(ref)?.[1];
  return name ? doc.components?.parameters?.[name] : undefined;
}

function stringExample(schema: SchemaObject, name?: string): string {
  switch (schema.format) {
    case 'uuid':
      return PLACEHOLDER_UUID;
    case 'date-time':
      return PLACEHOLDER_INSTANT;
    case 'date':
      return PLACEHOLDER_DATE;
    case 'email':
      return 'customer@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    default:
      return (name ? NAMED_PLACEHOLDERS[name] : undefined) ?? '';
  }
}

/**
 * A starting value for a schema.
 *
 * Optional properties are included alongside required ones: a collection is a
 * discovery tool, and a body that names every field the endpoint accepts is
 * more useful than a minimal one — deleting a line is easier than finding out
 * that a line was available.
 */
function exampleFor(schema: SchemaObject, doc: DocumentShape, depth = 0, name?: string): unknown {
  if (depth > MAX_EXAMPLE_DEPTH) return null;

  if (schema.$ref) {
    const resolved = resolveSchemaRef(schema.$ref, doc);
    return resolved ? exampleFor(resolved, doc, depth + 1, name) : null;
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0] ?? null;

  if (schema.allOf && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const value = exampleFor(part, doc, depth + 1, name);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(merged, value);
      }
    }
    return merged;
  }
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant) return exampleFor(variant, doc, depth + 1, name);

  switch (schema.type) {
    case 'object': {
      const properties = schema.properties;
      if (!properties) return {};
      const example: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(properties)) {
        example[key] = exampleFor(property, doc, depth + 1, key);
      }
      return example;
    }
    case 'array':
      // One element, so the shape of a row is visible; an empty array would
      // hide it and a longer one would only be noise.
      return schema.items ? [exampleFor(schema.items, doc, depth + 1, name)] : [];
    case 'string':
      return stringExample(schema, name);
    case 'integer':
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** The same value flattened into the single string a query slot or header holds. */
function scalarExample(
  schema: SchemaObject | undefined,
  doc: DocumentShape,
  name?: string,
): string {
  if (!schema) return '';
  const value = exampleFor(schema, doc, 0, name);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** `/api/v1/locations/{id}` -> the segments Postman wants, with `:id` variables. */
function pathSegments(templatePath: string): string[] {
  return templatePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^\{(.+)\}$/, ':$1'));
}

function parametersOf(operation: OperationObject, doc: DocumentShape): ParameterObject[] {
  return (operation.parameters ?? []).map((parameter) =>
    parameter.$ref ? (resolveParameterRef(parameter.$ref, doc) ?? parameter) : parameter,
  );
}

function headerFor(parameter: ParameterObject, doc: DocumentShape): PostmanHeader {
  // X-Business-Id is wired to the variable the "me" request captures. It ships
  // *enabled* even though the contract marks it optional: it is required as soon
  // as an account belongs to more than one workspace, and an empty value is
  // treated by the server as absent — so enabling it is right in both cases,
  // where leaving it off is right in only one.
  if (parameter.name === 'X-Business-Id') {
    return {
      key: parameter.name,
      value: '{{businessId}}',
      type: 'text',
      description: parameter.description,
    };
  }

  return {
    key: parameter.name ?? 'X-Unknown',
    value: scalarExample(parameter.schema, doc, parameter.name),
    type: 'text',
    description: parameter.description,
    // Every other optional header ships disabled, so a request works as sent and
    // the header is one click away when it is wanted.
    disabled: parameter.required !== true,
  };
}

function requestBodyOf(
  operation: OperationObject,
  doc: DocumentShape,
): PostmanRequest['body'] | undefined {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  if (!schema) return undefined;
  return {
    mode: 'raw',
    raw: JSON.stringify(exampleFor(schema, doc), null, 2),
    options: { raw: { language: 'json' } },
  };
}

/** Scripts that promote values out of a response into collection variables. */
function eventsFor(operationId: string | undefined): PostmanEvent[] | undefined {
  const test = (exec: string[]): PostmanEvent[] => [
    { listen: 'test', script: { type: 'text/javascript', exec } },
  ];

  switch (operationId) {
    case 'auth.login':
    case 'auth.register':
    case 'auth.refresh':
      return test([
        '// Captures the session so every other request in this collection is',
        '// authenticated. Run this first.',
        'var ok = pm.response.code >= 200 && pm.response.code < 300;',
        '',
        "pm.test('a session was issued', function () {",
        "  pm.expect(ok, 'expected a 2xx response').to.equal(true);",
        '});',
        '',
        'if (ok) {',
        '  var body = pm.response.json() || {};',
        '  var data = body.data || {};',
        '',
        '  if (data.accessToken) {',
        "    pm.collectionVariables.set('accessToken', data.accessToken);",
        "    console.log('accessToken captured; expires in ' + data.expiresIn + 's');",
        '  }',
        '  if (data.refreshToken) {',
        "    pm.collectionVariables.set('refreshToken', data.refreshToken);",
        '  }',
        '}',
      ]);
    case 'auth.me':
      return test([
        '// Picks a workspace to act in. X-Business-Id is optional when the user',
        '// belongs to exactly one workspace and required when they belong to',
        '// several, so capturing it here makes the rest of the collection work',
        '// either way.',
        'var ok = pm.response.code === 200;',
        '',
        'if (ok) {',
        '  var body = pm.response.json() || {};',
        '  var memberships = (body.data || {}).memberships || [];',
        '',
        '  if (memberships.length > 0) {',
        "    pm.collectionVariables.set('businessId', memberships[0].businessId);",
        "    console.log('businessId set to ' + memberships[0].businessName);",
        '  }',
        '}',
      ]);
    default:
      return undefined;
  }
}

function itemFor(
  templatePath: string,
  method: HttpMethod,
  operation: OperationObject,
  doc: DocumentShape,
): PostmanItem {
  const parameters = parametersOf(operation, doc);
  const segments = pathSegments(templatePath);

  const pathVariables: PostmanVariable[] = parameters
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => ({
      key: parameter.name ?? '',
      value: scalarExample(parameter.schema, doc, parameter.name),
      description: parameter.description,
    }));

  const query: PostmanQueryParam[] = parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => ({
      key: parameter.name ?? '',
      value: scalarExample(parameter.schema, doc, parameter.name),
      description: parameter.description,
      // Optional filters ship disabled so the request runs unmodified and each
      // filter is one checkbox away.
      disabled: parameter.required !== true,
    }));

  const headers: PostmanHeader[] = parameters
    .filter((parameter) => parameter.in === 'header')
    .map((parameter) => headerFor(parameter, doc));

  const body = requestBodyOf(operation, doc);
  if (body) {
    headers.unshift({ key: 'Content-Type', value: 'application/json', type: 'text' });
  }
  headers.unshift({ key: 'Accept', value: 'application/json', type: 'text' });

  const enabledQuery = query.filter((parameter) => parameter.disabled !== true);
  const queryString = enabledQuery
    .map((parameter) => `${parameter.key}=${parameter.value}`)
    .join('&');

  const raw = `{{baseUrl}}/${segments.join('/')}${queryString ? `?${queryString}` : ''}`;

  const url: PostmanUrl = {
    raw,
    host: ['{{baseUrl}}'],
    path: segments,
  };
  if (query.length > 0) url.query = query;
  if (pathVariables.length > 0) url.variable = pathVariables;

  const request: PostmanRequest = {
    method: method.toUpperCase(),
    header: headers,
    url,
    description: operation.description,
  };
  if (body) request.body = body;
  // No security requirement on the operation means the route is genuinely
  // unauthenticated; sending the collection's bearer token anyway would be
  // misleading about what the endpoint needs.
  if (!operation.security || operation.security.length === 0) {
    request.auth = { type: 'noauth' };
  }

  const item: PostmanItem = {
    name: operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${templatePath}`,
    request,
    response: [],
  };

  const events = eventsFor(operation.operationId);
  if (events) item.event = events;

  return item;
}

/** A stable id, so re-exporting an unchanged API does not churn the file. */
function deterministicId(seed: string): string {
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function buildCollection(doc: DocumentShape): PostmanCollection {
  // Tag order comes from the document, so the folders read in the same order as
  // the Swagger page rather than alphabetically.
  const folders = new Map<string, PostmanFolder>();
  for (const tag of doc.tags ?? []) {
    folders.set(tag.name, { name: tag.name, description: tag.description, item: [] });
  }

  for (const [templatePath, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method)) continue;

      const tag = operation.tags?.[0] ?? 'Other';
      let folder = folders.get(tag);
      if (!folder) {
        folder = { name: tag, item: [] };
        folders.set(tag, folder);
      }
      folder.item.push(itemFor(templatePath, method, operation, doc));
    }
  }

  const baseUrl = doc.servers?.[0]?.url ?? 'http://localhost:4000';

  return {
    info: {
      _postman_id: deterministicId(`${doc.info.title}@${doc.info.version}`),
      name: `${doc.info.title} v${doc.info.version}`,
      description: [
        'Generated from the MeetFlow OpenAPI document, which is itself generated from the zod',
        'schemas the server validates with. Do not edit by hand — run',
        '`npm --workspace server run contracts:export` instead.',
        '',
        '## Getting started',
        '',
        '1. Set `baseUrl` if the API is not on http://localhost:4000.',
        '2. Run **Auth › Sign in**. Its test script captures `accessToken` into a collection',
        '   variable, and every authenticated request picks it up from the collection-level',
        '   bearer auth.',
        '3. Run **Auth › Read the authenticated user** once. Its test script captures',
        '   `businessId`, which is sent as the `X-Business-Id` header. That header is optional',
        '   when the account belongs to exactly one workspace and required when it belongs to',
        '   several, so it is enabled on every workspace-scoped request.',
        '',
        'Requests under **Public Booking** are unauthenticated by design and are set to',
        '`noauth` so the bearer token is not sent to them.',
        '',
        '## Reading the examples',
        '',
        'Optional query parameters and optional headers ship disabled: each request runs as',
        'sent, and every filter the endpoint supports is one checkbox away.',
        '',
        'Example bodies name **every** field an endpoint accepts, so nothing is hidden — which',
        'means they also name mutually exclusive ones. A booking link, for instance, lists',
        '`serviceId`, `teamId` and `staffProfileId`, but its `type` decides which single one is',
        'legal and naming the others is a 422. Trim each body to the combination you want.',
        '',
        'Values are placeholders, not fixtures: ids are all-zero UUIDs and free text is a stand-in.',
        'Replace them with ids from your own workspace.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
    },
    variable: [
      {
        key: 'baseUrl',
        value: baseUrl,
        type: 'string',
        description: 'The API origin. Request paths already carry the /api/v1 prefix.',
      },
      {
        key: 'accessToken',
        value: '',
        type: 'string',
        description: 'Captured by the Sign in request. Short-lived; sign in again when it expires.',
      },
      {
        key: 'refreshToken',
        value: '',
        type: 'string',
        description: 'Captured by the Sign in request. Used by Refresh and Sign out.',
      },
      {
        key: 'businessId',
        value: '',
        type: 'string',
        description:
          'Sent as X-Business-Id to choose which workspace a request acts in. Captured by the ' +
          '"Read the authenticated user" request.',
      },
    ],
    // Folders with no operations would only be dead weight in the sidebar.
    item: [...folders.values()].filter((folder) => folder.item.length > 0),
  };
}

function main(): void {
  const doc = buildOpenApiDocument() as unknown as DocumentShape;
  const collection = buildCollection(doc);

  const requestCount = collection.item.reduce((total, folder) => total + folder.item.length, 0);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `Postman collection written to ${OUTPUT_PATH}\n` +
      `  folders  ${collection.item.length}\n` +
      `  requests ${requestCount}\n`,
  );
}

try {
  main();
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `Failed to export the Postman collection: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exit(1);
}
