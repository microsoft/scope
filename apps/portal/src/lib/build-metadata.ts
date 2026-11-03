// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const UNKNOWN_METADATA = "unknown";
const DEVELOPMENT_COMMIT = "development";
const MAX_METADATA_LENGTH = 128;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SECRET_LIKE_PATTERN = /^(?:gh[pousr]_|github_pat_|sk-|eyJ)|(?:password|secret|token)=/i;

/** Environment variables accepted by the Portal build metadata resolver. */
export interface PortalBuildMetadataEnvironment {
  /** Git commit hash supplied by the host build or launch process. */
  GIT_COMMIT?: string;
  /** Git branch supplied by the host build or launch process. */
  GIT_BRANCH?: string;
  /** ISO-8601 timestamp supplied by the host build process. */
  BUILD_TIME?: string;
}

/** Public, non-secret build metadata embedded in the Portal client bundle. */
export interface PortalBuildMetadata {
  /** Validated Git commit hash, or `unknown` when unavailable. */
  commit: string;
  /** Validated Git branch, or `unknown` when unavailable. */
  branch: string;
  /** Validated build timestamp, or the current build/start time when unavailable. */
  buildTime: string;
}

/** Resolve explicit build metadata without inspecting the runtime repository. */
export function resolvePortalBuildMetadata(
  environment: PortalBuildMetadataEnvironment,
  now: () => Date = () => new Date(),
): PortalBuildMetadata {
  return {
    commit: resolveCommit(environment.GIT_COMMIT),
    branch: resolveBranch(environment.GIT_BRANCH),
    buildTime: resolveBuildTime(environment.BUILD_TIME, now),
  };
}

/** Accept only commit-shaped public values so arbitrary environment data is not embedded. */
function resolveCommit(value: string | undefined): string {
  const candidate = normalizeCandidate(value);
  if (
    candidate === DEVELOPMENT_COMMIT ||
    (candidate !== undefined && COMMIT_PATTERN.test(candidate))
  ) {
    return candidate;
  }

  return UNKNOWN_METADATA;
}

/** Accept Git branch-shaped public values while rejecting control characters and secret-like data. */
function resolveBranch(value: string | undefined): string {
  const candidate = normalizeCandidate(value);
  if (
    candidate === undefined ||
    candidate.length > MAX_METADATA_LENGTH ||
    SECRET_LIKE_PATTERN.test(candidate) ||
    !BRANCH_PATTERN.test(candidate) ||
    candidate.includes("..") ||
    candidate.includes("//") ||
    candidate.includes("@{") ||
    candidate.endsWith("/") ||
    candidate.endsWith(".")
  ) {
    return UNKNOWN_METADATA;
  }

  return candidate;
}

/** Preserve explicit ISO timestamps and otherwise stamp the current build/start time. */
function resolveBuildTime(value: string | undefined, now: () => Date): string {
  const candidate = normalizeCandidate(value);
  if (
    candidate !== undefined &&
    candidate.length <= MAX_METADATA_LENGTH &&
    !SECRET_LIKE_PATTERN.test(candidate) &&
    !Number.isNaN(Date.parse(candidate))
  ) {
    return candidate;
  }

  return now().toISOString();
}

/** Treat empty and sentinel values as unavailable metadata. */
function normalizeCandidate(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.toLowerCase() === UNKNOWN_METADATA) {
    return undefined;
  }

  return candidate;
}
