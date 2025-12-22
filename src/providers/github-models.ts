/**
 * GitHub Models API Provider
 * Provides LLM chat completions and embeddings via GitHub Models API
 * https://docs.github.com/en/rest/models
 */

export interface GitHubModelsConfig {
  token: string;
  chatModel?: string;
  embeddingModel?: string;
  apiVersion?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

const GITHUB_MODELS_BASE_URL = "https://models.github.ai/inference";
const DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const DEFAULT_API_VERSION = "2022-11-28";

/**
 * GitHub Models API Client
 */
export class GitHubModelsClient {
  private token: string;
  private chatModel: string;
  private embeddingModel: string;
  private apiVersion: string;

  constructor(config: GitHubModelsConfig) {
    this.token = config.token;
    this.chatModel = config.chatModel ?? DEFAULT_CHAT_MODEL;
    this.embeddingModel = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  }

  /**
   * Get default headers for GitHub Models API
   */
  private getHeaders(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": this.apiVersion,
      "Content-Type": "application/json",
    };
  }

  /**
   * Send a chat completion request
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<ChatCompletionResponse> {
    const model = options?.model ?? this.chatModel;

    const body: Record<string, unknown> = {
      model,
      messages,
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    const response = await fetch(`${GITHUB_MODELS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub Models API error (${response.status}): ${errorText}`,
      );
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  /**
   * Generate embeddings for text
   */
  async createEmbedding(
    input: string | string[],
    options?: {
      model?: string;
    },
  ): Promise<EmbeddingResponse> {
    const model = options?.model ?? this.embeddingModel;

    const body = {
      model,
      input: Array.isArray(input) ? input : [input],
    };

    const response = await fetch(`${GITHUB_MODELS_BASE_URL}/embeddings`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub Models API error (${response.status}): ${errorText}`,
      );
    }

    return response.json() as Promise<EmbeddingResponse>;
  }

  /**
   * Get a single embedding vector for text
   */
  async embedQuery(text: string): Promise<number[]> {
    const response = await this.createEmbedding(text);
    return response.data[0].embedding;
  }

  /**
   * Get embedding vectors for multiple texts
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const response = await this.createEmbedding(texts);
    // Sort by index to ensure correct order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  /**
   * Simple chat helper - send a message and get a response
   */
  async chat(
    userMessage: string,
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: userMessage });

    const response = await this.chatCompletion(messages, options);
    return response.choices[0]?.message?.content ?? "";
  }

  /**
   * Check if the API is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Simple test with a minimal request
      await this.chat("Hi", undefined, { maxTokens: 5 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the configured chat model
   */
  getChatModel(): string {
    return this.chatModel;
  }

  /**
   * Get the configured embedding model
   */
  getEmbeddingModel(): string {
    return this.embeddingModel;
  }
}

/**
 * Factory function to create a GitHub Models client
 */
export function createGitHubModelsClient(
  token: string,
  options?: Partial<Omit<GitHubModelsConfig, "token">>,
): GitHubModelsClient {
  return new GitHubModelsClient({
    token,
    ...options,
  });
}
