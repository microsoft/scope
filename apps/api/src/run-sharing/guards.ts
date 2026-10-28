// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RequestHandler } from "express";

export function isRunSharingEnabled(): boolean {
  return process.env.SCOPE_RUN_SHARING_ENABLED?.toLowerCase() === "true";
}

export const shareResponseHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  next();
};

export function shareRateLimit(limit = 600, now: () => number = Date.now): RequestHandler {
  const buckets = new Map<string, { count: number; until: number }>();
  let sweepAt = 0;
  return (req, res, next) => {
    const time = now();
    if (time >= sweepAt) {
      for (const [key, bucket] of buckets) {
        if (bucket.until <= time) buckets.delete(key);
      }
      sweepAt = time + 60_000;
    }
    // Use the trusted connection address, never a caller-provided forwarded IP.
    const key = req.user?.isAuthenticated ? `user:${req.user.id}`
      : req.ip ?? req.socket.remoteAddress ?? "unknown";
    let bucket = buckets.get(key);
    if (bucket && bucket.until <= time) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket && buckets.size < 10_000) {
      bucket = { count: 0, until: time + 60_000 };
      buckets.set(key, bucket);
    }
    if (!bucket || ++bucket.count > limit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil(((bucket?.until ?? time + 60_000) - time) / 1000)));
      res.status(429).json({ error: "Too many shared-run requests; try again later" });
      return;
    }
    next();
  };
}
