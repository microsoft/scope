// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Resource connection-detail parsing.
 *
 * A resource's setup phase publishes its connection details by appending
 * `KEY=VALUE` lines to the file whose path the worker passes as
 * `$SCOPE_SETUP_ENV`. A file is used rather than parsing stdout so that ordinary
 * logging from the script — `docker` progress, `curl` retries — cannot corrupt
 * the contract.
 */

/** A malformed line in an env file, reported with its 1-based line number. */
export interface EnvParseError {
  line: number;
  text: string;
  reason: string;
}

export interface ParseEnvResult {
  values: Record<string, string>;
  errors: EnvParseError[];
}

/** Valid shell environment variable name. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the contents of a `$SCOPE_SETUP_ENV` file.
 *
 * Rules, each chosen to avoid a silent misread:
 * - Split on the **first** `=` only, so values may contain `=` (connection
 *   strings and tokens routinely do).
 * - Tolerate CRLF as well as LF.
 * - Ignore blank lines and `#` comments.
 * - Collect malformed lines as errors rather than skipping them. A dropped line
 *   would surface much later as an unresolved `${VAR}`, far from its cause.
 *
 * A later assignment to the same name wins, matching shell semantics.
 */
export function parseResourceEnv(contents: string): ParseEnvResult {
  const values: Record<string, string> = {};
  const errors: EnvParseError[] = [];

  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      errors.push({ line: i + 1, text: raw, reason: "missing '='" });
      continue;
    }

    const name = trimmed.slice(0, eq).trim();
    if (!NAME_RE.test(name)) {
      errors.push({
        line: i + 1,
        text: raw,
        reason: name === "" ? "empty variable name" : `invalid variable name '${name}'`,
      });
      continue;
    }

    values[name] = trimmed.slice(eq + 1);
  }

  return { values, errors };
}

/**
 * Check that a setup phase published everything its revision promised.
 *
 * Returns the names that were declared in `exports` but never assigned. The
 * caller fails the run with these, rather than letting the omission surface
 * later as an unresolved `${VAR}` inside an MCP registration error.
 */
export function missingExports(declared: string[], values: Record<string, string>): string[] {
  return declared.filter((name) => !(name in values));
}

/**
 * Detect names published by more than one resource.
 *
 * Two resources publishing the same name would make the resulting environment
 * depend on reference order, invisibly. That is treated as an error rather than
 * last-one-wins.
 *
 * @param published - per-resource published names, in reference order.
 * @returns each colliding name with the slugs that published it.
 */
export function exportCollisions(
  published: Array<{ slug: string; names: string[] }>,
): Array<{ name: string; slugs: string[] }> {
  const owners = new Map<string, string[]>();
  for (const { slug, names } of published) {
    for (const name of names) {
      const list = owners.get(name);
      if (list) list.push(slug);
      else owners.set(name, [slug]);
    }
  }
  return [...owners.entries()]
    .filter(([, slugs]) => slugs.length > 1)
    .map(([name, slugs]) => ({ name, slugs }));
}
