/**
 * Short-term memory implementation using conversation buffer
 * Keeps track of messages within a single session
 */

import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
} from "@langchain/core/messages";

export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ShortTermMemoryConfig {
  maxMessages: number;
  sessionId: string;
  systemPrompt?: string;
}

export class ShortTermMemory {
  private messages: ConversationEntry[] = [];
  private config: ShortTermMemoryConfig;

  constructor(config: ShortTermMemoryConfig) {
    this.config = config;
  }

  /**
   * Add a message to the conversation history
   */
  addMessage(
    role: "user" | "assistant" | "system",
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date(),
      metadata,
    });

    // Trim if exceeding max messages (but keep system prompt if present)
    this.trimToLimit();
  }

  /**
   * Add a user message
   */
  addUserMessage(content: string, metadata?: Record<string, unknown>): void {
    this.addMessage("user", content, metadata);
  }

  /**
   * Add an assistant message
   */
  addAssistantMessage(
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.addMessage("assistant", content, metadata);
  }

  /**
   * Get all messages as LangChain BaseMessage array
   */
  getMessages(): BaseMessage[] {
    const langchainMessages: BaseMessage[] = [];

    // Add system prompt first if configured
    if (this.config.systemPrompt) {
      langchainMessages.push(new SystemMessage(this.config.systemPrompt));
    }

    // Convert stored messages to LangChain format
    for (const msg of this.messages) {
      if (msg.role === "user") {
        langchainMessages.push(new HumanMessage(msg.content));
      } else if (msg.role === "assistant") {
        langchainMessages.push(new AIMessage(msg.content));
      } else if (msg.role === "system") {
        langchainMessages.push(new SystemMessage(msg.content));
      }
    }

    return langchainMessages;
  }

  /**
   * Get raw conversation entries
   */
  getRawMessages(): ConversationEntry[] {
    return [...this.messages];
  }

  /**
   * Get conversation summary (last N messages as text)
   */
  getSummary(lastN: number = 5): string {
    const recentMessages = this.messages.slice(-lastN);
    return recentMessages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");
  }

  /**
   * Get the session ID
   */
  getSessionId(): string {
    return this.config.sessionId;
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Trim messages to stay within limit
   * Keeps the most recent messages
   */
  private trimToLimit(): void {
    if (this.messages.length > this.config.maxMessages) {
      // Keep the most recent messages
      const excess = this.messages.length - this.config.maxMessages;
      this.messages = this.messages.slice(excess);
    }
  }

  /**
   * Export conversation for persistence
   */
  export(): { sessionId: string; messages: ConversationEntry[] } {
    return {
      sessionId: this.config.sessionId,
      messages: [...this.messages],
    };
  }

  /**
   * Import conversation from persistence
   */
  import(data: { messages: ConversationEntry[] }): void {
    this.messages = data.messages.map((msg) => ({
      ...msg,
      timestamp: new Date(msg.timestamp),
    }));
  }
}

/**
 * Factory function to create short-term memory with defaults
 */
export function createShortTermMemory(
  sessionId: string,
  options?: Partial<ShortTermMemoryConfig>,
): ShortTermMemory {
  return new ShortTermMemory({
    sessionId,
    maxMessages: options?.maxMessages ?? 50,
    systemPrompt: options?.systemPrompt,
  });
}
