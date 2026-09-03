#!/usr/bin/env node
// SEOsilo as an MCP server: exposes the same clustering engine the web app
// uses (src/lib/clusterService.ts) as tools an MCP client (Claude Desktop,
// Claude Code, etc.) can call directly - no browser, no HTTP round trip.
// Runs over stdio, the standard transport for local process-spawned MCP
// servers. See README.md for how to point a client at this.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clusterPhrases, clusterSite, InvalidClusterInputError } from "../lib/clusterService";
import { SsrfBlockedError } from "../lib/urlSafety";
import type { ClusteringMethod } from "../lib/types";

const METHOD_DESCRIPTION =
  "Clustering method: 'lexical' groups by shared significant words, works fully offline and " +
  "free, but misses synonyms/paraphrases. 'embeddings' vectorizes content via OpenRouter and " +
  "groups by cosine similarity - understands synonyms, cheap and fast (one batched request). " +
  "'semantic' uses a full LLM call via OpenRouter for the most accurate, intent-aware grouping, " +
  "but is slower and more expensive on large inputs. 'embeddings' and 'semantic' both require " +
  "OPENROUTER_API_KEY to be configured on the server; 'lexical' always works.";

const MethodSchema = z.enum(["lexical", "embeddings", "semantic"]).default("lexical");

function toolError(error: unknown) {
  if (
    error instanceof InvalidClusterInputError ||
    error instanceof SsrfBlockedError ||
    error instanceof Error
  ) {
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
  return { content: [{ type: "text" as const, text: "Nieznany błąd." }], isError: true };
}

const server = new McpServer({ name: "seosilo", version: "0.1.0" });

server.registerTool(
  "cluster_phrases",
  {
    title: "Cluster keyword phrases",
    description:
      "Groups a list of SEO keyword phrases (e.g. from keyword research) into thematic clusters " +
      "(content silos). Each cluster comes back with a name, a pillar phrase, and its member " +
      "phrases - a ready-made outline for planning which pages to write and how to structure them.",
    inputSchema: {
      phrases: z
        .array(z.string())
        .min(1)
        .describe("Keyword phrases to group, one per array entry."),
      method: MethodSchema.describe(METHOD_DESCRIPTION),
      pageContext: z
        .string()
        .optional()
        .describe("Optional topic or URL to bias clustering/naming toward, e.g. 'https://example.com/blog'."),
    },
  },
  async ({ phrases, method, pageContext }) => {
    try {
      const result = await clusterPhrases(phrases, method as ClusteringMethod, pageContext);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "cluster_site",
  {
    title: "Cluster an existing site's pages",
    description:
      "Given a homepage URL, discovers the site's existing pages (via sitemap.xml, falling back " +
      "to same-origin links from the homepage, honoring robots.txt) and groups them into thematic " +
      "clusters by analyzing each page's title, meta description, headings and body text - not " +
      "just its title. Multi-page clusters come with pillar/spoke internal-linking suggestions, " +
      "and near-duplicate pages (possible keyword cannibalization) are flagged. The target must " +
      "resolve to a public address - loopback, private, and link-local networks are refused.",
    inputSchema: {
      siteUrl: z.string().describe("The site's homepage URL, e.g. https://example.com"),
      method: MethodSchema.describe(METHOD_DESCRIPTION),
    },
  },
  async ({ siteUrl, method }) => {
    try {
      const result = await clusterSite(siteUrl, method as ClusteringMethod, undefined);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SEOsilo MCP server running on stdio.");
}

main().catch((error) => {
  console.error("SEOsilo MCP server failed to start:", error);
  process.exit(1);
});
