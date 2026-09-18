---
name: documentation
description: >
  Best practices for writing and maintaining documentation in this repository.
  Use this skill when writing or updating files in docs/, adding Mermaid
  diagrams, or creating README and onboarding documentation.
metadata:
  version: "1.0.0"
---

# Documentation Skill

Best practices for writing and maintaining documentation in this repository.

## When to Use

Use this skill when:

1. Writing or updating any documentation in `docs/`
2. Adding diagrams to markdown files
3. Creating README or onboarding documentation

## Diagrams

**Always use Mermaid** for diagrams in markdown files. Do not use ASCII art, PlantUML, or external image files for architecture diagrams.

Mermaid is natively rendered by GitHub, the portal markdown viewer, and most documentation tools. It keeps diagrams version-controlled, diffable, and editable without external tooling.

### Common Diagram Types

| Use Case | Mermaid Type |
| --- | --- |
| Architecture / data flow | `flowchart LR` or `flowchart TD` |
| State machines / lifecycles | `stateDiagram-v2` |
| Sequences / request flows | `sequenceDiagram` |
| Class relationships | `classDiagram` |
| Timelines / Gantt | `gantt` |

### Example

````markdown
​```mermaid
flowchart LR
    A[Service A] -->|REST| B[Service B]
    B --> C[(Database)]
​```
````

### Guidelines

- Keep diagrams focused — one concept per diagram
- Use descriptive node labels (not single letters)
- Prefer `LR` (left-to-right) for pipelines and `TD` (top-down) for hierarchies
- Add a brief text description above the diagram for accessibility
- If a diagram becomes too complex (>15 nodes), split it into multiple diagrams

## Documentation Structure

- Architecture docs live in `docs/architecture/`
- Each major component or subsystem gets its own file
- New docs must be linked in the `AGENTS.md` Documentation table
- Use the existing docs as style reference (headings, tables, code blocks)