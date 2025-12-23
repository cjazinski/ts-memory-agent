#!/usr/bin/env node
/**
 * MCP Server for Project Memory Agent
 *
 * Provides tools for OpenCode to store and retrieve project knowledge.
 * One server handles multiple projects - projectId is passed with each call.
 *
 * Tools:
 * - memory_get_context: Get relevant context for starting work on a project
 * - memory_store: Store knowledge/findings while working
 * - memory_search: Search for specific knowledge
 * - memory_list: List knowledge by type or importance
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createProjectMemory, ProjectMemory } from "./memory/project-memory.js";
import { ProjectMemoryEntry } from "./memory/storage-interface.js";
import dotenv from "dotenv";

dotenv.config();

// Cache project memory instances to avoid re-initializing
const memoryCache = new Map<string, ProjectMemory>();

// Shared configuration builder
function getMemoryConfig() {
  return {
    githubToken: process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN,
    embeddingModel:
      process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
    openaiApiKey: process.env.OPENAI_API_KEY,
    redisUrl: process.env.REDIS_URL,
    redisHost: process.env.REDIS_HOST,
    redisPort: process.env.REDIS_PORT
      ? parseInt(process.env.REDIS_PORT)
      : undefined,
    redisPassword: process.env.REDIS_PASSWORD,
    redisDb: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : undefined,
    sqlitePath: process.env.SQLITE_PATH || "./data/project-memory.db",
  };
}

async function getProjectMemory(projectId: string): Promise<ProjectMemory> {
  if (!memoryCache.has(projectId)) {
    const memory = await createProjectMemory(projectId, getMemoryConfig());
    memoryCache.set(projectId, memory);
  }
  return memoryCache.get(projectId)!;
}

// Format entries for display
function formatEntries(entries: ProjectMemoryEntry[]): string {
  if (entries.length === 0) {
    return "No knowledge found.";
  }

  return entries
    .map((entry, i) => {
      const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
      const importance = entry.importance
        ? ` (importance: ${entry.importance.toFixed(2)})`
        : "";
      return `${i + 1}. [${entry.type}]${tags}${importance}\n   ${entry.content}`;
    })
    .join("\n\n");
}

// Create MCP server
const server = new McpServer({
  name: "project-memory",
  version: "1.0.0",
});

// Tool: Get context for starting work on a project
server.tool(
  "memory_get_context",
  "Get relevant project context and knowledge to start or resume work. Call this when beginning work on a project to retrieve important architecture decisions, patterns, known issues, and other stored knowledge.",
  {
    projectId: z
      .string()
      .describe(
        "The project identifier (e.g., 'my-app', 'frontend', 'api-server')",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "Optional: specific topic or area to focus on (e.g., 'authentication', 'database schema')",
      ),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of knowledge entries to retrieve"),
  },
  async ({ projectId, query, limit }) => {
    try {
      const memory = await getProjectMemory(projectId);

      let context = `# Project Knowledge for: ${projectId}\n\n`;

      if (query) {
        // Search for specific topic
        const results = await memory.search(query, { limit: limit || 10 });
        context += `## Relevant to: "${query}"\n\n`;
        context += formatEntries(results);
      } else {
        // Get overview: important items + recent items
        const important = await memory.getImportant(
          Math.ceil((limit || 10) / 2),
        );
        const recent = await memory.getRecent(Math.floor((limit || 10) / 2));

        // Deduplicate
        const seen = new Set(important.map((e) => e.id));
        const uniqueRecent = recent.filter((e) => !seen.has(e.id));

        if (important.length > 0) {
          context += `## Important Knowledge\n\n${formatEntries(important)}\n\n`;
        }

        if (uniqueRecent.length > 0) {
          context += `## Recent Knowledge\n\n${formatEntries(uniqueRecent)}`;
        }

        if (important.length === 0 && uniqueRecent.length === 0) {
          context +=
            "No stored knowledge yet. As you work, use memory_store to save important findings.";
        }
      }

      const count = await memory.getCount();
      context += `\n\n---\nTotal stored knowledge entries: ${count}`;

      return {
        content: [{ type: "text", text: context }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error retrieving context: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool: Store knowledge while working
server.tool(
  "memory_store",
  "Store important knowledge or findings about the project. Use this to save architecture decisions, patterns discovered, dependency notes, configuration details, known issues and solutions, or any other important project information that should be remembered for future sessions.",
  {
    projectId: z.string().describe("The project identifier"),
    content: z
      .string()
      .describe("The knowledge to store - be specific and include context"),
    type: z
      .enum([
        "context", // General project context
        "architecture", // Architecture decisions and structure
        "dependency", // Dependencies, libraries, tools
        "config", // Configuration details
        "pattern", // Code patterns and conventions
        "decision", // Technical decisions made
        "todo", // Tasks to remember
        "issue", // Known issues and solutions
      ])
      .default("context")
      .describe("Type of knowledge being stored"),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.5)
      .describe(
        "Importance level from 0 to 1 (higher = more important, shown first in context)",
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        "Optional tags for categorization (e.g., ['auth', 'security'])",
      ),
  },
  async ({ projectId, content, type, importance, tags }) => {
    try {
      const memory = await getProjectMemory(projectId);

      const id = await memory.store(content, type, {
        importance: importance || 0.5,
        tags: tags,
      });

      return {
        content: [
          {
            type: "text",
            text: `Stored [${type}] knowledge for project "${projectId}":\n"${content.substring(0, 100)}${content.length > 100 ? "..." : ""}"\n\nID: ${id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error storing knowledge: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool: Search knowledge
server.tool(
  "memory_search",
  "Search project knowledge for specific topics or keywords. Use this to find previously stored information about specific aspects of the project.",
  {
    projectId: z.string().describe("The project identifier"),
    query: z
      .string()
      .describe("Search query - describe what you're looking for"),
    limit: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of results"),
  },
  async ({ projectId, query, limit }) => {
    try {
      const memory = await getProjectMemory(projectId);
      const results = await memory.search(query, { limit: limit || 5 });

      const output = `# Search Results for: "${query}"\nProject: ${projectId}\n\n${formatEntries(results)}`;

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool: List knowledge by type
server.tool(
  "memory_list",
  "List project knowledge filtered by type, tags, or get recent/important entries.",
  {
    projectId: z.string().describe("The project identifier"),
    filter: z
      .enum(["important", "recent", "byType", "byTags"])
      .default("important")
      .describe("How to filter the knowledge"),
    type: z
      .enum([
        "context",
        "architecture",
        "dependency",
        "config",
        "pattern",
        "decision",
        "todo",
        "issue",
      ])
      .optional()
      .describe("Required when filter is 'byType'"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Required when filter is 'byTags'"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of entries to return"),
  },
  async ({ projectId, filter, type, tags, limit }) => {
    try {
      const memory = await getProjectMemory(projectId);
      let entries: ProjectMemoryEntry[] = [];
      let title = "";

      switch (filter) {
        case "important":
          entries = await memory.getImportant(limit || 10);
          title = "Important Knowledge";
          break;
        case "recent":
          entries = await memory.getRecent(limit || 10);
          title = "Recent Knowledge";
          break;
        case "byType":
          if (!type) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'type' is required when filter is 'byType'",
                },
              ],
              isError: true,
            };
          }
          entries = await memory.getByType(type, limit || 10);
          title = `Knowledge of type: ${type}`;
          break;
        case "byTags":
          if (!tags || tags.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'tags' is required when filter is 'byTags'",
                },
              ],
              isError: true,
            };
          }
          entries = await memory.getByTags(tags, limit || 10);
          title = `Knowledge tagged: ${tags.join(", ")}`;
          break;
      }

      const output = `# ${title}\nProject: ${projectId}\n\n${formatEntries(entries)}`;

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing knowledge: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool: Delete/forget knowledge
server.tool(
  "memory_forget",
  "Remove stored knowledge that is no longer relevant or was incorrect.",
  {
    projectId: z.string().describe("The project identifier"),
    id: z.string().describe("The ID of the knowledge entry to remove"),
  },
  async ({ projectId, id }) => {
    try {
      const memory = await getProjectMemory(projectId);
      await memory.delete(id);

      return {
        content: [
          {
            type: "text",
            text: `Removed knowledge entry ${id} from project "${projectId}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error removing knowledge: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Test storage connection and return actual status
async function testStorageConnection(): Promise<{
  storageType: "redis" | "sqlite";
  storageLocation: string;
  embeddingProvider: "github-models" | "openai" | "none";
}> {
  // Create a temporary memory instance to test the connection
  const testMemory = await createProjectMemory(
    "__connection_test__",
    getMemoryConfig(),
  );

  const storageType = testMemory.getStorageType();
  const embeddingProvider = testMemory.getEmbeddingProvider();

  let storageLocation: string;
  if (storageType === "redis") {
    const db = process.env.REDIS_DB ? `:db${process.env.REDIS_DB}` : "";
    storageLocation =
      process.env.REDIS_URL ||
      `${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}${db}`;
  } else {
    storageLocation = process.env.SQLITE_PATH || "./data/project-memory.db";
  }

  // Clean up test instance
  await testMemory.close();

  return { storageType, storageLocation, embeddingProvider };
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Project Memory MCP Server running on stdio");

  // Test actual connection and report status
  try {
    const { storageType, storageLocation, embeddingProvider } =
      await testStorageConnection();

    const storageStatus =
      storageType === "redis"
        ? `Connected to Redis (${storageLocation})`
        : `Using SQLite (${storageLocation})`;

    const embeddingStatus =
      embeddingProvider === "github-models"
        ? "GitHub Models"
        : embeddingProvider === "openai"
          ? "OpenAI"
          : "disabled";

    console.error(`Storage: ${storageStatus}`);
    console.error(`Embeddings: ${embeddingStatus}`);
  } catch (error) {
    console.error(
      `Storage connection test failed: ${(error as Error).message}`,
    );
  }
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
