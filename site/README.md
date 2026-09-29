# sui-mcp docs site

The documentation site for sui-mcp, built with [Astro Starlight](https://starlight.astro.build). It has its own `package.json` and lockfile. The root npm package publishes only `dist/`, so nothing in `site/` ships with the server.

## Local development

```bash
cd site
npm install
npm run dev
```

The dev server runs at http://localhost:4321. `npm run build` writes the static site to `site/dist/` and `npm run preview` serves it.

The build fails on a broken internal link or heading anchor ([starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator)). Search is Starlight's built-in Pagefind index, built with the site.

## Layout

| Path | Contents |
|---|---|
| `astro.config.mjs` | Site title, GitHub link, sidebar, plugins |
| `src/content/docs/index.mdx` | Front page |
| `src/content/docs/start/` | Sidebar group "Getting started" |
| `src/content/docs/guides/` | Sidebar group "Guides" |
| `src/content/docs/concepts/` | Sidebar group "How to read results" |
| `src/content/docs/reference/` | Sidebar group "Reference" |
| `src/content/docs/project/` | Sidebar group "Project" |
| `src/content/docs/reference/tools/`, `src/content/docs/reference/prompts.md` | Generated tool and prompt reference. Do not edit by hand. |
| `scripts/gen-tools.mjs` | Generator for the reference pages |
| `scripts/tool-reference.mjs` | Tool groups and page rendering, shared with the root test |
| `src/routeData.ts` | Labels the `reference/tools/` sidebar group |
| `vercel.json` | Vercel project settings |

The sidebar groups are generated from the directories. Every page needs `title` and `description` in its frontmatter; `sidebar.order` sets its position within the directory.

`npm run lint:prose` at the repo root checks every page under `src/content/docs/` except the generated reference.

## Regenerating the tool reference

The reference pages are generated from the built server and committed, so the site builds without building the server first.

```bash
npm run build        # at the repo root
cd site
npm run gen:tools
```

`gen:tools` starts `../dist/index.js` with `SUI_TOOLS=all`, reads `tools/list` and `prompts/list` with the MCP SDK client from the root `node_modules`, and rewrites `src/content/docs/reference/tools/` and `src/content/docs/reference/prompts.md`. It stops with an error when `../dist/index.js` is missing.

Run it after changing a tool's name, description or parameters, or a prompt, and commit the result. The root `npm test` includes `test/site-tool-reference.test.ts`, which fails while the committed pages differ from what the current source would generate.

A new tool has to be added to a group in `GROUPS` in `scripts/tool-reference.mjs`. Until it is, the generator and the test fail and name the tool.

## Vercel

`vercel.json` sets the framework to Astro and an `ignoreCommand`. The command skips a deployment when nothing under `site/` changed since the last successful deployment on the branch (`VERCEL_GIT_PREVIOUS_SHA`). When that commit is unknown or missing from the clone, the deployment builds.

The site needs no environment variables and no files outside `site/`.

One-time setup, done by the repository owner:

1. Install the Vercel GitHub app with access to this repository only ("Only select repositories"), then import `0xfreak0/sui-mcp` as a new Vercel project.
2. Set Root Directory to `site`. Leave the build, output and install commands at their defaults; the framework preset comes from `vercel.json`.
3. Set the production branch to `main`.
4. Keep Git Fork Protection on (Project Settings, Git), so a pull request from a fork needs approval before it deploys.
5. Add no environment variables.
6. Enable Deployment Protection (Vercel Authentication) for preview deployments.
7. Turn on two-factor authentication for the Vercel account.

`astro.config.mjs` does not set `site` yet. Set it to the production URL once the domain is decided; Starlight then adds canonical URLs and a sitemap.
