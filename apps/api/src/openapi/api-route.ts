// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z, type ZodType, type ZodObject } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import type { OpenAPIRegistry, RouteConfig } from "@asteasolutions/zod-to-openapi";
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";

extendZodWithOpenApi(z);

// ─── Types ───────────────────────────────────────────────────────────────────

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** Infer the output type from a Zod schema, or fall back to a default. */
type InferOrDefault<T, D> = T extends ZodType<infer O> ? O : D;

/**
 * Configuration for a single API route.
 *
 * Generic params:
 *   TBody   — request body schema
 *   TQuery  — query string schema
 *   TParams — path parameters schema
 */
export interface ApiRouteConfig<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
> {
  method: HttpMethod;
  path: string; // Express-style, e.g. "/api/v1/criteria/:id"
  tags: string[];
  summary: string;
  description?: string;

  /** OpenAPI-only security requirements; enforcement remains in auth middleware/handlers. */
  security?: RouteConfig["security"];

  // Schemas (all optional)
  body?: TBody;
  query?: TQuery;
  params?: TParams;
  response: ZodType; // response schema for OpenAPI docs (200/201)
  responseDescription?: string;

  /** HTTP status code for the success response (default: 200, POST→201). */
  successStatus?: number;

  /**
   * Additional error/non-success responses to document in the OpenAPI spec.
   * Keys are HTTP status codes; values describe the response.
   *
   * @example
   * errorResponses: {
   *   404: { description: "Not found" },
   *   503: { description: "LLM unavailable", schema: z.object({ error: z.string() }) },
   * }
   */
  errorResponses?: Record<number, { description: string; schema?: ZodType }>;

  /**
   * When true, the handler manages the response directly (SSE, binary, etc.).
   * Body/query/params are still validated, but response is not documented as JSON.
   */
  rawResponse?: boolean;

  /** Express middleware to run before the validation handler (e.g. multer). */
  middleware?: RequestHandler[];

  /** The route handler. */
  handler: (
    req: TypedRequest<
      InferOrDefault<TBody, unknown>,
      InferOrDefault<TQuery, Record<string, string>>,
      InferOrDefault<TParams, Record<string, string>>
    >,
    res: Response,
    next: NextFunction,
  ) => void | Promise<void>;
}

/**
 * Express Request with typed body, query, and params.
 */
export interface TypedRequest<TBody, TQuery, TParams> extends Request {
  body: TBody;
  query: TQuery & Request["query"];
  params: TParams & Request["params"];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert Express-style path params to OpenAPI-style.
 * "/api/v1/criteria/:id" → "/api/v1/criteria/{id}"
 */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, "{$1}");
}

/**
 * Build a ZodError into a structured 400 response body.
 */
function formatZodError(error: z.ZodError): object {
  return {
    error: "Validation failed",
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Register an API route with both Express and the OpenAPI registry in a single
 * declaration.
 *
 * - Registers the route in the OpenAPI spec via `registry.registerPath()`
 * - Mounts the Express handler with validation middleware
 * - Validates body, query, and params using the provided Zod schemas
 */
export function apiRoute<
  TBody extends ZodType | undefined = undefined,
  TQuery extends ZodType | undefined = undefined,
  TParams extends ZodType | undefined = undefined,
>(
  app: Express,
  registry: OpenAPIRegistry,
  config: ApiRouteConfig<TBody, TQuery, TParams>,
): void {
  const {
    method,
    path,
    tags,
    summary,
    description,
    security,
    body,
    query,
    params,
    response,
    responseDescription,
    successStatus,
    errorResponses,
    rawResponse,
    middleware,
    handler,
  } = config;

  const openApiPath = toOpenApiPath(path);
  const status = successStatus ?? (method === "post" ? 201 : 200);

  // ── OpenAPI registration ────────────────────────────────────────────────

  const request: Record<string, unknown> = {};
  if (params) {
    request.params = params;
  }
  if (query) {
    request.query = query;
  }
  if (body) {
    request.body = {
      content: { "application/json": { schema: body } },
    };
  }

  const responses: Record<string, unknown> = {};
  if (rawResponse) {
    responses[String(status)] = {
      description: responseDescription ?? "Success",
    };
  } else {
    responses[String(status)] = {
      description: responseDescription ?? "Success",
      content: { "application/json": { schema: response } },
    };
  }

  if (errorResponses) {
    for (const [code, { description: desc, schema }] of Object.entries(errorResponses)) {
      responses[code] = schema
        ? { description: desc, content: { "application/json": { schema } } }
        : { description: desc };
    }
  }

  registry.registerPath({
    method,
    path: openApiPath,
    tags,
    summary,
    ...(description ? { description } : {}),
    ...(security !== undefined ? { security } : {}),
    ...(Object.keys(request).length > 0 ? { request } : {}),
    responses,
  } as Parameters<typeof registry.registerPath>[0]);

  // ── Express handler with validation middleware ──────────────────────────

  const validationHandler: RequestHandler = async (req, res, next) => {
    try {
      // Validate path params
      if (params) {
        const result = (params as ZodType).safeParse(req.params);
        if (!result.success) {
          res.status(400).json(formatZodError(result.error));
          return;
        }
        req.params = result.data as typeof req.params;
      }

      // Validate query string
      if (query) {
        const result = (query as ZodType).safeParse(req.query);
        if (!result.success) {
          res.status(400).json(formatZodError(result.error));
          return;
        }
        // Merge validated data back (preserves Express query type)
        Object.assign(req.query, result.data);
      }

      // Validate request body
      if (body) {
        const result = (body as ZodType).safeParse(req.body);
        if (!result.success) {
          res.status(400).json(formatZodError(result.error));
          return;
        }
        req.body = result.data;
      }

      await handler(req as any, res, next);
    } catch (error) {
      next(error);
    }
  };

  if (middleware && middleware.length > 0) {
    app[method](path, ...middleware, validationHandler);
  } else {
    app[method](path, validationHandler);
  }
}
