/**
 * Project Memory - Long-term memory for AI agents focused on project knowledge
 * Uses Redis as primary storage with SQLite fallback
 * Supports GitHub Models API for embeddings (with OpenAI fallback)
 */

import {
  MemoryStorage,
  ProjectMemoryEntry,
  MemorySearchOptions,
} from "./storage-interface.js";
import { RedisStorage, RedisStorageConfig } from "./redis-storage.js";
import { SqliteStorage, SqliteStorageConfig } from "./sqlite-storage.js";
import {
  GitHubModelsClient,
  createGitHubModelsClient,
} from "../providers/github-models.js";

// Optional OpenAI import for fallback
let OpenAIEmbeddings: any;
try {
  const langchainOpenai = await import("@langchain/openai");
  OpenAIEmbeddings = langchainOpenai.OpenAIEmbeddings;
} catch {
  // OpenAI not available, will use GitHub Models
}

export interface ProjectMemoryConfig {
  projectId: string;

  // GitHub Models configuration (primary for embeddings)
  githubToken?: string;
  embeddingModel?: string;

  // Legacy OpenAI configuration (fallback)
  openaiApiKey?: string;

  // Redis configuration (primary storage)
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;

  // SQLite configuration (fallback storage)
  sqlitePath?: string;

  // Embedding configuration
  enableEmbeddings?: boolean;

  // Storage limits
  maxMemories?: number;
  ttlDays?: number;
}

interface EmbeddingProvider {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments?(texts: string[]): Promise<number[][]>;
}

export class ProjectMemory {
  private storage: MemoryStorage;
  private embeddings?: EmbeddingProvider;
  private config: ProjectMemoryConfig;
  private storageType: "redis" | "sqlite";
  private embeddingProvider: "github-models" | "openai" | "none";

  private constructor(
    storage: MemoryStorage,
    storageType: "redis" | "sqlite",
    config: ProjectMemoryConfig,
    embeddings?: EmbeddingProvider,
    embeddingProvider: "github-models" | "openai" | "none" = "none",
  ) {
    this.storage = storage;
    this.storageType = storageType;
    this.config = config;
    this.embeddings = embeddings;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Create a ProjectMemory instance - tries Redis first, falls back to SQLite
   * Uses GitHub Models for embeddings, with OpenAI fallback
   */
  static async create(config: ProjectMemoryConfig): Promise<ProjectMemory> {
    const fullConfig: ProjectMemoryConfig = {
      sqlitePath: "./data/project-memory.db",
      enableEmbeddings: true,
      embeddingModel: "openai/text-embedding-3-small",
      maxMemories: 10000,
      ttlDays: 90,
      ...config,
    };

    let embeddings: EmbeddingProvider | undefined;
    let embeddingProvider: "github-models" | "openai" | "none" = "none";

    if (fullConfig.enableEmbeddings) {
      // Try GitHub Models first
      if (fullConfig.githubToken) {
        try {
          const client = createGitHubModelsClient(fullConfig.githubToken, {
            embeddingModel: fullConfig.embeddingModel,
          });
          embeddings = client;
          embeddingProvider = "github-models";
          console.log(
            `[ProjectMemory] Using GitHub Models for embeddings (${fullConfig.embeddingModel})`,
          );
        } catch (error) {
          console.warn(
            "[ProjectMemory] GitHub Models embeddings failed:",
            (error as Error).message,
          );
        }
      }

      // Fallback to OpenAI if GitHub Models not available
      if (!embeddings && fullConfig.openaiApiKey && OpenAIEmbeddings) {
        try {
          embeddings = new OpenAIEmbeddings({
            modelName: "text-embedding-3-small",
            openAIApiKey: fullConfig.openaiApiKey,
          });
          embeddingProvider = "openai";
          console.log("[ProjectMemory] Using OpenAI for embeddings (fallback)");
        } catch (error) {
          console.warn(
            "[ProjectMemory] OpenAI embeddings failed:",
            (error as Error).message,
          );
        }
      }

      if (!embeddings) {
        console.warn(
          "[ProjectMemory] No embedding provider available, semantic search disabled",
        );
      }
    }

    // Try Redis first for storage
    if (fullConfig.redisUrl || fullConfig.redisHost) {
      try {
        const redisConfig: RedisStorageConfig = {
          projectId: fullConfig.projectId,
          redisUrl: fullConfig.redisUrl,
          redisHost: fullConfig.redisHost,
          redisPort: fullConfig.redisPort,
          redisPassword: fullConfig.redisPassword,
          redisDb: fullConfig.redisDb,
          maxMemories: fullConfig.maxMemories,
          ttlDays: fullConfig.ttlDays,
        };

        const redisStorage = new RedisStorage(redisConfig);

        // Wait for connection with timeout
        const isConnected = await redisStorage.waitForConnection(3000);

        if (isConnected && (await redisStorage.isAvailable())) {
          console.log(
            `[ProjectMemory] Using Redis storage for project: ${fullConfig.projectId}`,
          );
          return new ProjectMemory(
            redisStorage,
            "redis",
            fullConfig,
            embeddings,
            embeddingProvider,
          );
        } else {
          console.warn(
            "[ProjectMemory] Redis not available, falling back to SQLite",
          );
          await redisStorage.close();
        }
      } catch (error) {
        console.warn(
          "[ProjectMemory] Redis connection failed, falling back to SQLite:",
          (error as Error).message,
        );
      }
    }

    // Fallback to SQLite
    const sqliteConfig: SqliteStorageConfig = {
      projectId: fullConfig.projectId,
      dbPath: fullConfig.sqlitePath!,
      maxMemories: fullConfig.maxMemories,
      ttlDays: fullConfig.ttlDays,
    };

    const sqliteStorage = new SqliteStorage(sqliteConfig);
    console.log(
      `[ProjectMemory] Using SQLite storage for project: ${fullConfig.projectId}`,
    );
    return new ProjectMemory(
      sqliteStorage,
      "sqlite",
      fullConfig,
      embeddings,
      embeddingProvider,
    );
  }

  /**
   * Get the storage type being used
   */
  getStorageType(): "redis" | "sqlite" {
    return this.storageType;
  }

  /**
   * Get the embedding provider being used
   */
  getEmbeddingProvider(): "github-models" | "openai" | "none" {
    return this.embeddingProvider;
  }

  /**
   * Store project knowledge
   */
  async store(
    content: string,
    type: ProjectMemoryEntry["type"],
    options?: {
      importance?: number;
      metadata?: Record<string, unknown>;
      tags?: string[];
    },
  ): Promise<string> {
    let embedding: number[] | undefined;
    if (this.embeddings) {
      try {
        embedding = await this.embeddings.embedQuery(content);
      } catch (error) {
        console.warn(
          "[ProjectMemory] Failed to generate embedding:",
          (error as Error).message,
        );
      }
    }

    return this.storage.store({
      projectId: this.config.projectId,
      content,
      type,
      importance: options?.importance ?? 0.5,
      embedding,
      metadata: options?.metadata,
      tags: options?.tags,
    });
  }

  /**
   * Store project context (architecture, patterns, etc.)
   */
  async storeContext(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "context", { importance: 0.7, tags });
  }

  /**
   * Store architecture decision
   */
  async storeArchitecture(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "architecture", { importance: 0.8, tags });
  }

  /**
   * Store a pattern or best practice
   */
  async storePattern(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "pattern", { importance: 0.7, tags });
  }

  /**
   * Store a decision record
   */
  async storeDecision(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "decision", { importance: 0.8, tags });
  }

  /**
   * Store a dependency/tool info
   */
  async storeDependency(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "dependency", { importance: 0.6, tags });
  }

  /**
   * Store configuration info
   */
  async storeConfig(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "config", { importance: 0.6, tags });
  }

  /**
   * Store a todo/task
   */
  async storeTodo(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "todo", { importance: 0.5, tags });
  }

  /**
   * Store an issue/problem
   */
  async storeIssue(content: string, tags?: string[]): Promise<string> {
    return this.store(content, "issue", { importance: 0.7, tags });
  }

  /**
   * Search memories by semantic similarity
   */
  async search(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<ProjectMemoryEntry[]> {
    if (this.embeddings) {
      try {
        const embedding = await this.embeddings.embedQuery(query);
        return this.storage.searchByEmbedding(embedding, options);
      } catch (error) {
        console.warn(
          "[ProjectMemory] Embedding search failed, falling back to keyword:",
          (error as Error).message,
        );
      }
    }
    return this.storage.searchByKeyword(query, options);
  }

  /**
   * Get memories by type
   */
  async getByType(
    type: ProjectMemoryEntry["type"],
    limit?: number,
  ): Promise<ProjectMemoryEntry[]> {
    return this.storage.getByType(type, limit);
  }

  /**
   * Get memories by tags
   */
  async getByTags(
    tags: string[],
    limit?: number,
  ): Promise<ProjectMemoryEntry[]> {
    return this.storage.getByTags(tags, limit);
  }

  /**
   * Get recent memories
   */
  async getRecent(limit?: number): Promise<ProjectMemoryEntry[]> {
    return this.storage.getRecent(limit);
  }

  /**
   * Get important memories
   */
  async getImportant(limit?: number): Promise<ProjectMemoryEntry[]> {
    return this.storage.getImportant(limit);
  }

  /**
   * Get context for a query - combines semantic search with important memories
   */
  async getContextForQuery(query: string): Promise<string> {
    const relevantMemories = await this.search(query, { limit: 5 });
    const importantMemories = await this.getImportant(3);

    // Deduplicate
    const seen = new Set<string>();
    const allMemories: ProjectMemoryEntry[] = [];

    for (const mem of [...relevantMemories, ...importantMemories]) {
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        allMemories.push(mem);
      }
    }

    if (allMemories.length === 0) {
      return "";
    }

    const contextParts = [`Project knowledge for "${this.config.projectId}":`];
    for (const mem of allMemories) {
      const tags = mem.tags?.length ? ` [${mem.tags.join(", ")}]` : "";
      contextParts.push(`- [${mem.type}]${tags} ${mem.content}`);
    }

    return contextParts.join("\n");
  }

  /**
   * Update a memory
   */
  async update(
    id: string,
    updates: Partial<
      Pick<ProjectMemoryEntry, "content" | "importance" | "metadata" | "tags">
    >,
  ): Promise<void> {
    return this.storage.update(id, updates);
  }

  /**
   * Delete a memory
   */
  async delete(id: string): Promise<void> {
    return this.storage.delete(id);
  }

  /**
   * Get memory count
   */
  async getCount(): Promise<number> {
    return this.storage.getCount();
  }

  /**
   * Clear all project memories
   */
  async clear(): Promise<void> {
    return this.storage.clear();
  }

  /**
   * Close storage connection
   */
  async close(): Promise<void> {
    return this.storage.close();
  }

  /**
   * Check if storage is available
   */
  async isAvailable(): Promise<boolean> {
    return this.storage.isAvailable();
  }
}

/**
 * Factory function to create project memory
 */
export async function createProjectMemory(
  projectId: string,
  options?: Partial<Omit<ProjectMemoryConfig, "projectId">>,
): Promise<ProjectMemory> {
  return ProjectMemory.create({
    projectId,
    ...options,
  });
}
