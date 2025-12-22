/**
 * Long-term memory implementation using SQLite for persistence
 * and optional vector embeddings for semantic search
 */

import Database from "better-sqlite3";
import { OpenAIEmbeddings } from "@langchain/openai";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";

export interface MemoryEntry {
  id: string;
  userId: string;
  content: string;
  type: "fact" | "preference" | "interaction" | "entity" | "summary";
  importance: number; // 0-1 score
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  accessCount: number;
}

export interface LongTermMemoryConfig {
  dbPath: string;
  userId: string;
  enableEmbeddings: boolean;
  embeddingModel?: string;
  maxMemories?: number;
  ttlDays?: number;
}

export class LongTermMemory {
  private db: Database.Database;
  private config: LongTermMemoryConfig;
  private embeddings?: OpenAIEmbeddings;

  constructor(config: LongTermMemoryConfig) {
    this.config = {
      maxMemories: 10000,
      ttlDays: 90,
      ...config,
    };

    // Ensure data directory exists
    const dbDir = path.dirname(config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(config.dbPath);
    this.initializeDatabase();

    if (config.enableEmbeddings) {
      this.embeddings = new OpenAIEmbeddings({
        modelName: config.embeddingModel ?? "text-embedding-3-small",
      });
    }
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        embedding TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
    `);
  }

  /**
   * Store a new memory
   */
  async store(
    content: string,
    type: MemoryEntry["type"],
    options?: {
      importance?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<string> {
    const id = uuidv4();
    const now = new Date().toISOString();

    let embedding: number[] | undefined;
    if (this.embeddings) {
      embedding = await this.embeddings.embedQuery(content);
    }

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, user_id, content, type, importance, embedding, metadata, created_at, updated_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      id,
      this.config.userId,
      content,
      type,
      options?.importance ?? 0.5,
      embedding ? JSON.stringify(embedding) : null,
      options?.metadata ? JSON.stringify(options.metadata) : null,
      now,
      now,
    );

    // Check and enforce memory limits
    await this.enforceMemoryLimits();

    return id;
  }

  /**
   * Search memories by semantic similarity
   */
  async search(query: string, limit: number = 5): Promise<MemoryEntry[]> {
    if (!this.embeddings) {
      // Fall back to keyword search
      return this.keywordSearch(query, limit);
    }

    const queryEmbedding = await this.embeddings.embedQuery(query);

    // Get all memories with embeddings for this user
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE user_id = ? AND embedding IS NOT NULL
      ORDER BY importance DESC, access_count DESC
      LIMIT 100
    `);

    const rows = stmt.all(this.config.userId) as any[];

    // Calculate cosine similarity
    const scored = rows.map((row) => {
      const embedding = JSON.parse(row.embedding) as number[];
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      return { row, similarity };
    });

    // Sort by similarity and take top results
    scored.sort((a, b) => b.similarity - a.similarity);
    const topResults = scored.slice(0, limit);

    // Update access counts
    for (const { row } of topResults) {
      this.incrementAccessCount(row.id);
    }

    return topResults.map(({ row }) => this.rowToMemoryEntry(row));
  }

  /**
   * Keyword-based search fallback
   */
  private keywordSearch(query: string, limit: number): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE user_id = ? AND content LIKE ?
      ORDER BY importance DESC, access_count DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.userId, `%${query}%`, limit) as any[];

    // Update access counts
    for (const row of rows) {
      this.incrementAccessCount(row.id);
    }

    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  /**
   * Get memories by type
   */
  getByType(type: MemoryEntry["type"], limit: number = 10): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE user_id = ? AND type = ?
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.userId, type, limit) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  /**
   * Get recent memories
   */
  getRecent(limit: number = 10): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.userId, limit) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  /**
   * Get important memories
   */
  getImportant(limit: number = 10): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE user_id = ?
      ORDER BY importance DESC, access_count DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.userId, limit) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  /**
   * Update memory importance
   */
  updateImportance(id: string, importance: number): void {
    const stmt = this.db.prepare(`
      UPDATE memories 
      SET importance = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `);
    stmt.run(importance, new Date().toISOString(), id, this.config.userId);
  }

  /**
   * Delete a memory
   */
  delete(id: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM memories WHERE id = ? AND user_id = ?
    `);
    stmt.run(id, this.config.userId);
  }

  /**
   * Get memory count for user
   */
  getCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM memories WHERE user_id = ?
    `);
    const result = stmt.get(this.config.userId) as { count: number };
    return result.count;
  }

  /**
   * Get context string for agent prompts
   */
  async getContextForQuery(query: string): Promise<string> {
    const relevantMemories = await this.search(query, 5);
    const importantMemories = this.getImportant(3);

    // Deduplicate
    const seen = new Set<string>();
    const allMemories: MemoryEntry[] = [];

    for (const mem of [...relevantMemories, ...importantMemories]) {
      if (!seen.has(mem.id)) {
        seen.add(mem.id);
        allMemories.push(mem);
      }
    }

    if (allMemories.length === 0) {
      return "";
    }

    const contextParts = ["Relevant information from long-term memory:"];
    for (const mem of allMemories) {
      contextParts.push(`- [${mem.type}] ${mem.content}`);
    }

    return contextParts.join("\n");
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  // Helper methods

  private incrementAccessCount(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), id);
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

  private rowToMemoryEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      userId: row.user_id,
      content: row.content,
      type: row.type as MemoryEntry["type"],
      importance: row.importance,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      accessCount: row.access_count,
    };
  }

  private async enforceMemoryLimits(): Promise<void> {
    const count = this.getCount();
    const maxMemories = this.config.maxMemories ?? 10000;

    if (count > maxMemories) {
      // Delete oldest, least important memories
      const toDelete = count - maxMemories + 100; // Delete a batch to avoid frequent cleanup
      const stmt = this.db.prepare(`
        DELETE FROM memories 
        WHERE id IN (
          SELECT id FROM memories 
          WHERE user_id = ?
          ORDER BY importance ASC, access_count ASC, created_at ASC
          LIMIT ?
        )
      `);
      stmt.run(this.config.userId, toDelete);
    }

    // Delete expired memories
    if (this.config.ttlDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.ttlDays);

      const stmt = this.db.prepare(`
        DELETE FROM memories 
        WHERE user_id = ? AND created_at < ? AND importance < 0.8
      `);
      stmt.run(this.config.userId, cutoffDate.toISOString());
    }
  }
}

/**
 * Factory function to create long-term memory
 */
export function createLongTermMemory(
  userId: string,
  options?: Partial<Omit<LongTermMemoryConfig, "userId">>,
): LongTermMemory {
  return new LongTermMemory({
    userId,
    dbPath: options?.dbPath ?? "./data/memory.db",
    enableEmbeddings: options?.enableEmbeddings ?? true,
    embeddingModel: options?.embeddingModel,
    maxMemories: options?.maxMemories,
    ttlDays: options?.ttlDays,
  });
}
