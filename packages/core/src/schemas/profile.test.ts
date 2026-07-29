// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  CreateProfileInputSchema,
  UpdateProfileIdentitySchema,
  ProfileResponseSchema,
  ProfileVersionResponseSchema,
  ProfileWithVersionResponseSchema,
} from "./profile.js";

describe("CreateProfileInputSchema", () => {
  it("accepts valid input with required fields only", () => {
    const input = {
      name: "My Profile",
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts valid input with all optional fields", () => {
    const input = {
      name: "Full Profile",
      description: "A comprehensive profile",
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
      agentVersion: "copilot-0.0.415",
      mcpServers: ["search", "docs"],
      skillRevisions: ["rev-1", "rev-2"],
      extensions: ["ms-python.python@2024.1.1"],
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const input = {
      name: "",
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 128 characters", () => {
    const input = {
      name: "x".repeat(129),
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects missing model", () => {
    const input = {
      name: "No Model",
      workerType: "coder-acp-copilot",
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects missing workerType", () => {
    const input = {
      name: "No Worker",
      model: "gpt-4o",
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 512 characters", () => {
    const input = {
      name: "Long Desc",
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
      description: "x".repeat(513),
    };
    const result = CreateProfileInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("UpdateProfileIdentitySchema", () => {
  it("accepts partial update with name only", () => {
    const result = UpdateProfileIdentitySchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with description only", () => {
    const result = UpdateProfileIdentitySchema.safeParse({ description: "New Desc" });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = UpdateProfileIdentitySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects empty name string", () => {
    const result = UpdateProfileIdentitySchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("ProfileResponseSchema", () => {
  it("parses a valid profile response", () => {
    const data = {
      _id: "p-123",
      name: "Test Profile",
      latestVersion: 3,
      createdAt: "2025-01-01T00:00:00Z",
    };
    const result = ProfileResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.createdAt).toBeInstanceOf(Date);
    }
  });
});

describe("ProfileVersionResponseSchema", () => {
  it("parses a valid version response", () => {
    const data = {
      _id: "pv-123",
      profileId: "p-123",
      version: 1,
      workerType: "coder-acp-copilot",
      model: "gpt-4o",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const result = ProfileVersionResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("requires model field", () => {
    const data = {
      _id: "pv-123",
      profileId: "p-123",
      version: 1,
      workerType: "coder-acp-copilot",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const result = ProfileVersionResponseSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe("ProfileWithVersionResponseSchema", () => {
  it("parses a profile with embedded version", () => {
    const data = {
      _id: "p-123",
      name: "Test Profile",
      latestVersion: 1,
      createdAt: "2025-01-01T00:00:00Z",
      version: {
        _id: "pv-123",
        profileId: "p-123",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "gpt-4o",
        mcpServers: ["search"],
        createdAt: "2025-01-01T00:00:00Z",
      },
    };
    const result = ProfileWithVersionResponseSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
