/**
 * Memory module exports
 */

// Short-term memory (conversation buffer)
export {
  ShortTermMemory,
  createShortTermMemory,
  type ConversationEntry,
  type ShortTermMemoryConfig,
} from "./short-term.js";

// Storage interface and types
export {
  type MemoryStorage,
  type ProjectMemoryEntry,
  type StorageConfig,
  type MemorySearchOptions,
} from "./storage-interface.js";

// Redis storage
export { RedisStorage, type RedisStorageConfig } from "./redis-storage.js";

// SQLite storage
export { SqliteStorage, type SqliteStorageConfig } from "./sqlite-storage.js";

// Project memory (Redis with SQLite fallback)
export {
  ProjectMemory,
  createProjectMemory,
  type ProjectMemoryConfig,
} from "./project-memory.js";

// Legacy exports for backward compatibility
export {
  LongTermMemory,
  createLongTermMemory,
  type MemoryEntry,
  type LongTermMemoryConfig,
} from "./long-term.js";
