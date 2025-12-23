/**
 * Redis storage implementation for project memory
 * Uses Redis with JSON support for storing memory entries
 */

import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import {
  MemoryStorage,
  ProjectMemoryEntry,
  StorageConfig,
  MemorySearchOptions,
} from "./storage-interface.js";

export interface RedisStorageConfig extends StorageConfig {
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  redisDb?: number;
  keyPrefix?: string;
}

export class RedisStorage implements MemoryStorage {
  private redis: Redis;
  private config: RedisStorageConfig;
  private keyPrefix: string;
  private connected: boolean = false;

  constructor(config: RedisStorageConfig) {
    this.config = {
      maxMemories: 10000,
      ttlDays: 90,
      keyPrefix: "memory",
      ...config,
    };

    this.keyPrefix = `${this.config.keyPrefix}:${config.projectId}`;

    // Initialize Redis connection
    if (config.redisUrl) {
      this.redis = new Redis(config.redisUrl);
    } else {
      this.redis = new Redis({
        host: config.redisHost || "localhost",
        port: config.redisPort || 6379,
        password: config.redisPassword,
        db: config.redisDb || 0,
        retryStrategy: (times) => {
          if (times > 3) return null; // Stop retrying after 3 attempts
          return Math.min(times * 100, 3000);
        },
      });
    }

    this.redis.on("connect", () => {
      this.connected = true;
    });

    this.redis.on("error", (err) => {
      console.error("Redis connection error:", err.message);
      this.connected = false;
    });

    this.redis.on("ready", () => {
      this.connected = true;
    });
  }

  /**
   * Wait for Redis connection to be established
   * @param timeoutMs Maximum time to wait in milliseconds
   * @returns true if connected, false if timeout
   */
  async waitForConnection(timeoutMs: number = 3000): Promise<boolean> {
    // If already connected, return immediately
    if (this.connected) {
      return true;
    }

    // Check if connection is already ready
    if (this.redis.status === "ready") {
      this.connected = true;
      return true;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      const onReady = () => {
        clearTimeout(timeout);
        this.connected = true;
        resolve(true);
      };

      const onError = () => {
        clearTimeout(timeout);
        resolve(false);
      };

      this.redis.once("ready", onReady);
      this.redis.once("error", onError);
    });
  }

  private memoryKey(id: string): string {
    return `${this.keyPrefix}:entry:${id}`;
  }

  private indexKey(indexType: string): string {
    return `${this.keyPrefix}:index:${indexType}`;
  }

  private embeddingKey(id: string): string {
    return `${this.keyPrefix}:embedding:${id}`;
  }

  async store(
    entry: Omit<
      ProjectMemoryEntry,
      "id" | "createdAt" | "updatedAt" | "accessCount"
    >,
  ): Promise<string> {
    const id = uuidv4();
    const now = new Date();

    const fullEntry: ProjectMemoryEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };

    // Store the main entry
    const entryToStore = { ...fullEntry };
    delete entryToStore.embedding; // Store embedding separately

    await this.redis.set(
      this.memoryKey(id),
      JSON.stringify(entryToStore),
      "EX",
      this.config.ttlDays! * 24 * 60 * 60,
    );

    // Store embedding separately if present
    if (entry.embedding) {
      await this.redis.set(
        this.embeddingKey(id),
        JSON.stringify(entry.embedding),
        "EX",
        this.config.ttlDays! * 24 * 60 * 60,
      );
    }

    // Add to indexes
    await this.addToIndexes(fullEntry);

    // Enforce memory limits
    await this.enforceMemoryLimits();

    return id;
  }

  private async addToIndexes(entry: ProjectMemoryEntry): Promise<void> {
    const score = Date.now();

    // Index by type
    await this.redis.zadd(this.indexKey(`type:${entry.type}`), score, entry.id);

    // Index by importance (use importance as score)
    await this.redis.zadd(
      this.indexKey("importance"),
      entry.importance * 1000,
      entry.id,
    );

    // Index by time
    await this.redis.zadd(this.indexKey("recent"), score, entry.id);

    // Index by tags
    if (entry.tags) {
      for (const tag of entry.tags) {
        await this.redis.zadd(this.indexKey(`tag:${tag}`), score, entry.id);
      }
    }

    // All entries index
    await this.redis.zadd(this.indexKey("all"), score, entry.id);
  }

  private async removeFromIndexes(entry: ProjectMemoryEntry): Promise<void> {
    await this.redis.zrem(this.indexKey(`type:${entry.type}`), entry.id);
    await this.redis.zrem(this.indexKey("importance"), entry.id);
    await this.redis.zrem(this.indexKey("recent"), entry.id);
    await this.redis.zrem(this.indexKey("all"), entry.id);

    if (entry.tags) {
      for (const tag of entry.tags) {
        await this.redis.zrem(this.indexKey(`tag:${tag}`), entry.id);
      }
    }
  }

  async get(id: string): Promise<ProjectMemoryEntry | null> {
    const data = await this.redis.get(this.memoryKey(id));
    if (!data) return null;

    const entry = JSON.parse(data) as ProjectMemoryEntry;
    entry.createdAt = new Date(entry.createdAt);
    entry.updatedAt = new Date(entry.updatedAt);

    // Load embedding if exists
    const embeddingData = await this.redis.get(this.embeddingKey(id));
    if (embeddingData) {
      entry.embedding = JSON.parse(embeddingData);
    }

    return entry;
  }

  async searchByEmbedding(
    embedding: number[],
    options: MemorySearchOptions = {},
  ): Promise<ProjectMemoryEntry[]> {
    const limit = options.limit || 10;

    // Get all entry IDs that have embeddings
    let ids = await this.redis.zrevrange(this.indexKey("all"), 0, 100);

    if (options.type) {
      ids = await this.redis.zrevrange(
        this.indexKey(`type:${options.type}`),
        0,
        100,
      );
    }

    // Calculate similarities
    const scored: Array<{ id: string; similarity: number }> = [];

    for (const id of ids) {
      const embeddingData = await this.redis.get(this.embeddingKey(id));
      if (!embeddingData) continue;

      const storedEmbedding = JSON.parse(embeddingData) as number[];
      const similarity = this.cosineSimilarity(embedding, storedEmbedding);

      // Check importance threshold
      if (options.minImportance) {
        const entry = await this.get(id);
        if (entry && entry.importance < options.minImportance) continue;
      }

      scored.push({ id, similarity });
    }

    // Sort by similarity
    scored.sort((a, b) => b.similarity - a.similarity);

    // Get top results
    const results: ProjectMemoryEntry[] = [];
    for (const { id } of scored.slice(0, limit)) {
      const entry = await this.get(id);
      if (entry) {
        await this.incrementAccess(id);
        results.push(entry);
      }
    }

    return results;
  }

  async searchByKeyword(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<ProjectMemoryEntry[]> {
    const limit = options.limit || 10;
    const queryLower = query.toLowerCase();

    let ids = await this.redis.zrevrange(this.indexKey("all"), 0, 500);

    if (options.type) {
      ids = await this.redis.zrevrange(
        this.indexKey(`type:${options.type}`),
        0,
        500,
      );
    }

    const results: ProjectMemoryEntry[] = [];

    for (const id of ids) {
      if (results.length >= limit) break;

      const entry = await this.get(id);
      if (!entry) continue;

      if (options.minImportance && entry.importance < options.minImportance) {
        continue;
      }

      if (entry.content.toLowerCase().includes(queryLower)) {
        await this.incrementAccess(id);
        results.push(entry);
      }
    }

    return results;
  }

  async getByType(
    type: ProjectMemoryEntry["type"],
    limit: number = 10,
  ): Promise<ProjectMemoryEntry[]> {
    const ids = await this.redis.zrevrange(
      this.indexKey(`type:${type}`),
      0,
      limit - 1,
    );

    const results: ProjectMemoryEntry[] = [];
    for (const id of ids) {
      const entry = await this.get(id);
      if (entry) results.push(entry);
    }

    return results;
  }

  async getByTags(
    tags: string[],
    limit: number = 10,
  ): Promise<ProjectMemoryEntry[]> {
    // Get entries that have any of the specified tags
    const allIds = new Set<string>();

    for (const tag of tags) {
      const ids = await this.redis.zrevrange(
        this.indexKey(`tag:${tag}`),
        0,
        limit - 1,
      );
      ids.forEach((id) => allIds.add(id));
    }

    const results: ProjectMemoryEntry[] = [];
    for (const id of Array.from(allIds).slice(0, limit)) {
      const entry = await this.get(id);
      if (entry) results.push(entry);
    }

    return results;
  }

  async getRecent(limit: number = 10): Promise<ProjectMemoryEntry[]> {
    const ids = await this.redis.zrevrange(
      this.indexKey("recent"),
      0,
      limit - 1,
    );

    const results: ProjectMemoryEntry[] = [];
    for (const id of ids) {
      const entry = await this.get(id);
      if (entry) results.push(entry);
    }

    return results;
  }

  async getImportant(limit: number = 10): Promise<ProjectMemoryEntry[]> {
    const ids = await this.redis.zrevrange(
      this.indexKey("importance"),
      0,
      limit - 1,
    );

    const results: ProjectMemoryEntry[] = [];
    for (const id of ids) {
      const entry = await this.get(id);
      if (entry) results.push(entry);
    }

    return results;
  }

  async update(
    id: string,
    updates: Partial<
      Pick<ProjectMemoryEntry, "content" | "importance" | "metadata" | "tags">
    >,
  ): Promise<void> {
    const entry = await this.get(id);
    if (!entry) return;

    // Remove from old indexes if tags changed
    if (updates.tags) {
      await this.removeFromIndexes(entry);
    }

    const updatedEntry = {
      ...entry,
      ...updates,
      updatedAt: new Date(),
    };

    delete updatedEntry.embedding;

    await this.redis.set(
      this.memoryKey(id),
      JSON.stringify(updatedEntry),
      "KEEPTTL",
    );

    // Update importance index
    if (updates.importance !== undefined) {
      await this.redis.zadd(
        this.indexKey("importance"),
        updates.importance * 1000,
        id,
      );
    }

    // Re-add to indexes if tags changed
    if (updates.tags) {
      await this.addToIndexes({ ...entry, ...updates } as ProjectMemoryEntry);
    }
  }

  async incrementAccess(id: string): Promise<void> {
    const entry = await this.get(id);
    if (!entry) return;

    entry.accessCount++;
    entry.updatedAt = new Date();
    delete entry.embedding;

    await this.redis.set(this.memoryKey(id), JSON.stringify(entry), "KEEPTTL");
  }

  async delete(id: string): Promise<void> {
    const entry = await this.get(id);
    if (!entry) return;

    await this.removeFromIndexes(entry);
    await this.redis.del(this.memoryKey(id));
    await this.redis.del(this.embeddingKey(id));
  }

  async getCount(): Promise<number> {
    return await this.redis.zcard(this.indexKey("all"));
  }

  async clear(): Promise<void> {
    const ids = await this.redis.zrange(this.indexKey("all"), 0, -1);

    for (const id of ids) {
      await this.delete(id);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
    this.connected = false;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async enforceMemoryLimits(): Promise<void> {
    const count = await this.getCount();
    const maxMemories = this.config.maxMemories || 10000;

    if (count > maxMemories) {
      // Delete oldest, least important entries
      const toDelete = count - maxMemories + 100;

      // Get least important entries
      const ids = await this.redis.zrange(
        this.indexKey("importance"),
        0,
        toDelete - 1,
      );

      for (const id of ids) {
        await this.delete(id);
      }
    }
  }
}
