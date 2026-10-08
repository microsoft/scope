# Resources Architecture

Resources are first-class lifecycle definitions that make external dependencies available to a run (for example, a simulator container). They mirror codebases: a mutable `resources` identity document owns an immutable, sequential `resource-revisions` history. Runtime execution is pinned to revision ids so historical runs remain explainable after the resource changes.

## A note on the name

"Resource" is a loaded word in this codebase's neighbourhood — Kubernetes
resources, Azure resources, and container `resources:` limits all appear in the
deploy manifests. It was still chosen deliberately, because the entity describes
*what a run needs to exist*, independent of how it is produced: a container
started through the Docker socket and an externally provisioned cloud database
are the same thing from the run's point of view, and only the script bodies
differ.

One collision is worth knowing about: the portal already has a **nav group**
named "Resources" (`apps/portal/src/components/Layout.tsx`), described as
"project-scoped integrations you wire up (MCP, extensions)". This entity belongs
in that group semantically, so the nav label is disambiguated there rather than
the entity being renamed.

## Data model

- **Resource** — `_id` UUID, immutable `projectId`, project-scoped `slug`, display `name`, optional `description`, `revisionCounter`, `latestRevisionId` / `latestRevisionNumber`, creator/timestamps, and optional `deletedAt`.
- **ResourceRevision** — `_id` UUID, `resourceId`, `projectId`, denormalized `slug`, incremental `revisionNumber`, canonical `ref` (`{slug}@r{revisionNumber}`), normalized `setup` / `teardown` scripts, exported environment names, `contentSha256`, creator, `createdAt`, and optional `deletedAt`.

Revision numbers are allocated by atomically `$inc`-ing `resources.revisionCounter`; the latest pointer update is guarded by `latestRevisionNumber` so a slower concurrent writer cannot regress it. The authoritative latest lookup still sorts revisions by `revisionNumber`.

## Deduplication and immutability

A create/update of lifecycle content never edits an existing revision. `ResourceResolver` normalizes setup, teardown, and exports, hashes them into `contentSha256`, and deduplicates against the **latest revision only**. If the submitted lifecycle matches the current latest, the API returns that revision with `deduplicated: true`; if it matches an older revision but not the latest, a new revision is created. The check is best-effort rather than transactional, matching codebases: rare concurrent duplicate revisions are accepted instead of adding a content-unique index.

Deletion is soft and cascading. `DELETE /api/v1/resources/:id` sets `deletedAt` on the resource and its revisions. Listings exclude soft-deleted documents, but direct revision id/ref/number lookups still resolve them so run history remains explainable.

## REST API and CLI

Routes live in `apps/api/src/routes/resources.ts`:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/resources` | List non-deleted resources for `?projectId=` |
| `POST` | `/api/v1/resources` | Create a resource and its first revision atomically (rollback on revision failure) |
| `GET` | `/api/v1/resources/:id` | Fetch by resource id or project-scoped slug |
| `PATCH` | `/api/v1/resources/:id` | Update mutable metadata only |
| `DELETE` | `/api/v1/resources/:id` | Soft-delete resource and cascade to revisions |
| `GET` | `/api/v1/resources/:id/revisions` | List non-deleted revisions for a resource |
| `POST` | `/api/v1/resources/:id/revisions` | Create a new immutable revision or deduplicate against latest |
| `GET` | `/api/v1/resources/:id/revisions/latest` | Fetch latest non-deleted revision |
| `GET` | `/api/v1/resources/:id/revisions/:revisionNumber` | Fetch a revision number under a resource |
| `GET` | `/api/v1/resources/revisions/:id` | Fetch a revision by UUID |

No PATCH, PUT, or DELETE route exists for revisions. The CLI exposes `scope resource list|get|create|update|delete|revisions` and forwards `projectId` on every API call.
`scope resource create` and revision creation accept `--param NAME[:default][!]`
for declaring the revision's parameter contract; `!` marks a required parameter
and `:default` supplies the optional fallback shown in revision output.

`scope resource revisions <slug>` does double duty: it lists revisions, or creates one when
`--setup-sh`/`--setup-file` is supplied. A create whose content matches the latest revision is
deduplicated, and the CLI says so explicitly — `No changes — reused existing resource revision:` —
printing the same `Content SHA` as the revision it reused. That identical hash is the
user-visible face of the content addressing described above.

## Portal

Pages live under `apps/portal/src/pages/Resource*.tsx`, with `ResourcePicker` in `components/`,
mirroring the codebase catalog: a list with preview panel, a detail page, a create form, and a
picker wired into run submission.

The detail page is where immutability becomes legible. Selecting an older revision swaps the whole
pane — setup body, teardown body, exports, and `Content SHA` — to exactly what that revision
declared, rather than showing the latest with a version label. Reviewers can therefore confirm the
immutability claim by clicking, without querying the database.

In the sidebar the entity sits under **Integrations** (formerly "Resources"). The group was
renamed rather than the item: its siblings, MCP and Extensions, name *things*, so naming this item
anything other than Resources would have hidden it from anyone looking for it.

Run detail surfaces the pinned bindings, their resolved parameter values, `run.resources` and
`run.mcpRegistered` (see [Run observability](#run-observability)). Parameters a profile has
preset render **locked**, not merely pre-filled — an editable field whose value the API rejects
at submit would be a lie in the UI.

## Run observability

Two fields are written back after teardown:
| Field | Meaning |
|-------|---------|
| `run.resources[]` | Per resource: `ref`, `slug`, `revisionId`, `setupSucceeded`, `published[]`, `params`, `teardownRan` |
| `run.mcpRegistered` | Whether any MCP server was registered for the run |

These are nested under `run`, **not** at the document root. The request's own
`resources[]` — written at submit time — is the top-level field, and the two deliberately
share a name: keyed by the same `revisionId`, one is what the run asked for and the other is
what happened.

There is no parallel `resourceRevisionIds: string[]`. Pinned ids and their parameter values
live in one grouped array precisely so they cannot drift: two parallel lists would have to
stay the same length and order forever, an invariant nothing enforces, and three ids beside
two parameter maps has no correct interpretation.

`mcpRegistered: false` is a legitimate value, not a defect — a run using the `gh` CLI surface
registers no MCP server. It is, however, the fastest way to detect a *mis-submitted* run: a run
whose task instructs the agent to use MCP tools but which reports `mcpRegistered: false` never had
those tools, and any conclusion drawn from it is void. Registering an MCP server requires passing
it explicitly (`--mcp-servers <slug>`); attaching only the resource that publishes its URL is not
enough, and fails silently rather than loudly.

Both fields are also written when **setup itself fails**, not only on runs that
reached teardown. A provisioning failure is exactly when you need to know which
revision was attempted, what parameters it resolved to, and why it failed, so the
observations are persisted before the failure unwinds the run.

## Indexes

Migration `030-create-resource-indexes.ts` creates:

| Collection | Index | Purpose |
|------------|-------|---------|
| `resources` | `{ projectId: 1, slug: 1 }` unique-or-Cosmos-fallback | Scoped slug lookup and duplicate guard |
| `resources` | `{ projectId: 1 }`, `{ createdAt: -1 }`, `{ deletedAt: 1 }` | Project listings and active filters |
| `resource-revisions` | `{ projectId: 1, ref: 1 }` unique-or-Cosmos-fallback | Scoped ref lookup and duplicate guard |
| `resource-revisions` | `{ resourceId: 1 }`, `{ resourceId: 1, revisionNumber: -1 }` | Revision listing/latest lookups |

On Cosmos DB the unique indexes may degrade to non-unique lookup indexes, so the API performs explicit same-project duplicate checks for both resource slugs and revision refs.

## Run lifecycle and ordering

A run references resources by spec (`slug`, `slug@rN`, or a revision id). The API
**pins each to a concrete revision id at submit time** and stores those on the
request, so a finished run stays explainable after the resource gains new
revisions. Callers can submit either the bare string form or `{ ref, params }`.
The CLI maps repeated `--resource-param <slug>:<KEY>=<VALUE>` flags into the
matching `--resources` entry before posting the request.

When a profile version declares `resources`, those bindings provide the resource
refs and any preset parameters. A run may still fill parameters left unset by the
profile by sending a matching resource entry at the same position, but a
different value for a profile-pinned parameter is reported through the same
profile conflict response used for worker/model/MCP/skills/extensions. Grouped
profile-variation submissions apply the same positional rule per variation:
`profileVersion.resources ?? requestedResources`.

The worker then runs the lifecycle in a fixed order. **Each of these orderings is
load-bearing — moving one reintroduces a specific bug:**

```
docker socket available
  → purge orphan containers from a previous run
  → create workspace
  → resource setup, in reference order
  → MCP registration (with interpolation)
  → skills, AGENTS.md
  → agent turns
  → resource teardown, in reverse order
  → purge leftover containers
```

**Resource setup precedes MCP registration.** Registering a server opens a live
connection to it and throws when it is unreachable. A server backed by something
the run provisions itself could otherwise never be registered — setup failed
before the agent's first turn.

**Interpolation happens immediately before registration, after secret
hydration.** The queue processor hydrates MCP configs with plaintext secrets from
Token Manager, and that hydration *replaces* the whole `env`/`headers` object
rather than merging into it. Substituting `${VAR}` any earlier is silently
undone, which presents as "interpolation doesn't work" with nothing in the logs
to explain it.

**Teardown precedes the container purge.** The purge would otherwise destroy the
containers a teardown script is about to remove, leaving it to fail or silently
no-op.

**The orphan purge stays first.** A resource that publishes a fixed port cannot
start if a container from an earlier run is still holding it.

## Parameters — the inputs

Exports are what a setup phase publishes on the way out. **Parameters are what a run
supplies on the way in**, and they are the reason a resource is reusable rather than a
fixture. The GitHub simulator's lifecycle is identical for every repository, so the
repository is a parameter — not a reason to create a second resource.

```ts
interface ResourceParameter {
  name: string;          // environment variable identifier, e.g. "REPO"
  description?: string;
  required: boolean;
  default?: string;
  example?: string;      // illustrative only; never used as a fallback
}
```

Declarations live on the **revision** and are folded into `contentSha256`, so editing the
contract mints a new revision. A setup body and the parameters it reads have to move
together; if they could drift apart, a run pinned to an old revision could be handed a
parameter set that body never knew about.

Declarations are rejected at revision-create time — all problems at once, not the first —
when a name is not a valid environment variable identifier, uses the reserved `SCOPE_`
prefix, collides with one of the same revision's `exports`, is declared twice, or is marked
`required` while also carrying a `default` that could never apply. The export collision is
the subtle one: a name that is both an input and an output makes the published value
ambiguous, since which one wins would depend on phase ordering.

### Precedence: the profile wins

Values are merged **defaults → profile presets → run-supplied**, and a run **cannot
override what a profile sets**. This is not a rule invented for resources; it is what the
submit path already enforces for `worker`, `model`, `mcpServers`, `skills` and
`extensions`:

> *"Profile `<id>` controls these fields. Either omit them or match the profile values."*

| Case | Result |
|---|---|
| Profile sets it, run omits it | profile value |
| Profile sets it, run sends the same value | accepted |
| Profile sets it, run sends a different value | `400`, reported per parameter |
| Profile silent, run supplies it | run value — filling a gap is not overriding |
| Nobody supplies a `required` parameter | `400` |

Conflicts are reported **per parameter**, not per binding:

```
resources.github-simulator@r3.AS: sent "octo/ns", profile requires "mcp-demo/ns"
```

Per-binding comparison — the wholesale array compare used for `mcpServers` — would force a
run to restate every value the profile already fixed just to fill one the profile left
open, which defeats the reason parameters exist.

**Unknown keys are a `400`, never ignored.** A silently dropped `REPOS=` typo would seed the
resource with its default and produce a completely healthy-looking run that answers a
different question than the one asked. That failure mode — succeeding while meaning nothing
— is the one this whole area is built to prevent.

### Parameters at runtime

Resolved values are injected into the phase environment per resource, for **both** setup and
teardown; teardown usually needs them to identify what to remove. Precedence, widest first:

```
process.env  <  parameters  <  caller-supplied env  <  SCOPE_SETUP_ENV
```

`SCOPE_CONCEALED_ENV` sits outside this chain — see
[Publishing without telling the agent](#publishing-without-telling-the-agent).

Caller-supplied env wins deliberately: it carries worker infrastructure such as
`DOCKER_HOST`, and a resource declaring a parameter with that name would otherwise redirect
the Docker socket instead of configuring itself. Parameters are also merged per resource
rather than into shared phase options, so one resource's values cannot leak into the next
one's script.

### Parameterize scenario-specific facts too, not just obvious inputs

A resource stops being reusable at the first fact it asserts about one particular scenario,
and that fact is easy to miss because it is usually a *good* check.

The GitHub simulator's setup verified that issue #11 existed before declaring itself ready —
a deliberate fail-fast, since a simulator serving an empty seed looks healthy but has nothing
to work on. Once the repository became a parameter, that assertion was the thing that broke:
the first run against a different repository failed inside setup rather than in the import,
for a reason that had nothing to do with the repository being wrong.

The fix is not to drop the check but to parameterize it. `ASSERT_ISSUE` is optional; left
unset the assertion is skipped and only reachability is required, and the comparison profiles
pin it to `11`. The general rule: when parameterizing a resource, audit the lifecycle for
constants that describe the *scenario* rather than the *resource*, because those are what the
new parameters will collide with.

### Parameters are not a credential channel

Resolved values are stored in plaintext on the request document and shown in the portal.
**Do not pass tokens as parameters.** The GitHub simulator resource shows the intended
pattern: `SIM_TOKEN` is *derived inside setup* from the generated seed and published as an
export, so the credential never appears in the catalog or on the request. A `secretRef` form
resolving through Token Manager may come later; until it exists, this is a hard rule.

## Publishing connection details

A setup phase publishes values by appending `KEY=VALUE` lines to the file at
`$SCOPE_SETUP_ENV`. A file is used rather than stdout so that ordinary script
logging — `docker` progress, `curl` retries — cannot corrupt the contract. The
parser splits on the first `=` only (connection strings contain more), tolerates
CRLF, and rejects malformed lines rather than skipping them, since a dropped line
resurfaces much later as an unresolved `${VAR}` far from its cause.

Published values are used in two places:

1. **Interpolated into MCP server config** — `${VAR}` in `url`, `args`, `env`
   values and `headers[].value`. Which field carries them depends on transport:
   `command`/`args`/`env` for stdio, `url`/`headers` for http and sse. An
   unresolved placeholder fails the run and names every offender, because passing
   `${MCP_URL}` through literally fails much later inside the gateway as an
   opaque transport error.
2. **Merged into the agent's subprocess environment** — `buildSubprocessEnv`
   constructs a fixed object and never spreads `process.env`, so this is the only
   way an agent-facing tool can learn where the run's resources are.

### Publishing without telling the agent

Sometimes the platform needs a value the agent must not have. A benchmark that
compares tool surfaces is the clearest case: if the simulator's endpoint and token
are in the agent's environment, calling the REST API directly is the shortest path
from every arm, and the comparison stops measuring the surfaces it was built to
compare.

`$SCOPE_CONCEALED_ENV` is the same contract with a different audience. A setup
phase appends `KEY=VALUE` lines to it exactly as with `$SCOPE_SETUP_ENV`, and the
values reach:

- MCP server interpolation, so a server record can point at the resource;
- later resources' setup and teardown phases, via the same file;
- tooling wrappers the resource installs, which read the file at call time —
  setup bakes in the *path*, never the value.

They do not reach `buildSubprocessEnv`, so they are absent from the agent's
environment.

Unlike `$SCOPE_SETUP_ENV`, which is a fresh per-phase temp file, the concealed
store is **run-scoped and accumulates**. That is what lets a later resource read
what an earlier one published; previously a resource could not, which is why
tooling wrappers had to read connection details out of the agent's environment
for want of anywhere else to get them.

**This conceals from the environment, not from the filesystem.** Resource setup
and the agent run as the same uid, so a determined agent can still read the file;
POSIX cannot separate two processes that share a uid. The goal is to remove the
path of least resistance, not to build a sandbox. An agent that goes looking
through the filesystem for credentials is doing something qualitatively different
from reading its own environment, and that difference is visible in the
trajectory.

### Publish each name to exactly one channel

A key written to both `$SCOPE_SETUP_ENV` and `$SCOPE_CONCEALED_ENV` **fails the
run**. The two channels make opposite claims about agent visibility, so a key in
both has no sensible resolution: the concealed value would win for MCP
interpolation, the public value would be discarded, and the name would be
withheld from the agent entirely. Every one of those outcomes is surprising, and
the mistake is silent precisely where it matters most. Publish each name to one
channel and the intent stays legible.

### Choose published names carefully

Published values land in the agent's own process environment, so a name that a
tool already interprets will change that tool's behaviour.

This is not hypothetical. Publishing `GH_TOKEN` for a GitHub simulator broke the
Copilot CLI outright: the CLI reads `GH_TOKEN` in preference to `GITHUB_TOKEN`
for its *own* authentication, so it tried to authenticate against real GitHub
with the simulator's token and failed with `Authentication required` before the
first turn. A global `HTTP_PROXY` is the same class of hazard.

Prefer neutral, resource-specific names (`SIMULATOR_URL`, `SIM_TOKEN`) and let
the task prompt set tool variables inline on the commands that need them, so they
are scoped to the invocation rather than the whole agent:

```sh
GH_HOST=github.localhost GH_TOKEN="$SIM_TOKEN" HTTP_PROXY="$SIMULATOR_URL" \
  gh issue view 11 -R owner/repo
```

Resource values are spread *before* the fixed keys in `buildSubprocessEnv`, so a
resource cannot shadow `GITHUB_TOKEN` or the proxy settings that route model
traffic for capture — but it can still introduce a name the agent's tooling reads.

## Worker support is a declared capability

Provisioning is implemented per worker, so a resource-backed run is only routable
to a worker that advertises `supportsResources` in its `agent.yaml`. Today that is
`coder-acp-copilot`; the other workers declare it `false`. Submitting resources to
a worker without the capability is rejected at submit time (under
`strictAgentCapabilities`) rather than accepted and silently ignored — a run whose
declared database or simulator was never stood up would otherwise report a result
for an environment that never existed, which is worse than a rejection.

The same check runs on resubmit, so changing a rerun's profile to one targeting a
worker without resource support fails instead of quietly dropping the resources.

## Resources survive a resubmit

Resubmitting pins the **same revisions and the same parameter values** as the
original run, because a rerun that provisioned a different environment while
looking comparable would invalidate the comparison it exists to make. This holds
whether the resubmit keeps the original profile or detaches it.

Only an **explicitly selected replacement profile** re-resolves: that profile's
resource specs win and are re-pinned at resubmit time, matching how a profile
controls `mcpServers`, `skillRevisions`, and `extensions`. The distinction
matters because keeping the original profile still resolves its version
internally — treating that as "a profile is active" would re-resolve on an
ordinary resubmit, quietly upgrading `simulator@r1` to `simulator@r2`, replacing
a run-supplied parameter with the revision's default, or dropping resources the
profile never declared.

## Failure behaviour

- A setup phase exiting non-zero **fails the run**, and resources already
  provisioned are torn down in reverse — *including the resource that failed*,
  whose script may already have created containers before exiting. The attempted
  prefix is reported as each setup begins rather than returned at the end,
  because a throw discards the return value on exactly the paths that need
  unwinding.
- A resource that does not publish everything its revision declared in `exports`
  fails the run, naming the missing variables. It counts as attempted, so its
  teardown still runs.
- **Teardown covers the whole run lifecycle, not just the agent loop.** Resource
  provisioning happens during worker setup, so the cleanup boundary opens before
  setup: a failure in MCP registration, codebase seeding, skill extraction, or
  gate-prompt resolution releases resources rather than leaking them. Teardown is
  idempotent, so overlapping unwind paths are safe.
- Teardown is **best-effort**: failures are logged but do not change the run's
  outcome, because losing cleanup should not mask the result the run produced.
- Scripts run under `sh -e`, so a failing command aborts the phase instead of
  continuing into a half-provisioned state that still reports success.
- Before the first setup phase the worker checks the Docker socket and fails with
  an explicit message. Without it, a container-backed resource fails inside its
  own script with a raw `permission denied ... /var/run/docker.sock`, which reads
  like a group-ownership problem even when it is an SELinux label denial.

## Platforms

Script bodies are keyed by interpreter. Only `sh` is executed today; the shape
exists so PowerShell support for the Windows worker is additive rather than
breaking. A resource referenced by a run on a platform it has no body for fails
the run loudly — silently skipping setup would produce a run that looks valid but
has no resource.

## Leaked resources, and why there is no blanket sweep

If a worker dies between setup and teardown — SIGKILL, OOM, node eviction — the
resource's teardown never runs and whatever it created survives.

On Kubernetes this is largely handled: kubedock purges containers from previous
runs at worker setup, and reaps them on its own timeout. **Under local Docker
Compose there is no equivalent, and there deliberately cannot be a general one.**
`KubedockClient.isEnabled()` requires `KUBEDOCK_ENABLED=true` precisely because
Compose mounts the *host* Docker socket, where a blanket `purgeContainers()`
would delete the entire development stack — the database, the API, the gateway,
everything.

So cleanup of leaked resources is the **resource author's responsibility**, and a
setup phase must be written to be idempotent:

```sh
# A previous run that died between setup and teardown leaves these behind,
# and they hold the fixed ports this resource needs.
docker rm -f github-sim github-mcp >/dev/null 2>&1 || true
```

Removing by explicit name is safe in both environments: it is scoped to the
containers this resource owns, and cannot touch the surrounding stack. It also
fixes the practical symptom of a leak, which is a fixed published port still held
by a container from an earlier run.

Two corollaries worth stating:

- **Prefer fixed, resource-specific container names** over generated ones, since
  a name is the only handle a later run has on an orphan.
- **An externally provisioned resource — a cloud database, a SaaS sandbox — has
  no equivalent safety net.** A leak there costs money and no purge reclaims it.
  Such a resource should provision something with a server-side expiry, or tag
  what it creates so a separate reaper can find it.
