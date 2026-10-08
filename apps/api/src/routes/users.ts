// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { AuthError } from "shared";
import type { AuthenticatedUser } from "../auth/types.js";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

extendZodWithOpenApi(z);

const UserMeResponseSchema = z
  .object({
    id: z.string(),
    role: z.string().optional(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    idp: z.string().optional(),
    idpTenant: z.string().optional(),
  })
  .openapi("UserMeResponse");

function userMeResponse(user: AuthenticatedUser): z.infer<typeof UserMeResponseSchema> {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
    idp: user.idp,
    idpTenant: user.idpTenant,
  };
}

export function registerUsersRoutes(ctx: RouteContext): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/users/me",
    tags: ["Users"],
    summary: "Get the authenticated user's identity",
    security: [{ bearerAuth: [] }],
    description: "Read the existing authenticated Scope identity without enrollment or profile writes. Responses must not be HTTP-cached.",
    response: UserMeResponseSchema,
    errorResponses: {
      401: { description: "Not authenticated" },
      403: { description: "User is not enrolled or is disabled" },
      503: { description: "Authentication service unavailable" },
    },
    handler: async (req, res) => {
      if (!req.auth) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const resolver = ctx.userAccessResolver;
      if (!resolver) {
        throw new AuthError("service_unavailable", "Authentication service unavailable");
      }
      const user = await resolver.resolveExisting(req.auth.identity);
      req.user = user;
      res.json(userMeResponse(user));
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/users/me",
    tags: ["Users"],
    summary: "Enroll the authenticated user",
    security: [{ bearerAuth: [] }],
    description: "JIT-enroll the authenticated user, refresh their profile and lastLoginAt, apply bootstrap-admin rules, and warm the access cache. Use this only after an explicit IdP login; do not prefetch, poll, or automatically retry transient failures.",
    response: UserMeResponseSchema,
    successStatus: 200,
    errorResponses: {
      401: { description: "Not authenticated" },
      403: { description: "User is disabled" },
      503: { description: "Authentication service unavailable" },
    },
    handler: async (req, res) => {
      if (!req.auth) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const resolver = ctx.userAccessResolver;
      if (!resolver) {
        throw new AuthError("service_unavailable", "Authentication service unavailable");
      }
      const user = await resolver.enrollOnLogin(req.auth.identity, req.auth.token);
      req.user = user;
      res.json(userMeResponse(user));
    },
  });
}
