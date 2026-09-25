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
│   ├── components/                  # Astro landing, interactive example, header, page title
│   │   └── community/               # article/talk lists + landing teaser
│   ├── content/
│   │   ├── docs/                    # all user-facing pages (.md / .mdx)
│   │   │   ├── introduction/
│   │   │   ├── getting-started/
│   │   │   ├── guides/
│   │   │   ├── reference/
│   │   │   ├── resources/
│   │   │   └── community/
│   │   ├── articles/                # one YAML per published article
│   │   └── talks/                   # one YAML per talk
│   ├── openapi/scope-openapi.json   # artifact generated from the API registry
│   ├── plugins/
│   │   ├── remark-base-path.mjs    # applies the deployment base to internal links
│   │   └── remark-http-snippets.mjs # turns ```http blocks into multi-language tabs
│   ├── scripts/flow-demo.ts         # progressive-enhancement example controller
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
| `pnpm test`            | Test site plugins with Node's built-in test runner          |
| `pnpm refresh:openapi` | Generate the OpenAPI snapshot from `scope-core` |

## Authoring docs

- Use `.md` for plain Markdown, `.mdx` whenever the page contains JSX
  (e.g. Starlight `<Tabs>`).
- Write internal Markdown links and literal MDX `href`/`src` attributes
  relative to the site root, such as `/getting-started/access/`.
  [src/plugins/remark-base-path.mjs](src/plugins/remark-base-path.mjs)
  adds the configured base path at build time. Do not hard-code `/scope`
  in content. External URLs, relative links, fragments, and code examples
  are left unchanged.
- Link to `/reference/api/` for the generated API reference landing page.
  `/reference/api/operations/` has endpoint pages beneath it, but no index.
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

- To list a new article or talk on the Community page, add one YAML
  file under `src/content/articles/` or `src/content/talks/`. See
  "Articles & talks" in [AGENTS.md](AGENTS.md) for the fields.

See [AGENTS.md](AGENTS.md) for conventions, the source-of-truth
policy (everything factual must be grounded in scope-core), and
where to look in scope-core for any given topic.

## Deployment

Changes merged to `main` deploy to GitHub Pages via
[../.github/workflows/static.yml](../.github/workflows/static.yml).
The workflow builds from this `website/` directory (via a
`working-directory` default and `website/**` path filters). Both pull-request
and production builds use `SITE=https://microsoft.github.io` and
`BASE_PATH=/scope`, matching the public
[documentation URL](https://microsoft.github.io/scope/).
`actions/configure-pages` still configures deployment, but its reported
hostname and base path are not used to generate URLs: it can report an
isolated Pages hostname instead of the public project URL.

Local development defaults to the site root (`/`). To reproduce the
public deployment locally, run these commands from `website/`:

```sh
pnpm test
SITE=https://microsoft.github.io BASE_PATH=/scope pnpm build
SITE=https://microsoft.github.io BASE_PATH=/scope pnpm preview
```


Open `/scope/` on the preview server. Keep `BASE_PATH` the same for the
build and preview so assets, navigation, and search use the same URLs.
Use the production preview to exercise Pagefind search; its index is
generated at build time.

Author Markdown links as `/getting-started/access/`, for example.
The base-path remark plugin prefixes Markdown links, reference
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
- **Motion:** limited to the silent showreel and the interactive
  example, with pause controls and reduced-motion support. The logo
  and documentation chrome remain still.

### Showreel

The supplied Scope showreel plays in a framed 16:9 player below the
hero calls to action, so the headline stays clean and the footage is
shown without an overlay. The local [video](public/scope-showreel.mp4)
is re-encoded as H.264 at half the original speed (30 seconds instead
of 15), with the audio track removed and metadata moved to the front
for web playback. It loops, is always muted, and plays inline on
mobile. A visually hidden caption describes the scenes it shows.

[showreel.ts](src/scripts/showreel.ts) starts playback when at least a
quarter of the player is visible. A keyboard-accessible button pauses
or resumes it. Scrolling it out of view or hiding the tab pauses
playback; an explicit user pause persists when returning. The button
overlays the bottom corner of the video, and moves below it on narrow
screens so it does not cover the footage.

Reduced-motion visitors see the [poster](public/scope-showreel-poster.jpg),
taken from the closing Scope title card, without downloading the video
until they choose to play it. Without JavaScript, the poster remains
visible and the playback button stays hidden. Blocked autoplay offers
manual playback; media failures display a status message and log the
error. Both media URLs use the configured deployment base.

### Interactive example

[FlowDemo.astro](src/components/FlowDemo.astro) renders the full diagram
and an initial task prompt as static HTML.
[flow-demo.ts](src/scripts/flow-demo.ts) progressively enhances it using
a custom element. It makes no network requests and adds no framework
or animation-library dependencies.

One task-board example illustrates task submission, a base profile with
two alternate profiles, evaluation gates, and per-criterion evidence.
There is no scenario picker: the task and criteria stay fixed throughout
the walkthrough. Outcomes, token counts, and durations are labeled as
simulations, not measurements or agent rankings.

The heading and navigation use **Interactive example**, with a neutral
**Mock data** badge and **No agents run here** explanation at the top.
There is no glowing status indicator, and profile cards say **Example
profile**, not "Ready", "Working", or "Complete". Playback controls
explicitly describe an animation, not an agent execution.

The single example is shared by the static diagram and the controller.
The diagram's result bars reflect each profile's passed-gate count, and
the results table uses the same fixture. There is no scenario-switching
state or change-summary panel.

The availability strip identifies GitHub Copilot and Claude Code as
**Supported today**, OpenAI Codex and OpenCode as **Planned**, and Cursor
as **Not integrated**. Planned agents have no promised release date and
do not appear in the simulated executions.

[sample-agents.ts](src/scripts/sample-agents.ts) separates availability
from the fictional profiles. The base uses Copilot, Var 1 adds a task
skill with the same agent and model, and Var 2 changes the agent and
model to Claude Code. All use the same task and criteria. Connector
branches and profile counts derive from this shared profile list.

The judge step distinguishes **gates** from the reusable **criteria
library**. Requirements, Build, and Test are sequential gates. An
optional **Explore the criteria graph** disclosure shows the graph
inside each gate, including two independent checks that depend on
"Tests execute". The graph is collapsed by default to keep the
homepage introduction approachable.

[flow-demo-data.ts](src/scripts/flow-demo-data.ts) owns the invented
fixtures and derives consistent gate and criterion outcomes: failing
a gate skips later gates, while failing a criterion skips its
descendants, not its siblings. The results table compares each
variation with the base, showing gates passed, input/output and total
tokens, elapsed run duration, and signed token/time differences.
Duration describes the fictional run, not the animation. Lower usage
or shorter duration is not presented as a win when the run failed.
Per-criterion outcomes remain available in a separate disclosure.

Playback runs once when the example enters view. Users can pause,
reset, replay, or inspect any step with a button.
Leaving the viewport or hiding the tab stops playback. Reduced-motion
users get manual **Next step** controls and no animated connectors.
Without JavaScript, the static diagram and explanation remain visible,
and nonfunctional playback controls stay hidden.

The example data tests use the monorepo's existing Vitest runner.
After installing root and website dependencies, run from the repo root:

```sh
pnpm exec vitest run --config website/vitest.config.ts
```

The website has its own test configuration because its standalone
Astro dependencies are not part of the root pnpm workspace install.

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
  the interactive example separates them from planned or unavailable
  integrations and runs fictional profiles of supported agents only.
- Walk the first-run guide against a current deployment, then add
  maintained screenshots. Its claims about preseeded catalogs, model
  availability, and UI labels should not be assumed for every deployment.
- Explain release-repository access during CLI onboarding. The legacy
  `growth-ecosystems/scope-doc` reference is still used by the installer
  and publishing workflow, so changing it just because the documentation
  moved would be incorrect. A release migration is a separate change.
- Add a real, reproducible sample-results walkthrough when an approved
  dataset is available. Keep real evidence separate from the example.

## Learn more

- [Astro docs](https://docs.astro.build)
- [Starlight docs](https://starlight.astro.build/)
- [starlight-openapi](https://starlight-openapi.vercel.app/)
