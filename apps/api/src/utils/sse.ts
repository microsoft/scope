// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRequire } from "module";
import type { Response } from "express";
import type { LogEvent } from "../route-context.js";

const require = createRequire(import.meta.url);
const Redis = require("ioredis");

// SSE client management for connection pooling
export type SSEClient = {
  res: Response;
  cleanup: () => void;
  onActivity?: () => void;
  accepts?: (event: LogEvent) => boolean;
};

const sseClients: Map<string, Set<SSEClient>> = new Map();
let sharedSubscriber: InstanceType<typeof Redis> | null = null;
const subscribedChannels: Set<string> = new Set();

// Redis configuration from environment
const redisHost = process.env.REDIS_HOST || "";
const redisPort = parseInt(process.env.REDIS_PORT || "6300", 10);
const redisPassword = process.env.REDIS_PASSWORD || "";

// Determine if we should use TLS (Azure Redis uses port 6380 with TLS)
const useRedisTls = redisPassword && redisPort !== 6379;

// Track if Redis error has been logged to avoid spam
let redisErrorLogged = false;

function getOrCreateSubscriber(): InstanceType<typeof Redis> {
  if (!sharedSubscriber && redisHost) {
    sharedSubscriber = new Redis({
      host: redisHost,
      port: redisPort,
      password: redisPassword || undefined,
      ...(useRedisTls ? { tls: { servername: redisHost } } : {}),
      // Limit reconnection attempts to avoid log spam
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          return null; // Stop retrying after 3 attempts
        }
        return Math.min(times * 1000, 3000);
      },
    });

    sharedSubscriber.on("message", (channel: string, message: string) => {
      const requestId = channel.replace("logs:", "");
      const clients = sseClients.get(requestId);
      let logEvent: LogEvent | undefined;
      try {
        logEvent = JSON.parse(message) as LogEvent;
      } catch {
        // Preserve legacy forwarding for clients that do not filter events.
      }
      if (clients) {
        for (const client of clients) {
          if (client.accepts && (!logEvent || !client.accepts(logEvent))) {
            continue;
          }
          client.res.write(`data: ${message}\n\n`);
          client.onActivity?.();

          // Check for completion
          if (logEvent?.data?.final === true) {
            client.res.write(`event: done\ndata: {"status":"done"}\n\n`);
            client.cleanup();
          }
        }
      }
    });

    sharedSubscriber.on("error", (err: Error) => {
      // Only log once to avoid spam
      if (!redisErrorLogged) {
        console.error("Shared Redis subscriber error:", err.message);
        redisErrorLogged = true;
      }
    });

    sharedSubscriber.on("connect", () => {
      redisErrorLogged = false; // Reset on successful connect
      console.log("Redis subscriber connected");
    });

    console.log(`Initialized shared Redis subscriber (TLS: ${useRedisTls})`);
  }
  return sharedSubscriber!;
}

export async function subscribeClient(requestId: string, client: SSEClient): Promise<void> {
  const channelName = `logs:${requestId}`;

  // Add client to the set
  if (!sseClients.has(requestId)) {
    sseClients.set(requestId, new Set());
  }
  sseClients.get(requestId)!.add(client);

  // Subscribe to channel if not already subscribed
  if (!subscribedChannels.has(channelName)) {
    const subscriber = getOrCreateSubscriber();
    await subscriber.subscribe(channelName);
    subscribedChannels.add(channelName);
    console.log(`Subscribed to channel: ${channelName}`);
  }
}

export function unsubscribeClient(requestId: string, client: SSEClient): void {
  const clients = sseClients.get(requestId);
  if (clients) {
    clients.delete(client);

    // If no more clients for this request, unsubscribe from channel
    if (clients.size === 0) {
      sseClients.delete(requestId);
      const channelName = `logs:${requestId}`;
      if (sharedSubscriber && subscribedChannels.has(channelName)) {
        sharedSubscriber.unsubscribe(channelName);
        subscribedChannels.delete(channelName);
        console.log(`Unsubscribed from channel: ${channelName}`);
      }
    }
  }
}
