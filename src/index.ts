/**
 * ts-memory-agent - AI Agent with Project Memory
 * Uses GitHub Models API with Redis/SQLite storage
 *
 * Main entry point and exports
 */

import dotenv from "dotenv";
dotenv.config();

// Re-export everything
export * from "./memory/index.js";
export * from "./agent/index.js";
export * from "./providers/index.js";
export { startServer } from "./api/index.js";

// CLI demo
import { createMemoryAgent } from "./agent/index.js";
import readline from "readline";

async function runDemo() {
  console.log("=".repeat(60));
  console.log("  Project Memory Agent Demo");
  console.log("  An AI assistant that remembers project knowledge");
  console.log("  Powered by GitHub Models API");
  console.log("=".repeat(60));
  console.log();

  // Get project ID from command line argument
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("Error: Project ID is required as the first argument");
    console.log("\nUsage: npm run dev <project-id>");
    console.log("       npx tsx src/index.ts <project-id>");
    console.log("\nExamples:");
    console.log("  npm run dev my-app");
    console.log("  npm run dev frontend-project");
    console.log("  npx tsx src/index.ts backend-api");
    process.exit(1);
  }

  const githubToken =
    process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!githubToken && !openaiKey) {
    console.error(
      "Error: GITHUB_TOKEN or OPENAI_API_KEY environment variable is required",
    );
    console.log("Create a .env file with: GITHUB_TOKEN=your-token-here");
    console.log(
      "Get a token with 'models:read' permission from GitHub Settings",
    );
    process.exit(1);
  }

  console.log(`Creating agent for project: ${projectId}`);

  const agent = await createMemoryAgent(projectId, {
    // GitHub Models (primary)
    githubToken,
    chatModel: process.env.CHAT_MODEL || "openai/gpt-4o-mini",
    embeddingModel:
      process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
    // OpenAI (fallback)
    openaiApiKey: openaiKey,
    // Redis
    redisUrl: process.env.REDIS_URL,
    redisHost: process.env.REDIS_HOST,
    redisPort: process.env.REDIS_PORT
      ? parseInt(process.env.REDIS_PORT)
      : undefined,
    redisPassword: process.env.REDIS_PASSWORD,
    // SQLite
    sqlitePath: process.env.SQLITE_PATH || "./data/project-memory.db",
    systemPrompt: `You are an AI assistant with project memory capabilities.
You remember important information about projects including:
- Architecture decisions and patterns
- Dependencies and configurations
- Known issues and solutions
- Best practices specific to this project

Be helpful and demonstrate awareness of the project context.
Keep responses concise but informative.`,
  });

  console.log(`Provider: ${agent.getProvider()}`);
  console.log(`Model: ${agent.getChatModel()}`);
  console.log(`Storage: ${agent.getStorageType()}`);
  console.log(`Session ID: ${agent.getSessionId()}`);
  console.log(`Existing knowledge: ${await agent.getKnowledgeCount()}`);
  console.log();
  console.log('Type your message and press Enter. Type "quit" to exit.');
  console.log('Type "/knowledge" to see stored project knowledge.');
  console.log('Type "/store <type> <content>" to manually store knowledge.');
  console.log('Type "/search <query>" to search knowledge.');
  console.log('Type "/clear" to clear conversation history.');
  console.log('Type "/new" to start a new session.');
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();

      if (
        trimmed.toLowerCase() === "quit" ||
        trimmed.toLowerCase() === "exit"
      ) {
        console.log("\nGoodbye! Project knowledge has been saved.");
        await agent.close();
        rl.close();
        return;
      }

      if (trimmed === "/knowledge") {
        const knowledge = await agent.getImportantKnowledge(10);
        console.log("\n--- Project Knowledge ---");
        if (knowledge.length === 0) {
          console.log("No knowledge stored yet.");
        } else {
          for (const item of knowledge) {
            const tags = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
            console.log(`  [${item.type}]${tags} ${item.content}`);
          }
        }
        console.log("-".repeat(25) + "\n");
        prompt();
        return;
      }

      if (trimmed.startsWith("/store ")) {
        const parts = trimmed.slice(7).split(" ");
        const type = parts[0] as any;
        const content = parts.slice(1).join(" ");
        if (!content) {
          console.log("Usage: /store <type> <content>");
          console.log(
            "Types: context, architecture, dependency, config, pattern, decision, todo, issue",
          );
        } else {
          await agent.storeKnowledge(content, type);
          console.log(`\n[Stored: ${content}]\n`);
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/search ")) {
        const query = trimmed.slice(8);
        const results = await agent.searchKnowledge(query, 5);
        console.log("\n--- Search Results ---");
        if (results.length === 0) {
          console.log("No matching knowledge found.");
        } else {
          for (const item of results) {
            console.log(`  [${item.type}] ${item.content}`);
          }
        }
        console.log("-".repeat(22) + "\n");
        prompt();
        return;
      }

      if (trimmed === "/clear") {
        agent.clearSession();
        console.log("\n[Session cleared]\n");
        prompt();
        return;
      }

      if (trimmed === "/new") {
        const newSessionId = agent.newSession();
        console.log(`\n[New session started: ${newSessionId}]\n`);
        prompt();
        return;
      }

      if (!trimmed) {
        prompt();
        return;
      }

      try {
        console.log("\nAssistant: Thinking...");
        const response = await agent.chat(trimmed);

        // Move cursor up and clear "Thinking..." line
        process.stdout.write("\x1b[1A\x1b[2K");
        console.log(`Assistant: ${response.content}`);

        if (
          response.memoryExtracted &&
          response.extractedKnowledge &&
          response.extractedKnowledge.length > 0
        ) {
          console.log(
            `\n  [Learned: ${response.extractedKnowledge.join("; ")}]`,
          );
        }
        console.log();
      } catch (error) {
        console.error("\nError:", (error as Error).message);
        console.log();
      }

      prompt();
    });
  };

  prompt();
}

// Run demo if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo().catch(console.error);
}
