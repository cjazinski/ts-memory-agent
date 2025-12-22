/**
 * Project-aware AI Agent using GitHub Models API
 * Integrates short-term (conversation) and long-term (project knowledge) memory
 */

import { v4 as uuidv4 } from "uuid";
import {
  ShortTermMemory,
  createShortTermMemory,
} from "../memory/short-term.js";
import {
  ProjectMemory,
  createProjectMemory,
} from "../memory/project-memory.js";
import { ProjectMemoryEntry } from "../memory/storage-interface.js";
import {
  GitHubModelsClient,
  ChatMessage,
  createGitHubModelsClient,
} from "../providers/github-models.js";

export interface MemoryAgentConfig {
  projectId: string;
  sessionId?: string;

  // GitHub Models configuration (primary)
  githubToken?: string;
  chatModel?: string;
  embeddingModel?: string;

  // Legacy OpenAI configuration (fallback)
  openaiApiKey?: string;

  temperature?: number;

  // Redis configuration (primary storage)
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;

  // SQLite fallback path
  sqlitePath?: string;

  enableProjectMemory?: boolean;
  systemPrompt?: string;
  maxConversationMessages?: number;
}

export interface ChatResponse {
  content: string;
  sessionId: string;
  memoryExtracted: boolean;
  extractedKnowledge?: string[];
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant with project memory capabilities.
You remember important information about the project including:
- Architecture decisions and patterns
- Dependencies and configurations
- Known issues and solutions
- Best practices specific to this project

When relevant, reference project knowledge to provide contextually aware responses.
Be helpful, accurate, and demonstrate awareness of the project context.`;

const KNOWLEDGE_EXTRACTION_PROMPT = `Analyze the following conversation and extract any important PROJECT-RELATED information that should be remembered for future reference.

Return a JSON object with the following structure:
{
  "knowledge": [
    { 
      "content": "the knowledge to remember", 
      "type": "context|architecture|dependency|config|pattern|decision|todo|issue", 
      "importance": 0.0-1.0,
      "tags": ["optional", "tags"]
    }
  ]
}

If there's nothing important to remember, return: { "knowledge": [] }

Focus on:
- Architecture decisions or patterns discussed
- Dependencies, tools, or libraries mentioned
- Configuration details
- Coding patterns or conventions
- Technical decisions made
- Issues identified and their solutions
- TODOs or tasks mentioned

Do NOT include:
- Conversational elements
- Information already in project context
- Generic programming knowledge

Conversation:
`;

export class MemoryAgent {
  private shortTermMemory: ShortTermMemory;
  private projectMemory: ProjectMemory | null = null;
  private client: GitHubModelsClient;
  private config: MemoryAgentConfig;
  private initialized: boolean = false;

  private constructor(config: MemoryAgentConfig) {
    this.config = {
      sessionId: config.sessionId ?? uuidv4(),
      chatModel: "openai/gpt-4o-mini",
      embeddingModel: "openai/text-embedding-3-small",
      temperature: 0.7,
      sqlitePath: "./data/project-memory.db",
      enableProjectMemory: true,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxConversationMessages: 50,
      ...config,
    };

    // Determine which token to use
    const token = config.githubToken || config.openaiApiKey;
    if (!token) {
      throw new Error("Either githubToken or openaiApiKey must be provided");
    }

    // Initialize GitHub Models client
    this.client = createGitHubModelsClient(token, {
      chatModel: this.config.chatModel,
      embeddingModel: this.config.embeddingModel,
    });

    // Initialize short-term memory
    this.shortTermMemory = createShortTermMemory(this.config.sessionId!, {
      maxMessages: this.config.maxConversationMessages,
      systemPrompt: this.config.systemPrompt,
    });
  }

  /**
   * Create and initialize a MemoryAgent
   */
  static async create(config: MemoryAgentConfig): Promise<MemoryAgent> {
    const agent = new MemoryAgent(config);
    await agent.initialize();
    return agent;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize project memory if enabled
    if (this.config.enableProjectMemory) {
      this.projectMemory = await createProjectMemory(this.config.projectId, {
        redisUrl: this.config.redisUrl,
        redisHost: this.config.redisHost,
        redisPort: this.config.redisPort,
        redisPassword: this.config.redisPassword,
        sqlitePath: this.config.sqlitePath,
        githubToken: this.config.githubToken,
        embeddingModel: this.config.embeddingModel,
        // Fallback to OpenAI if no GitHub token
        openaiApiKey: this.config.openaiApiKey,
      });
    }

    this.initialized = true;
  }

  /**
   * Send a message to the agent and get a response
   */
  async chat(userMessage: string): Promise<ChatResponse> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Add user message to short-term memory
    this.shortTermMemory.addUserMessage(userMessage);

    // Build context from project memory
    let projectContext = "";
    if (this.projectMemory) {
      projectContext = await this.projectMemory.getContextForQuery(userMessage);
    }

    // Build messages for the model
    const messages = this.buildMessagesWithContext(projectContext);

    // Get response from model
    const response = await this.client.chatCompletion(messages, {
      temperature: this.config.temperature,
    });
    const assistantMessage = response.choices[0]?.message?.content ?? "";

    // Add assistant response to short-term memory
    this.shortTermMemory.addAssistantMessage(assistantMessage);

    // Extract and store project knowledge from the conversation
    let memoryExtracted = false;
    let extractedKnowledge: string[] = [];

    if (this.projectMemory) {
      const extractionResult = await this.extractAndStoreKnowledge();
      memoryExtracted = extractionResult.stored;
      extractedKnowledge = extractionResult.knowledge;
    }

    return {
      content: assistantMessage,
      sessionId: this.config.sessionId!,
      memoryExtracted,
      extractedKnowledge,
    };
  }

  /**
   * Build messages array with project context injected
   */
  private buildMessagesWithContext(projectContext: string): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // Build system prompt with project context
    let systemContent = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    if (projectContext) {
      systemContent += `\n\n${projectContext}`;
    }

    messages.push({ role: "system", content: systemContent });

    // Add conversation history
    const rawMessages = this.shortTermMemory.getRawMessages();
    for (const msg of rawMessages) {
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content });
      }
    }

    return messages;
  }

  /**
   * Extract project knowledge from recent conversation and store it
   */
  private async extractAndStoreKnowledge(): Promise<{
    stored: boolean;
    knowledge: string[];
  }> {
    if (!this.projectMemory) {
      return { stored: false, knowledge: [] };
    }

    // Get recent conversation for extraction
    const recentConversation = this.shortTermMemory.getSummary(6);

    if (!recentConversation.trim()) {
      return { stored: false, knowledge: [] };
    }

    try {
      const extractionPrompt = KNOWLEDGE_EXTRACTION_PROMPT + recentConversation;

      const response = await this.client.chatCompletion(
        [
          {
            role: "system",
            content:
              "You are a knowledge extraction assistant. Extract important project information and return valid JSON.",
          },
          {
            role: "user",
            content: extractionPrompt,
          },
        ],
        { temperature: 0 },
      );

      const content = response.choices[0]?.message?.content ?? "";

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { stored: false, knowledge: [] };
      }

      const extracted = JSON.parse(jsonMatch[0]) as {
        knowledge: Array<{
          content: string;
          type: string;
          importance: number;
          tags?: string[];
        }>;
      };

      if (!extracted.knowledge || extracted.knowledge.length === 0) {
        return { stored: false, knowledge: [] };
      }

      // Store each extracted piece of knowledge
      const storedKnowledge: string[] = [];
      for (const item of extracted.knowledge) {
        const type = this.validateMemoryType(item.type);
        await this.projectMemory.store(item.content, type, {
          importance: Math.min(1, Math.max(0, item.importance)),
          tags: item.tags,
          metadata: { extractedFrom: "conversation" },
        });
        storedKnowledge.push(item.content);
      }

      return { stored: storedKnowledge.length > 0, knowledge: storedKnowledge };
    } catch (error) {
      console.error("Error extracting knowledge:", error);
      return { stored: false, knowledge: [] };
    }
  }

  /**
   * Validate memory type or default to 'context'
   */
  private validateMemoryType(type: string): ProjectMemoryEntry["type"] {
    const validTypes = [
      "context",
      "architecture",
      "dependency",
      "config",
      "pattern",
      "decision",
      "todo",
      "issue",
    ];
    return validTypes.includes(type)
      ? (type as ProjectMemoryEntry["type"])
      : "context";
  }

  /**
   * Manually store project knowledge
   */
  async storeKnowledge(
    content: string,
    type: ProjectMemoryEntry["type"] = "context",
    options?: { importance?: number; tags?: string[] },
  ): Promise<string | null> {
    if (!this.projectMemory) {
      return null;
    }
    return this.projectMemory.store(content, type, options);
  }

  /**
   * Search project memories
   */
  async searchKnowledge(query: string, limit: number = 5) {
    if (!this.projectMemory) {
      return [];
    }
    return this.projectMemory.search(query, { limit });
  }

  /**
   * Get knowledge by type
   */
  async getKnowledgeByType(
    type: ProjectMemoryEntry["type"],
    limit: number = 10,
  ) {
    if (!this.projectMemory) {
      return [];
    }
    return this.projectMemory.getByType(type, limit);
  }

  /**
   * Get knowledge by tags
   */
  async getKnowledgeByTags(tags: string[], limit: number = 10) {
    if (!this.projectMemory) {
      return [];
    }
    return this.projectMemory.getByTags(tags, limit);
  }

  /**
   * Get all important project knowledge
   */
  async getImportantKnowledge(limit: number = 10) {
    if (!this.projectMemory) {
      return [];
    }
    return this.projectMemory.getImportant(limit);
  }

  /**
   * Get recent project knowledge
   */
  async getRecentKnowledge(limit: number = 10) {
    if (!this.projectMemory) {
      return [];
    }
    return this.projectMemory.getRecent(limit);
  }

  /**
   * Clear the current session's conversation history
   */
  clearSession(): void {
    this.shortTermMemory.clear();
  }

  /**
   * Start a new session
   */
  newSession(sessionId?: string): string {
    const newSessionId = sessionId ?? uuidv4();
    this.shortTermMemory = createShortTermMemory(newSessionId, {
      maxMessages: this.config.maxConversationMessages,
      systemPrompt: this.config.systemPrompt,
    });
    this.config.sessionId = newSessionId;
    return newSessionId;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.config.sessionId!;
  }

  /**
   * Get project ID
   */
  getProjectId(): string {
    return this.config.projectId;
  }

  /**
   * Get storage type being used (redis or sqlite)
   */
  getStorageType(): "redis" | "sqlite" | "none" {
    if (!this.projectMemory) return "none";
    return this.projectMemory.getStorageType();
  }

  /**
   * Get conversation history
   */
  getConversationHistory() {
    return this.shortTermMemory.getRawMessages();
  }

  /**
   * Get knowledge count
   */
  async getKnowledgeCount(): Promise<number> {
    if (!this.projectMemory) {
      return 0;
    }
    return this.projectMemory.getCount();
  }

  /**
   * Get the LLM provider being used
   */
  getProvider(): string {
    return "github-models";
  }

  /**
   * Get the chat model being used
   */
  getChatModel(): string {
    return this.client.getChatModel();
  }

  /**
   * Close resources
   */
  async close(): Promise<void> {
    if (this.projectMemory) {
      await this.projectMemory.close();
    }
  }
}

/**
 * Factory function to create a memory agent
 */
export async function createMemoryAgent(
  projectId: string,
  options?: Partial<Omit<MemoryAgentConfig, "projectId">>,
): Promise<MemoryAgent> {
  return MemoryAgent.create({
    projectId,
    ...options,
  });
}
