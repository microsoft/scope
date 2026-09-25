// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { planResubmitResources } from "./index.js";
import type { ResourceBinding } from "shared";

const pinned: ResourceBinding[] = [
  { ref: "simulator@r1", revisionId: "rev-1", params: { REPO: "run/repo" } },
];

describe("planResubmitResources", () => {
  it("preserves the original bindings on an ordinary resubmit", () => {
    // Regression: keyed off the resolved profile version, an ordinary resubmit of
    // a profile-pinned run re-resolved the profile's specs — turning
    // simulator@r1 with REPO=run/repo into simulator@r2 with the default.
    expect(planResubmitResources(undefined, pinned, [{ ref: "simulator" }])).toEqual({
      kind: "preserve",
      bindings: pinned,
    });
  });

  it("preserves the original bindings when the profile is detached", () => {
    expect(planResubmitResources(null, pinned, undefined)).toEqual({
      kind: "preserve",
      bindings: pinned,
    });
  });

  it("keeps resources the profile does not declare on an ordinary resubmit", () => {
    // The original supplied resources the profile knows nothing about; they must
    // not be silently dropped.
    expect(planResubmitResources(undefined, pinned, undefined)).toEqual({
      kind: "preserve",
      bindings: pinned,
    });
  });

  it("resolves the new profile's specs when a replacement profile is selected", () => {
    expect(planResubmitResources("profile-2", pinned, [{ ref: "simulator@r2" }])).toEqual({
      kind: "resolve",
      specs: [{ ref: "simulator@r2" }],
    });
  });

  it("drops resources when a replacement profile declares none", () => {
    // A selected profile controls the field, so declaring no resources means the
    // rerun has none — consistent with how it controls mcpServers and skills.
    expect(planResubmitResources("profile-2", pinned, undefined)).toEqual({
      kind: "preserve",
      bindings: null,
    });
  });

  it("returns null rather than an empty array when nothing was pinned", () => {
    expect(planResubmitResources(undefined, undefined, undefined)).toEqual({
      kind: "preserve",
      bindings: null,
    });
    expect(planResubmitResources(undefined, [], undefined)).toEqual({
      kind: "preserve",
      bindings: null,
    });
  });
});
