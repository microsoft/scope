// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { controlAddress, isLocalControlAddress } from "./control-address.js";

const bridge: NetworkInterfaceInfo = {
  address: "172.20.0.1", netmask: "255.255.0.0", family: "IPv4",
  mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/16",
};

describe("trusted local control transport", () => {
  it("uses verified macOS loopback connectivity for Docker-compatible engines", () => {
    expect(controlAddress("darwin")).toEqual({
      listenHost: "127.0.0.1", containerHost: "host.docker.internal",
    });
  });

  it("binds Linux control only to a verified local engine bridge", () => {
    expect(controlAddress("linux", bridge.address, { "br-scope": [bridge] })).toEqual({
      listenHost: bridge.address, containerHost: bridge.address,
    });
    expect(isLocalControlAddress(bridge.address, { "br-scope": [bridge] })).toBe(true);
  });

  it("reports unsupported bridge connectivity without wildcard or remote fallback", () => {
    expect(() => controlAddress("linux", "172.21.0.1", { "br-scope": [bridge] })).toThrow("not a local IPv4 interface");
    expect(() => controlAddress("linux", undefined, {})).toThrow("no wildcard listener");
    expect(isLocalControlAddress("0.0.0.0", {})).toBe(false);
    expect(isLocalControlAddress("203.0.113.10", {})).toBe(false);
  });
});
