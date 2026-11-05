# Taxonome behavior preview

## Recovered retry / Custom handler

| Behavior / source | Distinct runs / total | Occurrences | Assessed | Unknown | Inapplicable | Error |
|---|---:|---:|---:|---:|---:|---:|
| Recovered Retry Loop | 2/2 | 2 | 2 | 0 | 0 | 0 |
| Recovered Retry Loop / account/query | 2/2 | 2 | 2 | 0 | 0 | 0 |

### Recovered Retry Loop evidence

```json
[
  {
    "run_id": "acme-run-1",
    "source": {
      "id": "account/query",
      "label": "account/query",
      "surface_id": "surface-mcp"
    },
    "related_turns": [
      2
    ],
    "tool_call_id": "retry-1",
    "attempts": 3
  },
  {
    "run_id": "acme-run-archive",
    "source": {
      "id": "account/query",
      "label": "account/query",
      "surface_id": "surface-mcp"
    },
    "related_turns": [
      2
    ],
    "tool_call_id": "retry-1",
    "origin": {
      "iteration": 1,
      "step_id": 2,
      "tool_call_id": "retry-1"
    },
    "attempts": 3
  }
]
```
