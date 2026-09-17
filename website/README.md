# scope-doc

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

End-user documentation site for **Scope**, built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
and published to GitHub Pages.

The product and this documentation site live in
[microsoft/scope](https://github.com/microsoft/scope).

## Project structure

```
.
├── public/                          # static assets
├── src/
│   ├── assets/
│   ├── components/                  # Astro landing, playground, header, page title
│   ├── content/docs/                # all user-facing pages (.md / .mdx)
│   │   ├── introduction/
│   │   ├── getting-started/
│   │   ├── guides/
│   │   ├── reference/
│   │   └── resources/
│   ├── openapi/scope-openapi.json   # artifact generated from the API registry
│   ├── plugins/
│   │   ├── remark-base-links.mjs    # project-base-safe Markdown and MDX links
│   │   └── remark-http-snippets.mjs # turns ```http blocks into multi-language tabs
│   ├── scripts/flow-demo.ts         # progressive-enhancement playground controller
│   ├── styles/landing.css           # shared brand tokens + scoped landing styles
│   └── content.config.ts
├── astro.config.mjs                 # sidebar, plugins, starlight-openapi config
├── AGENTS.md                        # conventions & guardrails for contributors / AI agents
├── package.json
└── tsconfig.json
```

Sidebar order is defined in `astro.config.mjs`, not by directory order.

## Commands

| Command                | Action                                                     |
| :--------------------- | :--------------------------------------------------------- |
| `pnpm install`         | Install dependencies                                       |
| `pnpm dev`             | Start dev server at the worktree's `DOC_PORT` (fallback: 4300) |
| `pnpm build`           | Build the production site to `./dist/`                     |
| `pnpm preview`         | Preview the production build locally                       |
| `pnpm refresh:openapi` | Generate the OpenAPI snapshot from `scope-core` |

## Authoring docs

- Use `.md` for plain Markdown, `.mdx` whenever the page contains JSX
  (e.g. Starlight `<Tabs>`).
- Write HTTP examples as a single fenced ` ```http ` block — the
  custom remark plugin in
  [src/plugins/remark-http-snippets.mjs](src/plugins/remark-http-snippets.mjs)
  expands it into synced curl / JS fetch / Python / Go / Java / C#
  tabs at build time. Files containing such blocks must be `.mdx`.
- Per-endpoint REST API reference pages under `/reference/api/...`
  are auto-generated from `src/openapi/scope-openapi.json` by
  [`starlight-openapi`](https://starlight-openapi.vercel.app/) — do
  not edit them by hand.
- Run `pnpm refresh:openapi` from this directory after changing API
  routes or schemas. It runs `apps/api`'s generator from the same
  `scope-core` checkout, so root workspace dependencies must be
  installed first.

See [AGENTS.md](AGENTS.md) for conventions, the source-of-truth
policy (everything factual must be grounded in scope-core), and
where to look in scope-core for any given topic.

## Deployment

Changes merged to `main` deploy to GitHub Pages via
[../.github/workflows/static.yml](../.github/workflows/static.yml).
The workflow builds from this `website/` directory (via a
`working-directory` default and `website/**` path filters). `site`
and `base` use `actions/configure-pages` outputs on `main`. Pull
requests build with the `/scope` project base but do not deploy.
Root/custom-domain Pages deployments retain an empty base. Output is
explicitly static: no SSR adapter, server, or API credentials are needed.

To reproduce the project-site build locally, run from `website/`:

```sh
SITE=https://microsoft.github.io BASE_PATH=/scope pnpm build
SITE=https://microsoft.github.io BASE_PATH=/scope pnpm preview
```

Open `/scope/` on the preview server. Use the production preview to
exercise Pagefind search; its index is generated at build time.

Author Markdown links as `/getting-started/access/`, for example.
The base-link remark plugin prefixes Markdown links, reference
definitions, images, and literal MDX `href`/`src` attributes.
Astro components must construct internal URLs with
`import.meta.env.BASE_URL`. External URLs, protocol-relative URLs,
fragments, and relative links are left unchanged. The generated API
landing route is `/reference/api/`, not `/reference/api/operations/`.

## Experience design

The landing page is a product introduction and an entry point into the
documentation, not a replacement for the documentation reader.
Starlight retains search, theme selection, the mobile sidebar, the
table of contents, code examples, and previous/next navigation.

- **Visual language:** restrained indigo, neutral surfaces, readable
  system fonts, a dotted flow canvas, and shared light/dark tokens.
  Green and red communicate criterion outcomes, always with text.
- **Navigation:** a landing header with direct documentation and demo
  links, plus task-oriented guide groups: run experiments, design a
  benchmark, and connect tools. Existing document URLs are preserved.
- **Onboarding:** a concrete example before terminology, followed by
  separate Portal, CLI, and API entry points. Access requirements are
  explicit rather than promising instant access to a hosted service.
- **Motion:** confined to the example experiment, not a permanently
  animated logo or documentation chrome.

### Interactive playground

[FlowDemo.astro](src/components/FlowDemo.astro) renders the full diagram
and an initial task prompt as static HTML.
[flow-demo.ts](src/scripts/flow-demo.ts) progressively enhances it using
a custom element. It makes no network requests and adds no framework
or animation-library dependencies.

Two invented scenarios illustrate task submission, five sample agent profiles,
a three-node criteria dependency graph, and per-criterion evidence.
The example results deliberately differ by scenario. They are labeled
as simulations, not measurements or agent rankings. Keep that
distinction if adding scenarios.

The sample roster is GitHub Copilot, Claude Code, Cursor, OpenAI Codex,
and OpenCode. These are the five highest-adoption individually named
coding agents in the [JetBrains May-July 2026 survey report](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/);
the report also lists a combined JetBrains AI/Junie category, which is
not a single agent. Display order is not rank order.

[sample-agents.ts](src/scripts/sample-agents.ts) is shared by the static
diagram and the results renderer. Connector branches and the profile
count derive from that roster. Results use one row per agent, with
invented pass/fail/skipped outcomes that respect the criteria chain.
The playground does not claim that all sample agents are supported
Scope integrations; the supported-agent links remain separate.

Playback runs once when the playground enters view. Users can pause,
reset, replay, select a scenario, or inspect any step with a button.
Leaving the viewport or hiding the tab stops playback. Reduced-motion
users get manual **Next step** controls and no animated connectors.
Without JavaScript, the static diagram and explanation remain visible,
and nonfunctional playback controls stay hidden.

### Review findings and recommendations

The September 2026 review covered all 29 handwritten pages, navigation
into the generated API reference, onboarding, landing design, motion,
themes, responsive layout, and GitHub Pages paths. It was a UX and
documentation review, not an endpoint-by-endpoint API correctness audit.

| Finding in the previous site | Change |
| --- | --- |
| Abstract hero and repetitive feature sections made the value hard to grasp. | Concrete product framing, an explorable example, and three evidence-focused cards. |
| Static agent scores looked like real comparative claims and did not explain the flow. | Clearly fictional scenarios with inspectable stages and dependency-aware outcomes. |
| A flat list of 14 guides mixed onboarding, configuration, and advanced integrations. | Task-oriented groups with advanced sections collapsed initially. |
| Hard-coded root links escaped a GitHub Pages project base. | Base-aware Astro links, a Markdown/MDX transform, and project-path PR builds. |
| Seven API-reference links pointed to a nonexistent operations index. | Links now target the generated API landing page. |
| The custom hero hid Starlight's skip-link destination. | One visible heading with the native `_top` anchor and a homepage-only title override. |
| The glossary described an optional DAG and included copy errors. | DAG-only terminology, corrected prose, and capability cross-links. |
| The custom install-directory example set the variable on the downloader, not the installer. | Apply `SCOPE_INSTALL_DIR` to the receiving `bash` process. |

Recommended content follow-ups:

- Reconcile the VS Code capability matrix with the documented worker
  ID policy. The introduction and reference currently describe three
  agents, while the worker ID list names only two. The landing's
  supported-agent strip names only the two documented ACP workers;
  its separately labeled fictional playground includes five examples.
- Walk the first-run guide against a current deployment, then add
  maintained screenshots. Its claims about preseeded catalogs, model
  availability, and UI labels should not be assumed for every deployment.
- Explain release-repository access during CLI onboarding. The legacy
  `growth-ecosystems/scope-doc` reference is still used by the installer
  and publishing workflow, so changing it just because the documentation
  moved would be incorrect. A release migration is a separate change.
- Add a real, reproducible sample-results walkthrough when an approved
  dataset is available. Keep real evidence separate from the playground.

## Learn more

- [Astro docs](https://docs.astro.build)
- [Starlight docs](https://starlight.astro.build/)
- [starlight-openapi](https://starlight-openapi.vercel.app/)
