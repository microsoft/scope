# Cosmos DB backup & restore (rollback tooling)

Two pnpm scripts snapshot a Cosmos DB for MongoDB database to a local archive and
restore it back. They exist so a risky deploy or data migration can be reversed:
take a snapshot before rollout, and restore from it if the data ends up wrong.

- `pnpm db:dump` -> `scripts/cosmos/dump.ts`
- `pnpm db:restore` -> `scripts/cosmos/restore.ts`

Both TypeScript scripts shell out to the MongoDB Database Tools (`mongodump` / `mongorestore`) and
use the Azure CLI only for the control plane (connection string, collection
list). The connection string is fetched into an in-memory variable and is never
printed, written to disk, or passed on a command line.

## The important constraint: Scope Cosmos is private-only

All Scope Cosmos accounts (`db-scope-v2-int`, `db-scope-v2-int2`,
`db-scope-v2-prd`) have **`publicNetworkAccess: Disabled`**. They are reachable
only through their private endpoint, from inside the cluster VNet. A `mongodump`
from a laptop cannot connect and fails with:

```
(AuthenticationFailed) Request blocked by network firewall
```

So the normal way to run these scripts against a Scope database is **in-cluster**
with `--via-kubectl`: the restore/dump script launches an ephemeral `mongo:4.2` pod in a
cluster whose VNet has the private endpoint, runs the tool there, and streams the
archive back to your machine. The Azure control-plane calls (`az ...`) still run
locally, since that API is public.

The temporary pod is deleted after the operation. If it cannot become ready
within the 180-second startup timeout, the helper also requests its deletion
before reporting the startup failure, using the same context and namespace.

The native / Docker runners still exist for the case where you run from a network
that is already allowed to reach the account (e.g. a VNet-joined host).

### Per-environment reachability

| Account | Reachable from | Notes |
|---------|----------------|-------|
| `db-scope-v2-int` | `aks-scope-v2-int` (its Cosmos private DNS resolves + TCP 10255 OK from this cluster) | Use `--via-kubectl --kube-context aks-scope-v2-int`. This is the account the `integration` overlay (a main-merge deploy) targets. |
| `db-scope-v2-prd` | `aks-scope-v2-prd` | Use `--via-kubectl --kube-context aks-scope-v2-prd`. |
| `db-scope-v2-int2` | **nothing currently** - `vnet-scope-v2-int2` has no AKS cluster/nodes (no `rg-scope-v2-int2-nodes`, zero NICs in its `aks-nodes` subnet), and its mongo private DNS zone is linked only to `vnet-scope-v2-int2` | Not reachable from any existing cluster. All env VNets share `10.1.0.0/16`, so they **cannot** be peered. Dump requires either an AKS cluster provisioned in `vnet-scope-v2-int2` (then `--via-kubectl --kube-context <int2>`), or a mutation (temp IP allowlist / throwaway ACI in the VNet). Otherwise use **PITR** (below). |

## Prerequisites

- **Azure CLI** logged in (`az login`) with access to the target account.
- For `--via-kubectl`: **kubectl** with a context whose cluster VNet has the
  private endpoint for the target account, and permission to create/exec pods in
  the chosen namespace (default `default`).
- For the native / Docker runners (allowed-network case): **mongodump /
  mongorestore** via `brew install mongodb-database-tools`, or Docker running (the
  TypeScript scripts fall back to the `mongo:4.2` image, which bundles the legacy tools).

## Environments

`--env` selects a preset (default `int2`). Any value can be overridden with
`--account`, `--resource-group`, and `--database`.

| `--env` | Account | Resource group | Database |
|---------|---------|----------------|----------|
| `int2` (default) | `db-scope-v2-int2` | `rg-scope-v2-int2` | `scope-mt` |
| `int`   | `db-scope-v2-int`  | `rg-scope-v2-int`  | `scope-mt` |
| `prod`  | `db-scope-v2-prd`  | `rg-scope-v2-prd`  | `scope-mt` |

> `pnpm` needs `--` before script flags, e.g. `pnpm db:dump -- --env int --via-kubectl`.

## Dump

```bash
# In-cluster (normal case for private-only Cosmos):
pnpm db:dump -- --env int  --via-kubectl --kube-context aks-scope-v2-int
pnpm db:dump -- --env prod --via-kubectl --kube-context aks-scope-v2-prd

# Allowed-network case (native/Docker), if you are on a VNet-joined host:
pnpm db:dump -- --env int
pnpm db:dump -- --env int --out ~/cosmos-backups   # custom output dir
```

`--via-kubectl` options: `--kube-context <ctx>` (default: current context),
`--namespace <ns>` (default: `default`).

Output (git-ignored under `.backups/`, override with `--out` or `BACKUP_DIR`):

```
.backups/cosmos/<account>/<database>-<UTC>.archive.gz               # the dump
.backups/cosmos/<account>/<database>-<UTC>.archive.gz.manifest.json # metadata
.backups/cosmos/<account>/<database>-<UTC>.archive.gz.log           # dump log
```

The manifest records the env, account, database, UTC timestamp, git SHA, archive
sha256, tool/runner, the collection list Cosmos reported, and per-collection
document counts.

**Verification** runs automatically:

1. Every collection Cosmos lists for the database must appear in the dump log
   (fails if any live collection is missing).
2. The archive must pass a `gzip -t` integrity check.

## Restore (safe by default)

`pnpm db:restore` is a **dry run** unless you pass `--execute`, and it targets a
**new database** (`<database>-restore-<UTC>`) so live collections and their Cosmos
shard keys are never touched. It also runs in-cluster with `--via-kubectl`.

```bash
# Dry-run the latest int archive from inside the int cluster:
pnpm db:restore -- --env int --via-kubectl --kube-context aks-scope-v2-int

# Dry-run a specific archive:
pnpm db:restore -- --env int --via-kubectl --archive path/to.archive.gz

# Execute a restore into a NEW database:
pnpm db:restore -- --env int --via-kubectl --execute
pnpm db:restore -- --env int --via-kubectl --execute --to-database scope-mt-recovered

# Execute in-place (write back into the source db, insert documents, no drop):
pnpm db:restore -- --env int --via-kubectl --execute --in-place

# DANGER: drop + recreate collections in place (see shard-key caveat):
pnpm db:restore -- --env int --via-kubectl --execute --in-place --force-drop
```

Behaviour matrix:

| Flags | Writes? | Target | Drops collections? |
|-------|---------|--------|--------------------|
| (none) | no (dry run) | new db | no |
| `--execute` | yes | `<db>-restore-<UTC>` | no |
| `--execute --in-place` | yes | source db | no (inserts documents; existing `_id`s are skipped as duplicates) |
| `--execute --in-place --force-drop` | yes | source db | **yes** |

Writing modes prompt for a typed `yes` confirmation (skip with `-y`/`--yes`). If
the archive has a manifest, its sha256 is checked before restoring.

## Cosmos-specific caveats

- **RU throttling (429 / error 16500).** Both TypeScript scripts use single-collection
  parallelism; the dump retries up to 3 times with backoff. If you still get
  throttled, temporarily raise the collection's autoscale RU during the operation
  (see [Database Collection Scaling](../architecture/db-collection-scaling.md)).
- **Shard keys.** A Cosmos collection's shard key is defined via the control
  plane (ASO collection manifests), not the data plane.
  `mongorestore --drop` deletes and recreates the collection and can lose that
  definition, which is why restore defaults to a new database and `--drop` is
  opt-in (`--force-drop`). If you use it, re-apply the collection manifests
  afterwards.
- **Implicit creation.** Restoring into a new database relies on Cosmos
  auto-creating collections on first write. If the account disallows it,
  pre-provision the target collections first.

## Alternative / fallback: native point-in-time restore (PITR)

All three accounts have **continuous backup** (`Continuous30Days`) enabled, so you
can restore the account (or specific databases/collections) to any point in the
last 30 days without a dump at all. PITR always restores into a **new account**.

This is the rollback lever for **int2**, which currently has no cluster in its
VNet to run `mongodump` from (see reachability table). PITR needs no compute and
no infra changes.

**Verified int2 restore coordinates** (as of 2026-07-14; re-check before use):

| Field | Value |
|-------|-------|
| Account | `db-scope-v2-int2` / `rg-scope-v2-int2` |
| Restorable instance id | `c23f0296-96cc-431a-a06b-5fc293afa121` |
| Location | `West US 3` |
| Oldest restorable time | `2026-06-14T20:11:03Z` (rolling 30-day window) |
| Live data (Azure Monitor) | ~9,335 documents, ~520 MB |

**Pre-deploy checklist for a risky int2 migration (e.g. #1241 `025`/`026`):**

1. **Before merging/deploying**, record the current UTC time - this is your
   rollback target: `date -u +%Y-%m-%dT%H:%M:%SZ`.
2. Deploy. If the migration corrupts data, restore int2 to that timestamp:

```bash
# 1) Confirm the restorable instance + window (values above may have rolled):
az cosmosdb restorable-database-account list \
  --query "[?accountName=='db-scope-v2-int2'].{id:name,loc:location,oldest:oldestRestorableTime}" -o table

# 2) Restore to a NEW account at the pre-deploy UTC timestamp:
az cosmosdb restore \
  --target-database-account-name db-scope-v2-int2-restored \
  --account-name db-scope-v2-int2 \
  --resource-group rg-scope-v2-int2 \
  --location "West US 3" \
  --restore-timestamp <pre-deploy-UTC-timestamp>

# 3) Point the app at the restored account, or copy the needed data back.
```

Because PITR creates a new account, cutting over means repointing the app's
connection string (or copying data out of the restored account). For a targeted
"undo this migration" a local archive you can `mongorestore` is usually more
convenient, which is what the scripts above produce.
