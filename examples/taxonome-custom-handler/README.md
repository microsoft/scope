# Custom Taxonome handler example

This project keeps authored taxonomy YAML, a compiled deterministic handler,
and a prompt element together. The deterministic YAML references only the
origin-independent handler ID `acme/retry-loop-v1`; the CLI loads code only
through explicit `--plugin`.

The relevant project files are:

- `taxonomy.yaml` and `elements/retry-loop.yaml` — authored taxonomy contract;
- `elements/repeated-request.yaml` — custom prompt instructions and output schema;
- `src/handlers/index.ts` — typed config/output schemas, handler, and plugin export;
- `dist/handlers/index.js` — compiled explicit plugin entry point;
- `inputs/run.atif.json` and `inputs/run.tar.gz` — equivalent deterministic inputs;
- `inputs/repeated-request/example-run.atif.json` — one prompt-run trajectory;
- `datasets/repeated-request/trajectory-cases.jsonl` — disjoint prompt
  train/validation/held-out trajectories with opaque model-visible identities;
- `datasets/repeated-request/expected-judgments.json` — reviewed true/false
  judgments kept separate from model input;
- `tests/retry-loop-handler.test.ts` — offline TypeScript unit tests for the
  deterministic implementation and its typed output contract.

```bash
cd examples/taxonome-custom-handler
pnpm build
pnpm test:handler
export PATH="$PWD/node_modules/.bin:$PATH"

# Without the explicit plugin, the authored handler remains unknown.
taxonome run inputs/run.atif.json --taxonomy taxonomy.yaml \
  --elements acme-retry-loop

# The same handler and taxonomy run against plain ATIF and a Scope archive.
taxonome run inputs/run.atif.json \
  --taxonomy taxonomy.yaml --plugin ./dist/handlers/index.js
taxonome run inputs/run.tar.gz \
  --taxonomy taxonomy.yaml --plugin ./dist/handlers/index.js
```

The prompt element uses the same taxonomy and current v2 case contract.
`COPILOT_GITHUB_TOKEN` and the shared external ledger are required only for
these real SDK/Ax commands:

```bash
taxonome eval --taxonomy taxonomy.yaml \
  --cases datasets/repeated-request/trajectory-cases.jsonl \
  --gold datasets/repeated-request/expected-judgments.json \
  --split heldout --elements acme-repeated-request --ledger <shared-ledger>
taxonome optimize --taxonomy taxonomy.yaml \
  --cases datasets/repeated-request/trajectory-cases.jsonl \
  --gold datasets/repeated-request/expected-judgments.json \
  --element acme-repeated-request \
  --output artifacts/repeated-request/optimized-prompt.ax.json \
  --max-metric-calls 12 --ledger <shared-ledger>
```

`eval` measures detector correctness against the reviewed judgments. A
completed `false` or `indeterminate` result can pass when that is the expected
judgment. `passed` / `total` counts case executions (including `--samples`
repeats), not successful agent tasks or SDK calls. When a prompt element reaches
model execution, each evaluation makes a fresh SDK call; authoritative
preflights can resolve a case without one. Artifact evaluation restores the
optimized prompt/demos but does not cache prior answers.

Omitting `--plugin` fails with a concise unknown-handler error. Taxonome never scans
directories, installs packages, performs network lookup, or imports a path from
YAML.

Plugin imports and top-level code run with the Taxonome process's permissions.
Frozen inputs plus config/result validation protect correctness; they are not a
security sandbox. Load only explicitly trusted compiled JavaScript.
