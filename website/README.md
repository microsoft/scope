# scope-doc

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

End-user documentation site for **Scope**, built with
[Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
and published to GitHub Pages.

The product and this documentation site live in
[scope-core](https://github.com/growth-ecosystems/scope-core).

## Project structure

```
.
├── public/                          # static assets
├── src/
│   ├── assets/
│   ├── components/community/        # article/talk lists + landing teaser
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
| `pnpm dev`             | Start local dev server at `localhost:4321`                 |
| `pnpm build`           | Build the production site to `./dist/`                     |
| `pnpm preview`         | Preview the production build locally                       |
| `pnpm test`            | Test site plugins with Node's built-in test runner          |
| `pnpm test:build`      | Test rendered Markdown/MDX tables in `dist/` after a build |
| `pnpm refresh:openapi` | Generate the OpenAPI snapshot from `scope-core` |

## Authoring docs

- Use `.md` for plain Markdown, `.mdx` whenever the page contains JSX
  (e.g. Starlight `<Tabs>`).
- Use standard pipe-delimited Markdown tables in both `.md` and `.mdx`.
  Keep `markdown.gfm: true` explicit in [astro.config.mjs](astro.config.mjs):
  the installed MDX integration does not inherit Astro's Markdown processor
  defaults, so otherwise MDX tables render as plain text.
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
pnpm test:build
SITE=https://microsoft.github.io BASE_PATH=/scope pnpm preview
```

Open `/scope/` on the preview server. Keep `BASE_PATH` the same for the
build and preview so assets, navigation, and search use the same URLs.
CI runs `pnpm test:build` after building to catch table-rendering regressions
in both Markdown and MDX pages.

## Learn more

- [Astro docs](https://docs.astro.build)
- [Starlight docs](https://starlight.astro.build/)
- [starlight-openapi](https://starlight-openapi.vercel.app/)
