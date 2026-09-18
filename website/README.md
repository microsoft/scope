# scope-doc

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

End-user documentation site for **Scope**, built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
and published to GitHub Pages.

The product and this documentation site live in
[microsoft/scope](https://github.com/microsoft/scope). Users and contributors
should start at the [official documentation website](https://microsoft.github.io/scope/).

The root README is a short introduction and entry point to the website.
Keep detailed setup, usage, and contribution guidance in
[src/content/docs/](src/content/docs/) and register new pages in the sidebar.
Local setup lives in
[getting-started/local-development.md](src/content/docs/getting-started/local-development.md);
development, contribution, and support guidance live under
[resources/](src/content/docs/resources/).

## Project structure

```
.
├── public/                          # static assets
├── src/
│   ├── assets/
│   ├── content/docs/                # all user-facing pages (.md / .mdx)
│   │   ├── introduction/
│   │   ├── getting-started/
│   │   ├── guides/
│   │   ├── reference/
│   │   └── resources/
│   ├── openapi/scope-openapi.json   # artifact generated from the API registry
│   ├── plugins/
│   │   ├── remark-base-path.mjs    # applies the deployment base to internal links
│   │   └── remark-http-snippets.mjs # turns ```http blocks into multi-language tabs
│   └── content.config.ts
├── astro.config.mjs                 # sidebar, plugins, starlight-openapi config
├── AGENTS.md                        # conventions & guardrails for contributors / AI agents
├── package.json
└── tsconfig.json
```

Sidebar order is defined in `astro.config.mjs`, not by directory order.

## Commands

Run these commands from `website/`. The site has its own
[package.json](package.json) and [pnpm-lock.yaml](pnpm-lock.yaml), separate
from the root pnpm workspace.

| Command                | Action                                                     |
| :--------------------- | :--------------------------------------------------------- |
| `pnpm install`         | Install dependencies                                       |
| `pnpm dev`             | Start local dev server at `localhost:4321`                 |
| `pnpm build`           | Build the production site to `./dist/`                     |
| `pnpm preview`         | Preview the production build locally                       |
| `pnpm test`            | Test site plugins with Node's built-in test runner          |
| `pnpm refresh:openapi` | Generate the OpenAPI snapshot from this monorepo's API |

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
  routes or schemas. It runs `pnpm --filter api generate:openapi` from the
  repository root, using [apps/api/src/openapi/generate.ts](../apps/api/src/openapi/generate.ts)
  in this same `microsoft/scope` checkout. Install the root workspace
  dependencies first; the generator updates
  [src/openapi/scope-openapi.json](src/openapi/scope-openapi.json).

See [AGENTS.md](AGENTS.md) for conventions, the source-of-truth
policy (everything factual must be grounded in this checkout's source),
and where to look in the monorepo for any given topic.

## Deployment

Pushed builds deploy to GitHub Pages via
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

## Learn more

- [Astro docs](https://docs.astro.build)
- [Starlight docs](https://starlight.astro.build/)
- [starlight-openapi](https://starlight-openapi.vercel.app/)
