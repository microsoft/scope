# Taxonome behavior preview

## Authentication / Fixture agent

| Behavior / source | Distinct runs / total | Occurrences | Assessed | Unknown | Inapplicable | Error |
|---|---:|---:|---:|---:|---:|---:|
| Skipped Invocation | 1/2 | 1 | 1 | 1 | 0 | 0 |
| Skipped Invocation / auth.md | 1/2 | 1 | 1 | 1 | 0 | 0 |
| Timeout | 2/2 | 4 | 2 | 0 | 0 | 0 |
| Timeout / account/query | 2/2 | 3 | 2 | 0 | 0 | 0 |
| Timeout / authctl | 1/2 | 1 | 2 | 0 | 0 | 0 |

### Skipped Invocation evidence

Stable run, turn and call identities:

```json
[
  {
    "run_id": "run-0006",
    "extension_point": "auth.md",
    "source": {
      "id": "auth",
      "label": "auth.md",
      "surface_id": "surface-docs"
    },
    "discovery_turn": 2
  }
]
```

### Timeout evidence

Stable run, turn and call identities:

```json
[
  {
    "run_id": "run-0006",
    "source": {
      "id": "account",
      "label": "account/query",
      "surface_id": "surface-mcp"
    },
    "related_turns": [
      3
    ],
    "tool_call_id": "mixed-call"
  },
  {
    "run_id": "run-9201",
    "source": {
      "id": "account",
      "label": "account/query",
      "surface_id": "surface-mcp"
    },
    "related_turns": [
      2
    ],
    "tool_call_id": "p-a1"
  },
  {
    "run_id": "run-9201",
    "source": {
      "id": "account",
      "label": "account/query",
      "surface_id": "surface-mcp"
    },
    "related_turns": [
      3
    ],
    "tool_call_id": "p-a2"
  },
  {
    "run_id": "run-9201",
    "source": {
      "id": "auth-cli",
      "label": "authctl",
      "surface_id": "surface-cli"
    },
    "related_turns": [
      4
    ],
    "tool_call_id": "p-b1"
  }
]
```
