// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import { AccountInputSchema, AccountResponseSchema } from "@scope/core";

extendZodWithOpenApi(z);

// POST /api/v1/accounts
registry.registerPath({
  method: "post",
  path: "/api/v1/accounts",
  tags: ["Accounts"],
  summary: "Create account",
  request: {
    body: {
      content: {
        "application/json": { schema: AccountInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Account created",
      content: {
        "application/json": { schema: AccountResponseSchema },
      },
    },
  },
});

// GET /api/v1/accounts
registry.registerPath({
  method: "get",
  path: "/api/v1/accounts",
  tags: ["Accounts"],
  summary: "List accounts",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(AccountResponseSchema) },
      },
    },
  },
});

// GET /api/v1/accounts/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/accounts/{id}",
  tags: ["Accounts"],
  summary: "Get account",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: AccountResponseSchema },
      },
    },
  },
});

// PUT /api/v1/accounts/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/accounts/{id}",
  tags: ["Accounts"],
  summary: "Update account",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: AccountInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Account updated",
      content: {
        "application/json": { schema: AccountResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/accounts/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/accounts/{id}",
  tags: ["Accounts"],
  summary: "Delete account",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Account deleted",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
  },
});
