// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v5 as uuidv5 } from 'uuid';

/**
 * Namespace UUID derived from 'task.scope-mt.dev' using the RFC 4122 DNS namespace.
 * Used to generate deterministic UUIDv5 identifiers for task prompts.
 */
export const TASK_PROMPT_NAMESPACE = uuidv5('task.scope-mt.dev', uuidv5.DNS);

/**
 * Compute a deterministic UUIDv5 for a task prompt from its text content.
 *
 * The ID is derived from `uuidv5(text.trim(), TASK_PROMPT_NAMESPACE)`, making it:
 * - **Content-addressed**: same text always produces the same ID
 * - **Trim-insensitive**: leading/trailing whitespace is ignored
 * - **Standard UUID format**: 36-char hyphenated UUID, consistent with the rest of the codebase
 */
export function computeTaskPromptId(text: string): string {
  return uuidv5(text.trim(), TASK_PROMPT_NAMESPACE);
}
