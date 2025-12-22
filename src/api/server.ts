/**
 * Express API server for the Project Memory Agent
 */

import express, { Request, Response, NextFunction } from "express";
import { createMemoryAgent, MemoryAgent } from "../agent/index.js";
import { ProjectMemoryEntry } from "../memory/storage-interface.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Store active agents by project/session
const agents = new Map<string, MemoryAgent>();

// Get or create agent for a project/session
async function getOrCreateAgent(
  projectId: string,
  sessionId?: string,
): Promise<MemoryAgent> {
  const key = sessionId || projectId;

  if (!agents.has(key)) {
    const agent = await createMemoryAgent(projectId, {
      sessionId,
      // GitHub Models (primary)
      githubToken: process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN,
      chatModel: process.env.CHAT_MODEL || "openai/gpt-4o-mini",
      embeddingModel:
        process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
      // OpenAI (fallback)
      openaiApiKey: process.env.OPENAI_API_KEY,
      // Redis
      redisUrl: process.env.REDIS_URL,
      redisHost: process.env.REDIS_HOST,
      redisPort: process.env.REDIS_PORT
        ? parseInt(process.env.REDIS_PORT)
        : undefined,
      redisPassword: process.env.REDIS_PASSWORD,
      // SQLite
      sqlitePath: process.env.SQLITE_PATH || "./data/project-memory.db",
    });
    agents.set(key, agent);
  }

  return agents.get(key)!;
}

// Error handler middleware
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  console.error("Error:", err);
  res.status(500).json({
    error: err.message || "Internal server error",
  });
}

/**
 * POST /chat
 * Send a message and get a response
 * Body: { projectId: string, message: string, sessionId?: string }
 */
app.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, message, sessionId } = req.body;

    if (!projectId || !message) {
      res.status(400).json({ error: "projectId and message are required" });
      return;
    }

    const agent = await getOrCreateAgent(projectId, sessionId);
    const response = await agent.chat(message);

    res.json({
      success: true,
      response: response.content,
      sessionId: response.sessionId,
      memoryExtracted: response.memoryExtracted,
      extractedKnowledge: response.extractedKnowledge,
      storageType: agent.getStorageType(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /knowledge/:projectId
 * Get project knowledge
 * Query params: type (important|recent|search|byType|byTags), query, memoryType, tags, limit
 */
app.get(
  "/knowledge/:projectId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const {
        type = "important",
        query,
        memoryType,
        tags,
        limit = "10",
      } = req.query;

      const agent = await getOrCreateAgent(projectId);
      let knowledge: ProjectMemoryEntry[] = [];

      switch (type) {
        case "search":
          if (!query) {
            res
              .status(400)
              .json({ error: "query parameter required for search" });
            return;
          }
          knowledge = await agent.searchKnowledge(
            query as string,
            parseInt(limit as string),
          );
          break;
        case "recent":
          knowledge = await agent.getRecentKnowledge(parseInt(limit as string));
          break;
        case "byType":
          if (!memoryType) {
            res.status(400).json({ error: "memoryType parameter required" });
            return;
          }
          knowledge = await agent.getKnowledgeByType(
            memoryType as ProjectMemoryEntry["type"],
            parseInt(limit as string),
          );
          break;
        case "byTags":
          if (!tags) {
            res
              .status(400)
              .json({ error: "tags parameter required (comma-separated)" });
            return;
          }
          const tagList = (tags as string).split(",").map((t) => t.trim());
          knowledge = await agent.getKnowledgeByTags(
            tagList,
            parseInt(limit as string),
          );
          break;
        case "important":
        default:
          knowledge = await agent.getImportantKnowledge(
            parseInt(limit as string),
          );
          break;
      }

      res.json({
        success: true,
        projectId,
        type,
        count: knowledge.length,
        storageType: agent.getStorageType(),
        knowledge,
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /knowledge/:projectId
 * Store project knowledge
 * Body: { content: string, type?: string, importance?: number, tags?: string[] }
 */
app.post(
  "/knowledge/:projectId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const { content, type = "context", importance = 0.5, tags } = req.body;

      if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
      }

      const agent = await getOrCreateAgent(projectId);
      const knowledgeId = await agent.storeKnowledge(content, type, {
        importance,
        tags,
      });

      res.json({
        success: true,
        knowledgeId,
        projectId,
        storageType: agent.getStorageType(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /session/:sessionId
 * Clear a session's conversation history
 */
app.delete(
  "/session/:sessionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      if (agents.has(sessionId)) {
        const agent = agents.get(sessionId)!;
        agent.clearSession();
        res.json({
          success: true,
          message: `Session ${sessionId} cleared`,
        });
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /session/:projectId/new
 * Create a new session for a project
 */
app.post(
  "/session/:projectId/new",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const agent = await getOrCreateAgent(projectId);
      const newSessionId = agent.newSession();

      // Update the agents map with new session key
      agents.set(newSessionId, agent);

      res.json({
        success: true,
        projectId,
        sessionId: newSessionId,
        storageType: agent.getStorageType(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /session/:sessionId/history
 * Get conversation history for a session
 */
app.get(
  "/session/:sessionId/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      if (agents.has(sessionId)) {
        const agent = agents.get(sessionId)!;
        const history = agent.getConversationHistory();
        res.json({
          success: true,
          sessionId,
          messageCount: history.length,
          history,
        });
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /stats/:projectId
 * Get knowledge stats for a project
 */
app.get(
  "/stats/:projectId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { projectId } = req.params;
      const agent = await getOrCreateAgent(projectId);

      res.json({
        success: true,
        projectId,
        knowledgeCount: await agent.getKnowledgeCount(),
        sessionId: agent.getSessionId(),
        storageType: agent.getStorageType(),
        provider: agent.getProvider(),
        chatModel: agent.getChatModel(),
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    activeSessions: agents.size,
  });
});

// Apply error handler
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;

export function startServer(port: number = PORT as number) {
  return app.listen(port, () => {
    console.log(`Project Memory Agent API running on http://localhost:${port}`);
    console.log("\nAvailable endpoints:");
    console.log("  POST   /chat                     - Send a message");
    console.log("  GET    /knowledge/:projectId     - Get project knowledge");
    console.log("  POST   /knowledge/:projectId     - Store project knowledge");
    console.log("  DELETE /session/:sessionId       - Clear session");
    console.log("  POST   /session/:projectId/new   - Start new session");
    console.log(
      "  GET    /session/:sessionId/history - Get conversation history",
    );
    console.log("  GET    /stats/:projectId         - Get knowledge stats");
    console.log("  GET    /health                   - Health check");
  });
}

// Export app for testing
export { app };

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
