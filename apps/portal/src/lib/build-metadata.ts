// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const DEVELOPMENT_COMMIT = "development";
const MAX_METADATA_LENGTH = 128;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SECRET_LIKE_PATTERN = /^(?:gh[pousr]_|github_pat_|sk-|eyJ)|(?:password|secret|token)=/i;
const UNKNOWN_METADATA = "unknown";

/** Environment variables accepted by the Portal build metadata resolver. */
export interface PortalBuildMetadataEnvironment {
  /** Set to exactly `false` to skip Git lookup and use development placeholders. */
  PORTAL_GIT_INFO_ENABLED?: string;
  /** Git commit hash supplied by the build environment. */
  GIT_COMMIT?: string;
  /** Git branch supplied by the build environment. */
  GIT_BRANCH?: string;
  /** ISO-8601 timestamp supplied by the build environment. */
  BUILD_TIME?: string;
}

/** Public, non-secret build metadata embedded in the Portal client bundle. */
export interface PortalBuildMetadata {
  /** Validated Git commit hash, or `development` when unavailable. */
  commit: string;
  /** Validated Git branch, or an empty string when unavailable. */
  branch: string;
  /** Validated build timestamp, or the current build/start time when unavailable. */
  buildTime: string;
}

/** Git values read once during Vite startup or a production bundle build. */
export interface PortalGitMetadataReader {
  /** Read the repository HEAD commit hash. */
  readCommit(): string | undefined;
  /** Read the current repository branch. */
  readBranch(): string | undefined;
}

/** Resolve explicit metadata first, then Git, unless lookup is disabled for Compose development. */
export function resolvePortalBuildMetadata(
  environment: PortalBuildMetadataEnvironment,
  gitMetadata: PortalGitMetadataReader,
  now: () => Date = () => new Date(),
): PortalBuildMetadata {
  const buildTime = resolveBuildTime(environment.BUILD_TIME, now);
  if (environment.PORTAL_GIT_INFO_ENABLED === "false") {
    return {
      commit: DEVELOPMENT_COMMIT,
      branch: "",
      buildTime,
    };
  }

  return {
    commit:
      resolveCommit(environment.GIT_COMMIT) ??
      resolveCommit(gitMetadata.readCommit()) ??
      DEVELOPMENT_COMMIT,
    branch:
      resolveBranch(environment.GIT_BRANCH) ??
      resolveBranch(gitMetadata.readBranch()) ??
      "",
    buildTime,
  };
}

/** Accept only commit-shaped public values so arbitrary environment data is not embedded. */
function resolveCommit(value: string | undefined): string | undefined {
  const candidate = normalizeCandidate(value);
  if (
    candidate === DEVELOPMENT_COMMIT ||
    (candidate !== undefined && COMMIT_PATTERN.test(candidate))
  ) {
    return candidate;
  }

  return undefined;
}

/** Accept Git branch-shaped public values while rejecting control characters and secret-like data. */
function resolveBranch(value: string | undefined): string | undefined {
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
    return undefined;
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
    ISO_DATE_TIME_PATTERN.test(candidate) &&
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
