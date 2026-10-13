# sui-mcp docs site

The documentation site uses [Astro Starlight](https://starlight.astro.build).
It has its own `package.json` and lockfile. The root npm package ships what
the root `package.json` `files` field lists (`dist/` among them) and nothing
under `site/`.

## Local development

```bash
cd site
npm install
npm run dev
```

The dev server defaults to http://localhost:4321. From `site/`,
`npm run build` writes to `site/dist/` and `npm run preview` serves the build.

The build fails on a broken internal link or heading anchor ([starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator)). Search is Starlight's built-in Pagefind index, built with the site.

## Layout

| Path | Contents |
|---|---|
| `astro.config.mjs` | Site title, GitHub link, sidebar, plugins |
| `src/content/docs/index.mdx` | Front page |
| `src/content/docs/start/` | Sidebar group "Getting started" |
| `src/content/docs/examples/` | Sidebar group "Examples" |
| `src/content/docs/guides/` | Sidebar group "Guides" |
| `src/content/docs/concepts/` | Sidebar group "How to read results" |
| `src/content/docs/reference/` | Sidebar group "Reference" |
| `src/content/docs/project/` | Sidebar group "Project" |
| `src/content/docs/reference/tools/`, `src/content/docs/reference/prompts.md` | Generated tool and prompt reference, and `reference/tools/_profiles.md`, the profile list `guides/tool-profiles.mdx` imports. Do not edit by hand. |
| `src/content/docs/project/changelog.md`, `src/content/docs/project/_current-release.md` | Generated from `../CHANGELOG.md` and `../package.json`: the changelog page, and the current-release line the front page and `start/index.mdx` import. Do not edit by hand. |
| `scripts/gen-tools.mjs` | Generator for the reference pages |
| `scripts/tool-reference.mjs` | Tool groups and page rendering, shared with the root test |
| `scripts/gen-release-pages.mjs`, `scripts/release-pages.mjs` | Generator and renderer for the changelog page and the current-release line, shared with the root test |
| `src/routeData.ts` | Labels the `reference/tools/` sidebar group |
| `vercel.json` | Vercel project settings |

The sidebar groups are generated from the directories, in the order `astro.config.mjs` lists them; prev/next links follow that order. Every page needs `title` and `description` in its frontmatter; `sidebar.order` sets its position within the directory. The sidebar shows the page title; only an index page whose title is its section's name sets `sidebar.label: Overview`.

Do not put product counts or sizes in hand-written pages (tools, profiles,
prompts, coins, labels or tool-list size). Generate lists that the tool
reference owns with `gen:tools`.

`npm run lint:prose` at the repo root checks every page under `src/content/docs/` except the generated reference and changelog.

## Regenerating the tool reference

The reference pages are generated from the built server and committed, so the site builds without building the server first.

```bash
npm run build        # at the repo root
cd site
npm run gen:tools
```

`gen:tools` starts `../dist/index.js` with `SUI_TOOLS=all`, reads `tools/list` and `prompts/list` with the MCP SDK client from the root `node_modules`, imports the profiles from `../dist/tools/profiles.js`, and rewrites `src/content/docs/reference/tools/` and `src/content/docs/reference/prompts.md`. It stops with an error when `../dist/index.js` is missing.

Run it after changing a tool's name, description or parameters, a prompt, or a profile in `src/tools/profiles.ts`, and commit the result. The root `npm test` includes `test/site-tool-reference.test.ts`, which fails while the committed files differ from what the current source would generate.

A new tool has to be added to a group in `GROUPS` in `scripts/tool-reference.mjs`. Until it is, the generator and the test fail and name the tool.

`gen:tools` then runs `scripts/gen-release-pages.mjs`. It reads
`../CHANGELOG.md` and the version in `../package.json`, and rewrites
`src/content/docs/project/changelog.md` and
`src/content/docs/project/_current-release.md`. Each release gets its
summary paragraph or, if absent, the bold lead or first sentence of its
first bullet. Releases from 1.0.0 onward also link to a GitHub release;
all entries link to `CHANGELOG.md`. The generator requires a
`## X.Y.Z (date)` heading matching the package version. Regenerate after
writing the heading and setting the version. The root test detects stale
generated pages.

## Vercel

`vercel.json` sets the Astro framework and an `ignoreCommand` that skips a
deployment when nothing under the Vercel project root (`site/`) changed since
`VERCEL_GIT_PREVIOUS_SHA`. A missing or unavailable previous commit allows the
deployment to build.

The deployed site builds from files under `site/` and needs no environment
variables. Reference generation requires the root server build, root
dependencies, `CHANGELOG.md` and the root `package.json` before committing
the generated pages.

One-time setup, done by the repository owner:

1. Install the Vercel GitHub app with access to this repository only ("Only select repositories"), then import `0xfreak0/sui-mcp` as a new Vercel project.
2. Set Root Directory to `site`. Leave the build, output and install commands at their defaults; the framework preset comes from `vercel.json`.
3. Set the production branch to `main`.
4. Keep Git Fork Protection on (Project Settings, Git), so a pull request from a fork needs approval before it deploys.
5. Add no environment variables.
6. Enable Deployment Protection (Vercel Authentication) for preview deployments.
7. Turn on two-factor authentication for the Vercel account.

`astro.config.mjs` sets the production site URL to
`https://sui-mcp.vercel.app`.
