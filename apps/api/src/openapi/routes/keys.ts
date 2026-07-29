// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "../registry.js";
import { KeyInputSchema, KeyResponseSchema, ValidateKeyInputSchema } from "@scope/core";

extendZodWithOpenApi(z);

// POST /api/v1/keys/preview
registry.registerPath({
  method: "post",
  path: "/api/v1/keys/preview",
  tags: ["Keys"],
  summary: "Preview key",
  request: {
    body: {
      content: {
        "application/json": { schema: KeyInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Key preview",
      content: {
        "application/json": { schema: KeyResponseSchema },
      },
    },
  },
});

// POST /api/v1/keys
registry.registerPath({
  method: "post",
  path: "/api/v1/keys",
  tags: ["Keys"],
  summary: "Create key",
  request: {
    body: {
      content: {
        "application/json": { schema: KeyInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Key created",
      content: {
        "application/json": { schema: KeyResponseSchema },
      },
    },
  },
});

// GET /api/v1/keys
registry.registerPath({
  method: "get",
  path: "/api/v1/keys",
  tags: ["Keys"],
  summary: "List keys",
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: z.array(KeyResponseSchema) },
      },
    },
  },
});

// GET /api/v1/keys/:id
registry.registerPath({
  method: "get",
  path: "/api/v1/keys/{id}",
  tags: ["Keys"],
  summary: "Get key",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": { schema: KeyResponseSchema },
      },
    },
  },
});

// PUT /api/v1/keys/:id
registry.registerPath({
  method: "put",
  path: "/api/v1/keys/{id}",
  tags: ["Keys"],
  summary: "Update key",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: KeyInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Key updated",
      content: {
        "application/json": { schema: KeyResponseSchema },
      },
    },
  },
});

// DELETE /api/v1/keys/:id
registry.registerPath({
  method: "delete",
  path: "/api/v1/keys/{id}",
  tags: ["Keys"],
  summary: "Delete key",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Key deleted",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean() }),
        },
      },
    },
  },
});

// POST /api/v1/keys/:id/validate
registry.registerPath({
  method: "post",
  path: "/api/v1/keys/{id}/validate",
  tags: ["Keys"],
  summary: "Validate key",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: ValidateKeyInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Validation result",
      content: {
        "application/json": {
          schema: z.object({}).passthrough().describe("Key validation result"),
        },
      },
    },
  },
});
