// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import {
  runResourceSetups,
  runResourceTeardowns,
  selectPhaseBody,
  ResourcePhaseError,
  createConcealedStore,
} from "./resource-runner.js";
import type { ResourceConfig } from "../types/resource.js";

function resource(over: Partial<ResourceConfig> & Pick<ResourceConfig, "slug">): ResourceConfig {
  return {
    ref: `${over.slug}@r1`,
    resourceId: `id-${over.slug}`,
    revisionId: `rev-${over.slug}`,
    name: over.slug,
    setup: { sh: "true" },
    exports: [],
    ...over,
  } as ResourceConfig;
}

const opts = { cwd: tmpdir() };

describe("selectPhaseBody", () => {
  it("returns undefined when the phase is absent", () => {
    expect(selectPhaseBody(undefined, "s", "teardown")).toBeUndefined();
  });

  // Skipping silently would give a run that looks valid but has no resource.
  it("throws when the phase exists but has no sh body", () => {
    expect(() => selectPhaseBody({} as never, "s", "setup")).toThrow(ResourcePhaseError);
  });
});

describe("runResourceSetups", () => {
  it("publishes values written to $SCOPE_SETUP_ENV", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "sim",
          setup: { sh: 'echo "SIM_URL=http://localhost:18080" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SIM_URL"],
        }),
      ],
      opts,
    );
    expect(values).toEqual({ SIM_URL: "http://localhost:18080" });
  });

  it("merges values across resources in order", async () => {
    const { values, provisioned } = await runResourceSetups(
      [
        resource({ slug: "a", setup: { sh: 'echo "A=1" >> "$SCOPE_SETUP_ENV"' }, exports: ["A"] }),
        resource({ slug: "b", setup: { sh: 'echo "B=2" >> "$SCOPE_SETUP_ENV"' }, exports: ["B"] }),
      ],
      opts,
    );
    expect(values).toEqual({ A: "1", B: "2" });
    expect(provisioned.map((r) => r.slug)).toEqual(["a", "b"]);
  });

  it("reports the attempted prefix through onProvisioned before throwing", async () => {
    // Regression: the returned `provisioned` list is lost when setup throws, so a
    // caller relying on it tore down nothing — leaking both the resources that
    // already came up and the failing one, whose script may have created
    // containers before exiting non-zero.
    const seen: string[] = [];
    await expect(
      runResourceSetups(
        [
          resource({ slug: "a", setup: { sh: 'echo "A=1" >> "$SCOPE_SETUP_ENV"' }, exports: ["A"] }),
          resource({ slug: "b", setup: { sh: "exit 3" } }),
          resource({ slug: "c", setup: { sh: "true" } }),
        ],
        { ...opts, onProvisioned: (r) => seen.push(r.slug) },
      ),
    ).rejects.toThrow(ResourcePhaseError);
    // Includes the failing resource, excludes the one never attempted.
    expect(seen).toEqual(["a", "b"]);
  });

  it("reports a resource that fails export validation as attempted", async () => {
    const seen: string[] = [];
    await expect(
      runResourceSetups(
        [resource({ slug: "a", setup: { sh: "true" }, exports: ["NEVER_PUBLISHED"] })],
        { ...opts, onProvisioned: (r) => seen.push(r.slug) },
      ),
    ).rejects.toThrow(ResourcePhaseError);
    expect(seen).toEqual(["a"]);
  });

  it("fails the run when the script exits non-zero", async () => {
    await expect(
      runResourceSetups([resource({ slug: "bad", setup: { sh: "exit 3" } })], opts),
    ).rejects.toThrow(ResourcePhaseError);
  });

  // `sh -e`: a failing command must abort rather than continue into a
  // half-provisioned state that reports success.
  it("aborts on the first failing command", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "e", setup: { sh: 'false\necho "A=1" >> "$SCOPE_SETUP_ENV"' }, exports: ["A"] })],
        opts,
      ),
    ).rejects.toThrow(ResourcePhaseError);
  });

  // The omission would otherwise surface much later as an unresolved ${VAR}
  // inside an MCP registration failure.
  it("fails when a declared export is not published", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "sim", setup: { sh: "true" }, exports: ["SIM_URL"] })],
        opts,
      ),
    ).rejects.toThrow(/did not publish declared exports: SIM_URL/);
  });

  it("reports the failing resource so the caller can unwind the prefix", async () => {
    const started: string[] = [];
    await expect(
      runResourceSetups(
        [
          resource({ slug: "ok", setup: { sh: "true" } }),
          resource({ slug: "bad", setup: { sh: "exit 1" } }),
        ],
        { ...opts, log: (_l, m) => void started.push(m) },
      ),
    ).rejects.toThrow(ResourcePhaseError);
    expect(started.some((m) => m.includes("'ok'"))).toBe(true);
    expect(started.some((m) => m.includes("'bad'"))).toBe(true);
  });

  it("rejects a malformed $SCOPE_SETUP_ENV rather than dropping the line", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "m", setup: { sh: 'echo "nonsense" >> "$SCOPE_SETUP_ENV"' } })],
        opts,
      ),
    ).rejects.toThrow(/malformed \$SCOPE_SETUP_ENV/);
  });

  it("times out a hanging phase", async () => {
    await expect(
      runResourceSetups([resource({ slug: "slow", setup: { sh: "sleep 30" } })], {
        ...opts,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
  }, 10_000);

  it("passes extra environment through to the script", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "env",
          setup: { sh: 'echo "SEEN=$MY_VAR" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SEEN"],
        }),
      ],
      { ...opts, env: { MY_VAR: "from-worker" } },
    );
    expect(values.SEEN).toBe("from-worker");
  });
});

describe("runResourceTeardowns", () => {
  it("releases in reverse order so dependants unwind first", async () => {
    const order: string[] = [];
    await runResourceTeardowns(
      [
        resource({ slug: "first", teardown: { sh: "true" } }),
        resource({ slug: "second", teardown: { sh: "true" } }),
      ],
      { ...opts, log: (_l, m) => void (m.includes("Releasing") && order.push(m)) },
    );
    expect(order[0]).toContain("'second'");
    expect(order[1]).toContain("'first'");
  });

  // Cleanup failure must not mask the result the run actually produced.
  it("keeps going when one teardown fails, and does not throw", async () => {
    const logs: string[] = [];
    await expect(
      runResourceTeardowns(
        [
          resource({ slug: "a", teardown: { sh: "true" } }),
          resource({ slug: "b", teardown: { sh: "exit 1" } }),
        ],
        { ...opts, log: (_l, m) => void logs.push(m) },
      ),
    ).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes("teardown failed, continuing"))).toBe(true);
    expect(logs.some((m) => m.includes("Releasing resource 'a'"))).toBe(true);
  });

  it("skips resources with no teardown phase", async () => {
    await expect(
      runResourceTeardowns([resource({ slug: "none" })], opts),
    ).resolves.toBeUndefined();
  });
});

describe("resource parameters in the phase environment", () => {
  it("exposes resolved parameters to the setup script", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "sim",
          params: { REPO: "octo/api" },
          setup: { sh: 'echo "SEEDED=$REPO" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SEEDED"],
        }),
      ],
      opts,
    );
    expect(values).toEqual({ SEEDED: "octo/api" });
  });

  it("scopes parameters to their own resource rather than leaking across them", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "a",
          params: { REPO: "one/a" },
          setup: { sh: 'echo "A=$REPO" >> "$SCOPE_SETUP_ENV"' },
          exports: ["A"],
        }),
        resource({
          slug: "b",
          setup: { sh: 'echo "B=${REPO:-unset}" >> "$SCOPE_SETUP_ENV"' },
          exports: ["B"],
        }),
      ],
      opts,
    );
    expect(values).toEqual({ A: "one/a", B: "unset" });
  });

  // Caller env carries worker infrastructure such as DOCKER_HOST. A resource
  // that declared a same-named parameter would otherwise redirect the Docker
  // socket instead of configuring itself.
  it("lets caller-supplied env win over a colliding parameter", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "sim",
          params: { DOCKER_HOST: "tcp://attacker:2375" },
          setup: { sh: 'echo "SEEN=$DOCKER_HOST" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SEEN"],
        }),
      ],
      { ...opts, env: { DOCKER_HOST: "unix:///var/run/kubedock/kubedock.sock" } },
    );
    expect(values).toEqual({ SEEN: "unix:///var/run/kubedock/kubedock.sock" });
  });

  it("exposes parameters to teardown too, which needs them to identify what to remove", async () => {
    const published: string[] = [];
    await runResourceTeardowns(
      [
        resource({
          slug: "sim",
          params: { REPO: "octo/api" },
          teardown: { sh: 'test "$REPO" = "octo/api"' },
        }),
      ],
      {
        ...opts,
        log: (level, message) => {
          if (level === "warn") published.push(message);
        },
      },
    );
    // A non-zero exit would be logged as a teardown warning; silence means the
    // parameter was present.
    expect(published).toEqual([]);
  });
});

describe("concealed store", () => {
  it("exposes SCOPE_CONCEALED_ENV and keeps its values out of the published values", async () => {
    const store = await createConcealedStore();
    try {
      const result = await runResourceSetups(
        [
          {
            slug: "sim",
            ref: "sim@r1",
            revisionId: "r1",
            exports: ["VISIBLE"],
            setup: { sh: 'echo "VISIBLE=yes" >> "$SCOPE_SETUP_ENV"\necho "HIDDEN=secret" >> "$SCOPE_CONCEALED_ENV"' },
          } as never,
        ],
        { cwd: process.cwd(), concealedEnvPath: store.path },
      );
      expect(result.values).toEqual({ VISIBLE: "yes" });
      expect(result.concealed).toEqual({ HIDDEN: "secret" });
    } finally {
      await store.dispose();
    }
  });

  it("lets a later resource read what an earlier one concealed", async () => {
    const store = await createConcealedStore();
    try {
      const result = await runResourceSetups(
        [
          {
            slug: "first",
            ref: "first@r1",
            revisionId: "r1",
            exports: [],
            setup: { sh: 'echo "ENDPOINT=http://sim" >> "$SCOPE_CONCEALED_ENV"' },
          } as never,
          {
            slug: "second",
            ref: "second@r1",
            revisionId: "r2",
            exports: ["SAW"],
            setup: { sh: '. "$SCOPE_CONCEALED_ENV"\necho "SAW=$ENDPOINT" >> "$SCOPE_SETUP_ENV"' },
          } as never,
        ],
        { cwd: process.cwd(), concealedEnvPath: store.path },
      );
      expect(result.values.SAW).toBe("http://sim");
    } finally {
      await store.dispose();
    }
  });
});
