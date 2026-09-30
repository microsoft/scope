---
title: Provisioning resources
description: Declare dependencies a run needs before the agent starts — a seeded API simulator, a database, a fixture service — with setup and teardown scripts, declared inputs and immutable revisions.
---

Some benchmark scenarios need something to **exist before the agent
starts**: a seeded API simulator, a database, a service an MCP server
points at. A **resource** is how you declare that dependency so Scope
provisions it for you, records exactly what it provisioned, and tears it
down afterwards.

Without resources, that setup has to live in the task prompt, in worker
code, or in infrastructure you stand up by hand — none of which is
reproducible, and none of which shows up in the run record.

## What a resource is

| Part | Purpose |
| --- | --- |
| **Setup script** | Shell that provisions the dependency and publishes its connection details. |
| **Teardown script** | Shell that releases it. Optional, but see [Clean up after yourself](#clean-up-after-yourself). |
| **Exports** | Environment variable names the setup script promises to publish. |
| **Parameters** | Declared inputs the scripts read, so one resource serves many runs. |

Every edit produces a new **revision** (`my-resource@r3`). A run pins the
exact revision it used at submit time, so a run from months ago still
says precisely what it stood up.

## Publishing connection details

A setup script publishes values by appending to the file named by
`$SCOPE_SETUP_ENV`. Those become environment variables for the agent, and
can be interpolated into MCP server configuration:

```sh
docker run -d --name my-sim -p 3000:3000 my-simulator:latest
echo "SIMULATOR_URL=http://localhost:3000" >> "$SCOPE_SETUP_ENV"
```

Declare `SIMULATOR_URL` in the resource's **exports**. A setup phase that
does not publish everything it declared fails the run and names what is
missing, rather than letting the agent start against a half-built
environment.

To publish a value the platform needs but the agent should not see — a
token an MCP server authenticates with, for instance — append it to
`$SCOPE_CONCEALED_ENV` instead. Concealed values reach MCP configuration
and later resources, but are withheld from the agent's own environment.

:::note
Concealing removes the obvious path, not every path. Setup scripts and the
agent run as the same user, so a determined agent could still read the
file. Treat it as reducing incidental exposure, not as a sandbox.
:::

## When setup runs

Resource setup runs **before** anything else the run needs:

1. An empty workspace is created.
2. **Resource setup scripts run**, in the order you attached them.
3. MCP servers are registered, using values your resources published.
4. The codebase is cloned into the workspace.
5. Skills and `AGENTS.md` are written.
6. The agent starts.

Two consequences worth knowing:

- The workspace exists but is **empty** when setup runs. Your script's
  working directory is the workspace, so it can write there — but it
  cannot read repository files, because they are not there yet.
- Resources come up before MCP registration deliberately. Registration
  opens a live connection and fails if the server is unreachable, so
  anything an MCP server talks to has to exist first.

## Clean up after yourself

This is the part that most often surprises people.

Teardown runs after the agent finishes, on success **and** on failure. But
if a worker dies outright — killed, out of memory, evicted — teardown
never runs, and whatever setup created survives.

On Kubernetes this is mostly absorbed: containers from previous runs are
purged when a worker starts. **Running locally under Docker Compose there
is no equivalent, and there deliberately cannot be a general one** — a
blanket container sweep would delete the development stack itself: the
database, the API, everything.

So cleaning up after a previous run's crash is **the resource author's
job**. Write setup to be idempotent by removing your own containers by
name, first thing:

```sh
# A previous run that died before teardown may have left these behind,
# still holding the ports this resource needs.
docker rm -f my-sim >/dev/null 2>&1 || true

docker run -d --name my-sim -p 3000:3000 my-simulator:latest
```

Removing by explicit name is safe everywhere: it touches only the
containers this resource owns, and cannot reach the surrounding stack. It
also fixes the practical symptom of a leak, which is a fixed port still
held by an orphan from an earlier run.

Two corollaries:

- **Prefer fixed, resource-specific container names** over generated ones.
  A name is the only handle a later run has on an orphan.
- **Externally provisioned resources have no safety net at all.** A cloud
  database or SaaS sandbox that leaks costs money, and no purge reclaims
  it. Provision something with a server-side expiry, or tag what you
  create so a separate reaper can find it.

:::caution
A resource without a teardown script leaks by design. Scope will let you
save one, because a resource that provisions nothing durable does not need
teardown — but if yours creates containers, databases or cloud objects,
the absence of teardown means every run leaves them behind.
:::

## Parameters

Parameters turn one resource into a reusable one. Declare them on the
resource, then supply values when you attach it to a run or a profile:

```sh
scope run submit --profile my-profile \
  --resources my-simulator \
  --resource-param my-simulator:REPO=octocat/hello-world
```

Scripts read parameters as ordinary environment variables. A required
parameter with no value fails the run at submit time, before anything is
provisioned.

When a profile pins parameter values, the profile wins and a conflicting
run-supplied value is rejected rather than silently ignored — the same
rule profiles follow for models, MCP servers and skills.

## Creating a resource

From the Portal, open **Resources** and click **Create resource**. From
the CLI:

```sh
scope resource create --name "My simulator" --slug my-simulator \
  --setup-file ./setup.sh \
  --teardown-file ./teardown.sh \
  --exports SIMULATOR_URL \
  --param 'REPO!'
```

`REPO!` marks the parameter required. Editing a resource creates a new
revision; existing runs keep the revision they pinned.

## Seeing what a run provisioned

A completed run records, per resource, the revision it pinned, the
parameter values it resolved, which variables were published, whether
setup succeeded, and whether teardown ran. That last field is the one to
check when you suspect a leak: `teardownRan: false` on a finished run
means something survived.

## Worker support

Resources are provisioned by workers that advertise support for them.
Submitting a resource-backed run to a worker without that capability is
rejected at submit time rather than quietly ignored — a run whose declared
database was never created would otherwise report a perfectly plausible
result for an environment that never existed.
