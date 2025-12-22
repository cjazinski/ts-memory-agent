/**
 * SQLite storage implementation for project memory
 * Used as fallback when Redis is not available
 */

import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import {
  MemoryStorage,
  ProjectMemoryEntry,
  StorageConfig,
  MemorySearchOptions,
} from "./storage-interface.js";

export interface SqliteStorageConfig extends StorageConfig {
  dbPath: string;
}

export class SqliteStorage implements MemoryStorage {
  private db: Database.Database;
  private config: SqliteStorageConfig;

  constructor(config: SqliteStorageConfig) {
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
  }

  private initializeDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        embedding TEXT,
        metadata TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_project_memories_project_id ON project_memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_memories_type ON project_memories(type);
      CREATE INDEX IF NOT EXISTS idx_project_memories_importance ON project_memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_project_memories_created_at ON project_memories(created_at DESC);
    `);
  }

  async store(
    entry: Omit<
      ProjectMemoryEntry,
      "id" | "createdAt" | "updatedAt" | "accessCount"
    >,
  ): Promise<string> {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO project_memories (id, project_id, content, type, importance, embedding, metadata, tags, created_at, updated_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    stmt.run(
      id,
      entry.projectId,
      entry.content,
      entry.type,
      entry.importance,
      entry.embedding ? JSON.stringify(entry.embedding) : null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
      entry.tags ? JSON.stringify(entry.tags) : null,
      now,
      now,
    );

    // Enforce memory limits
    await this.enforceMemoryLimits();

    return id;
  }

  async get(id: string): Promise<ProjectMemoryEntry | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM project_memories WHERE id = ? AND project_id = ?
    `);

    const row = stmt.get(id, this.config.projectId) as any;
    if (!row) return null;

    return this.rowToEntry(row);
  }

  async searchByEmbedding(
    embedding: number[],
    options: MemorySearchOptions = {},
  ): Promise<ProjectMemoryEntry[]> {
    const limit = options.limit || 10;

    let query = `
      SELECT * FROM project_memories 
      WHERE project_id = ? AND embedding IS NOT NULL
    `;
    const params: any[] = [this.config.projectId];

    if (options.type) {
      query += ` AND type = ?`;
      params.push(options.type);
    }

    if (options.minImportance) {
      query += ` AND importance >= ?`;
      params.push(options.minImportance);
    }

    query += ` ORDER BY importance DESC, access_count DESC LIMIT 100`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    // Calculate cosine similarity
    const scored = rows.map((row) => {
      const storedEmbedding = JSON.parse(row.embedding) as number[];
      const similarity = this.cosineSimilarity(embedding, storedEmbedding);
      return { row, similarity };
    });

    // Sort by similarity
    scored.sort((a, b) => b.similarity - a.similarity);
    const topResults = scored.slice(0, limit);

    // Update access counts
    for (const { row } of topResults) {
      await this.incrementAccess(row.id);
    }

    return topResults.map(({ row }) => this.rowToEntry(row));
  }

  async searchByKeyword(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<ProjectMemoryEntry[]> {
    const limit = options.limit || 10;

    let sql = `
      SELECT * FROM project_memories 
      WHERE project_id = ? AND content LIKE ?
    `;
    const params: any[] = [this.config.projectId, `%${query}%`];

    if (options.type) {
      sql += ` AND type = ?`;
      params.push(options.type);
    }

    if (options.minImportance) {
      sql += ` AND importance >= ?`;
      params.push(options.minImportance);
    }

    sql += ` ORDER BY importance DESC, access_count DESC, created_at DESC LIMIT ?`;
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    // Update access counts
    for (const row of rows) {
      await this.incrementAccess(row.id);
    }

    return rows.map((row) => this.rowToEntry(row));
  }

  async getByType(
    type: ProjectMemoryEntry["type"],
    limit: number = 10,
  ): Promise<ProjectMemoryEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM project_memories 
      WHERE project_id = ? AND type = ?
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.projectId, type, limit) as any[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async getByTags(
    tags: string[],
    limit: number = 10,
  ): Promise<ProjectMemoryEntry[]> {
    // SQLite doesn't have native array support, so we search in JSON
    const placeholders = tags.map(() => `tags LIKE ?`).join(" OR ");
    const params = tags.map((tag) => `%"${tag}"%`);

    const stmt = this.db.prepare(`
      SELECT * FROM project_memories 
      WHERE project_id = ? AND (${placeholders})
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.projectId, ...params, limit) as any[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async getRecent(limit: number = 10): Promise<ProjectMemoryEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM project_memories 
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.projectId, limit) as any[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async getImportant(limit: number = 10): Promise<ProjectMemoryEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM project_memories 
      WHERE project_id = ?
      ORDER BY importance DESC, access_count DESC
      LIMIT ?
    `);

    const rows = stmt.all(this.config.projectId, limit) as any[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async update(
    id: string,
    updates: Partial<
      Pick<ProjectMemoryEntry, "content" | "importance" | "metadata" | "tags">
    >,
  ): Promise<void> {
    const setParts: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];

    if (updates.content !== undefined) {
      setParts.push("content = ?");
      params.push(updates.content);
    }

    if (updates.importance !== undefined) {
      setParts.push("importance = ?");
      params.push(updates.importance);
    }

    if (updates.metadata !== undefined) {
      setParts.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }

    if (updates.tags !== undefined) {
      setParts.push("tags = ?");
      params.push(JSON.stringify(updates.tags));
    }

    params.push(id, this.config.projectId);

    const stmt = this.db.prepare(`
      UPDATE project_memories 
      SET ${setParts.join(", ")}
      WHERE id = ? AND project_id = ?
    `);

    stmt.run(...params);
  }

  async incrementAccess(id: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE project_memories 
      SET access_count = access_count + 1, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), id);
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM project_memories WHERE id = ? AND project_id = ?
    `);
    stmt.run(id, this.config.projectId);
  }

  async getCount(): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM project_memories WHERE project_id = ?
    `);
    const result = stmt.get(this.config.projectId) as { count: number };
    return result.count;
  }

  async clear(): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM project_memories WHERE project_id = ?
    `);
    stmt.run(this.config.projectId);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async isAvailable(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private rowToEntry(row: any): ProjectMemoryEntry {
    return {
      id: row.id,
      projectId: row.project_id,
      content: row.content,
      type: row.type as ProjectMemoryEntry["type"],
      importance: row.importance,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      accessCount: row.access_count,
    };
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
      const toDelete = count - maxMemories + 100;
      const stmt = this.db.prepare(`
        DELETE FROM project_memories 
        WHERE id IN (
          SELECT id FROM project_memories 
          WHERE project_id = ?
          ORDER BY importance ASC, access_count ASC, created_at ASC
          LIMIT ?
        )
      `);
      stmt.run(this.config.projectId, toDelete);
    }

    // Delete expired memories
    if (this.config.ttlDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.ttlDays);

      const stmt = this.db.prepare(`
        DELETE FROM project_memories 
        WHERE project_id = ? AND created_at < ? AND importance < 0.8
      `);
      stmt.run(this.config.projectId, cutoffDate.toISOString());
    }
  }
}
