/**
 * Storage interface for long-term memory
 * Allows swapping between Redis and SQLite backends
 */

export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  content: string;
  type:
    | "context"
    | "architecture"
    | "dependency"
    | "config"
    | "pattern"
    | "decision"
    | "todo"
    | "issue";
  importance: number; // 0-1 score
  embedding?: number[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
  accessCount: number;
  ttl?: number; // Time to live in seconds (optional)
}

export interface StorageConfig {
  projectId: string;
  enableEmbeddings?: boolean;
  embeddingModel?: string;
  maxMemories?: number;
  ttlDays?: number;
}

export interface MemorySearchOptions {
  limit?: number;
  type?: ProjectMemoryEntry["type"];
  tags?: string[];
  minImportance?: number;
}

/**
 * Abstract storage interface - implemented by Redis and SQLite
 */
export interface MemoryStorage {
  /**
   * Store a memory entry
   */
  store(
    entry: Omit<
      ProjectMemoryEntry,
      "id" | "createdAt" | "updatedAt" | "accessCount"
    >,
  ): Promise<string>;

  /**
   * Get a memory by ID
   */
  get(id: string): Promise<ProjectMemoryEntry | null>;

  /**
   * Search memories by embedding similarity
   */
  searchByEmbedding(
    embedding: number[],
    options?: MemorySearchOptions,
  ): Promise<ProjectMemoryEntry[]>;

  /**
   * Search memories by keyword
   */
  searchByKeyword(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<ProjectMemoryEntry[]>;

  /**
   * Get memories by type
   */
  getByType(
    type: ProjectMemoryEntry["type"],
    limit?: number,
  ): Promise<ProjectMemoryEntry[]>;

  /**
   * Get memories by tags
   */
  getByTags(tags: string[], limit?: number): Promise<ProjectMemoryEntry[]>;

  /**
   * Get recent memories
   */
  getRecent(limit?: number): Promise<ProjectMemoryEntry[]>;

  /**
   * Get important memories (high importance score)
   */
  getImportant(limit?: number): Promise<ProjectMemoryEntry[]>;

  /**
   * Update a memory entry
   */
  update(
    id: string,
    updates: Partial<
      Pick<ProjectMemoryEntry, "content" | "importance" | "metadata" | "tags">
    >,
  ): Promise<void>;

  /**
   * Increment access count (for tracking usage)
   */
  incrementAccess(id: string): Promise<void>;

  /**
   * Delete a memory
   */
  delete(id: string): Promise<void>;

  /**
   * Get total count of memories for project
   */
  getCount(): Promise<number>;

  /**
   * Clear all memories for project
   */
  clear(): Promise<void>;

  /**
   * Close connection/cleanup
   */
  close(): Promise<void>;

  /**
   * Check if storage is available/connected
   */
  isAvailable(): Promise<boolean>;
}
