# ts-memory-agent

AI Agent with short-term and long-term memory for **project knowledge
management** using GitHub Models API and TypeScript.

## Features

- **GitHub Models API**: Uses GitHub's hosted AI models for chat and embeddings
- **Short-term Memory**: Conversation buffer that maintains context within a
  session
- **Long-term Memory**: Persistent storage with semantic search via embeddings
- **Redis + SQLite**: Uses Redis as primary storage with automatic SQLite
  fallback
- **Project-Focused**: Stores architecture decisions, patterns, dependencies,
  configs, issues, and more
- **Automatic Knowledge Extraction**: Extracts project-relevant information from
  conversations
- **REST API**: Express server for integrating with other applications
- **CLI Demo**: Interactive command-line interface for testing

## Installation

```bash
npm install
```

## Getting a GitHub Token

1. Go to
   [GitHub Settings > Developer Settings > Personal access tokens](https://github.com/settings/tokens)
2. Create a new token (classic or fine-grained)
3. For fine-grained tokens, ensure the `models:read` permission is enabled
4. Copy the token and add it to your `.env` file

## Configuration

Create a `.env` file:

```env
# GitHub Models API Token (required)
GITHUB_TOKEN=your-github-token

# Model Configuration (optional - defaults shown)
CHAT_MODEL=openai/gpt-4o-mini
EMBEDDING_MODEL=openai/text-embedding-3-small

# Project ID
PROJECT_ID=my-project

# Redis (optional - uses SQLite if not available)
REDIS_URL=redis://localhost:6379

# SQLite fallback path
SQLITE_PATH=./data/project-memory.db

# API Server
PORT=3000
```

### Available Models

GitHub Models provides access to various models. Common options:

**Chat Models:**

- `openai/gpt-4o` - Most capable
- `openai/gpt-4o-mini` - Fast and efficient (default)
- `openai/gpt-4.1` - Latest GPT-4 version

**Embedding Models:**

- `openai/text-embedding-3-small` - Fast, good quality (default)
- `openai/text-embedding-3-large` - Higher quality, larger vectors

## Usage

### CLI Demo

Run the interactive demo:

```bash
npm run dev
```

Commands in the demo:

- Type a message to chat
- `/knowledge` - View stored project knowledge
- `/store <type> <content>` - Store knowledge (types: context, architecture,
  pattern, decision, dependency, config, todo, issue)
- `/search <query>` - Search project knowledge
- `/clear` - Clear conversation history
- `/new` - Start a new session
- `quit` - Exit

### API Server

Start the API server:

```bash
npm run serve
```

### Programmatic Usage

```typescript
import { createMemoryAgent } from "ts-memory-agent";

// Create agent using GitHub Models API
const agent = await createMemoryAgent("my-project", {
  githubToken: process.env.GITHUB_TOKEN,
  chatModel: "openai/gpt-4o-mini",
  embeddingModel: "openai/text-embedding-3-small",
  sqlitePath: "./data/project-memory.db",
});

console.log(`Provider: ${agent.getProvider()}`); // 'github-models'
console.log(`Model: ${agent.getChatModel()}`); // 'openai/gpt-4o-mini'
console.log(`Storage: ${agent.getStorageType()}`); // 'redis' or 'sqlite'

// Chat with the agent about your project
const response = await agent.chat(
  "We decided to use PostgreSQL for the database because of its JSON support",
);
console.log(response.content);
// Agent extracts: architecture decision about PostgreSQL

// Store knowledge directly
await agent.storeKnowledge(
  "API uses JWT tokens with 24h expiration",
  "architecture",
  { importance: 0.9, tags: ["security", "auth"] },
);

// Convenience methods for common knowledge types
await agent.storeArchitecture(
  "Using microservices with event-driven communication",
);
await agent.storePattern("Repository pattern for data access layer");
await agent.storeDecision("Chose React over Vue for better TypeScript support");
await agent.storeDependency("express@4.18.2 - web framework");
await agent.storeConfig("NODE_ENV controls logging verbosity");
await agent.storeTodo("Add rate limiting to API endpoints");
await agent.storeIssue("Memory leak in WebSocket handler under high load");

// Search knowledge semantically
const results = await agent.searchKnowledge("database decisions");

// Get knowledge by type
const patterns = await agent.getKnowledgeByType("pattern", 10);

// Get knowledge by tags
const securityKnowledge = await agent.getKnowledgeByTags(["security"]);

// Get important knowledge
const important = await agent.getImportantKnowledge(10);

// Get recent knowledge
const recent = await agent.getRecentKnowledge(10);

// Get context for a query (useful for RAG)
const context = await agent.getContextForQuery("How does authentication work?");

// Cleanup
agent.close();
```

### Using the GitHub Models Client Directly

```typescript
import { createGitHubModelsClient } from "ts-memory-agent";

const client = createGitHubModelsClient(process.env.GITHUB_TOKEN!, {
  chatModel: "openai/gpt-4o-mini",
  embeddingModel: "openai/text-embedding-3-small",
});

// Simple chat
const response = await client.chat("What is TypeScript?");
console.log(response);

// Chat with system prompt
const response2 = await client.chat(
  "Explain async/await",
  "You are a TypeScript expert. Be concise.",
);

// Full chat completion with messages
const completion = await client.chatCompletion([
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Hello!" },
]);
console.log(completion.choices[0].message.content);

// Generate embeddings
const embedding = await client.embedQuery("Hello world");
console.log(`Embedding dimensions: ${embedding.length}`);

// Batch embeddings
const embeddings = await client.embedDocuments([
  "First document",
  "Second document",
]);
```

## API Endpoints

### POST /chat

Send a message and get a response.

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"projectId": "my-project", "message": "We use Redis for caching"}'
```

Response:

```json
{
  "success": true,
  "response": "I've noted that your project uses Redis for caching...",
  "sessionId": "uuid",
  "memoryExtracted": true,
  "extractedKnowledge": ["Project uses Redis for caching"],
  "storageType": "sqlite"
}
```

### GET /knowledge/:projectId

Get project knowledge.

Query parameters:

- `type`: `important` (default), `recent`, `search`, `byType`, or `byTags`
- `query`: Search query (required for type=search)
- `memoryType`: Knowledge type (required for type=byType)
- `tags`: Comma-separated tags (required for type=byTags)
- `limit`: Number of results (default: 10)

```bash
# Get important knowledge
curl http://localhost:3000/knowledge/my-project

# Search knowledge
curl "http://localhost:3000/knowledge/my-project?type=search&query=database"

# Get by type
curl "http://localhost:3000/knowledge/my-project?type=byType&memoryType=architecture"

# Get by tags
curl "http://localhost:3000/knowledge/my-project?type=byTags&tags=security,auth"
```

### POST /knowledge/:projectId

Manually store project knowledge.

```bash
curl -X POST http://localhost:3000/knowledge/my-project \
  -H "Content-Type: application/json" \
  -d '{"content": "API rate limit is 100 req/min", "type": "config", "importance": 0.8, "tags": ["api", "limits"]}'
```

### GET /stats/:projectId

Get knowledge stats for a project.

```bash
curl http://localhost:3000/stats/my-project
```

Response:

```json
{
  "success": true,
  "projectId": "my-project",
  "knowledgeCount": 42,
  "sessionId": "uuid",
  "storageType": "sqlite",
  "provider": "github-models",
  "chatModel": "openai/gpt-4o-mini"
}
```

### Other Endpoints

- `DELETE /session/:sessionId` - Clear session
- `POST /session/:projectId/new` - Start new session
- `GET /session/:sessionId/history` - Get conversation history
- `GET /health` - Health check

## Architecture

```
src/
├── providers/
│   ├── github-models.ts      # GitHub Models API client
│   └── index.ts
├── memory/
│   ├── storage-interface.ts  # Abstract MemoryStorage interface
│   ├── redis-storage.ts      # Redis implementation
│   ├── sqlite-storage.ts     # SQLite implementation
│   ├── project-memory.ts     # Redis-with-SQLite-fallback wrapper
│   ├── short-term.ts         # Conversation buffer (session-based)
│   └── index.ts
├── agent/
│   ├── memory-agent.ts       # Project-aware agent
│   └── index.ts
├── api/
│   ├── server.ts             # Express API
│   └── index.ts
├── index.ts                  # Main entry + CLI demo
└── server.ts                 # Server entry point
```

## Knowledge Types

| Type           | Description                            | Example                                |
| -------------- | -------------------------------------- | -------------------------------------- |
| `context`      | General project context                | "This is a B2B SaaS application"       |
| `architecture` | Architectural decisions and structure  | "Using microservices with API Gateway" |
| `dependency`   | External libraries and services        | "express@4.18.2 for HTTP server"       |
| `config`       | Configuration and environment settings | "LOG_LEVEL controls verbosity"         |
| `pattern`      | Code patterns and conventions          | "Repository pattern for data access"   |
| `decision`     | Technical decisions with rationale     | "Chose PostgreSQL for JSONB support"   |
| `todo`         | Tasks and future improvements          | "Add caching layer for user queries"   |
| `issue`        | Known issues and bugs                  | "Memory leak in WebSocket handler"     |

## How It Works

1. **User sends message** → Added to short-term memory (conversation buffer)
2. **Project context retrieved** → Semantic search finds relevant project
   knowledge
3. **LLM generates response** → Using conversation + project context via GitHub
   Models
4. **Knowledge extraction** → LLM extracts project-relevant information
5. **Knowledge stored** → New knowledge saved with embeddings and metadata

### Provider Fallback

The agent supports fallback from GitHub Models to OpenAI:

- If `GITHUB_TOKEN` is provided, uses GitHub Models API
- If only `OPENAI_API_KEY` is provided, falls back to OpenAI
- Embeddings follow the same fallback pattern

### Storage Fallback

- Tries to connect to Redis first
- Falls back to SQLite if Redis is unavailable
- Logs which storage backend is being used

## Development

```bash
# Build
npm run build

# Run CLI demo
npm run dev

# Run API server
npm run serve

# Type check
npx tsc --noEmit
```

## License

MIT
