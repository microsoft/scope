// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** True when an IPv4 address belongs to the local host and is safe for control traffic. */
export function isLocalControlAddress(address: string, interfaces: Interfaces = networkInterfaces()): boolean {
  if (address === "127.0.0.1") return true;
  return isIP(address) === 4 &&
    address !== "0.0.0.0" &&
    Object.values(interfaces).some(entries =>
      entries?.some(entry => entry.family === "IPv4" && entry.address === address));
}

/**
 * Select the host/containers addresses for the local control API.
 *
 * macOS containers can use Docker's host.docker.internal shim. Linux must bind
 * to the bridge gateway, but only after verifying Docker reported an address on
 * a local interface; binding 0.0.0.0 would expose unauthenticated setup control.
 */
export function controlAddress(
  platform: NodeJS.Platform,
  bridgeGateway?: string,
  interfaces: Interfaces = networkInterfaces(),
): { listenHost: string; containerHost: string } {
  if (platform === "darwin") {
    return {
      listenHost: "127.0.0.1",
      containerHost: "host.docker.internal",
    };
  }
  if (platform === "linux") {
    if (!bridgeGateway || bridgeGateway.startsWith("127.") || !isLocalControlAddress(bridgeGateway, interfaces)) {
      throw new Error(
        `Docker bridge gateway ${bridgeGateway ?? "(missing)"} is not a local IPv4 interface. ` +
        "This engine cannot provide bridge-bound Scope control; no wildcard listener will be used.",
      );
    }
    return { listenHost: bridgeGateway, containerHost: bridgeGateway };
  }
  throw new Error(`Local Scope control is not supported on ${platform}`);
}
