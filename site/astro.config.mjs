// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  site: "https://sui-mcp.vercel.app",
  integrations: [
    starlight({
      title: "sui-mcp",
      description:
        "A read-only MCP server that gives an AI assistant on-chain investigation tools for Sui. It holds no wallet and no keys.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/0xfreak0/sui-mcp" }],
      // Built-in search, indexed at build time.
      pagefind: true,
      // A broken internal link or heading anchor fails the build.
      plugins: [starlightLinksValidator()],
      // Labels the reference/tools/ sidebar group; see the file.
      routeMiddleware: "./src/routeData.ts",
      // Table cells wrap long text so tables fit the content column.
      customCss: ["./src/styles/custom.css"],
      // In reading order: prev/next links follow it from Getting started to Project.
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "start" } }] },
        { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "How to read results", items: [{ autogenerate: { directory: "concepts" } }] },
        // The Tools subgroup starts collapsed; it opens on its own pages.
        { label: "Reference", items: [{ autogenerate: { directory: "reference", collapsed: true } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
    }),
  ],
});
