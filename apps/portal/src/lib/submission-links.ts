// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export function submissionResultsPath(submissionId: string, projectId: string): string {
  const params = new URLSearchParams({ projectId, submissionId, groupBy: "profile" });
  return `/runs?${params}`;
}

export function submittedRunPath(
  result: { id?: string; ids?: string[]; submissionId?: string },
  projectId: string | undefined,
): string {
  if (result.ids && result.submissionId && projectId) {
    return submissionResultsPath(result.submissionId, projectId);
  }
  return result.id ? `/runs/${result.id}` : "/runs";
}
