// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ErrorRequestHandler } from "express";
import { AuthError } from "shared";
import { UserAccessError } from "./user-access-resolver.js";

/** Keep login and normal-request authentication failures on the same HTTP contract. */
export const authErrorHandler: ErrorRequestHandler = (
  err: unknown, _req, res, next,
) => {
  if (err instanceof AuthError) {
    const unavailable = err.code === "service_unavailable";
    res.status(unavailable ? 503 : 401).json({
      error: unavailable ? "Authentication service unavailable" : "Invalid or expired token",
      code: err.code,
    });
    return;
  }
  if (err instanceof UserAccessError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
};
