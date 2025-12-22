# ts-memory-agent

AI Agent with persistent **project memory** - an MCP server for OpenCode that
remembers important project knowledge across sessions.

## Features

- **MCP Server**: Integrates with OpenCode to provide persistent project memory
- **GitHub Models API**: Uses GitHub's hosted AI models for embeddings
- **Multi-Project**: One server handles multiple projects via `projectId`
  parameter
- **Persistent Storage**: Redis (primary) with automatic SQLite fallback
- **Semantic Search**: Find relevant knowledge using embeddings
- **Knowledge Types**: Architecture, patterns, decisions, dependencies, configs,
  todos, issues
- **REST API**: Express server for programmatic access
- **CLI Demo**: Interactive command-line interface for testing

## Quick Start with OpenCode

### 1. Clone and Build

```bash
git clone https://github.com/cjazinski/ts-memory-agent.git
cd ts-memory-agent
npm install
npm run build
```

### 2. Configure Environment

Create a `.env` file in the project root:

```env
# GitHub Models API Token (required)
# Get from: GitHub Settings > Developer Settings > Personal access tokens
# Needs 'models:read' permission
GITHUB_TOKEN=your-github-token

# Embedding model (optional)
EMBEDDING_MODEL=openai/text-embedding-3-small

# Storage (SQLite by default, Redis optional)
SQLITE_PATH=./data/project-memory.db
# REDIS_URL=redis://localhost:6379
```

### 3. Add to OpenCode Configuration

Add to your `opencode.json`:

```json
{
  "mcp": {
    "project-memory": {
      "type": "local",
      "command": ["node", "/path/to/ts-memory-agent/dist/mcp-server.js"],
      "enabled": true,
      "environment": {
        "GITHUB_TOKEN": "your-github-token",
        "SQLITE_PATH": "/path/to/ts-memory-agent/data/project-memory.db"
      }
    }
  }
}
```

Or use npx (after publishing):

```json
{
  "mcp": {
    "project-memory": {
      "type": "local",
      "command": ["npx", "ts-memory-agent"],
      "enabled": true,
      "environment": {
        "GITHUB_TOKEN": "your-github-token"
      }
    }
  }
}
```

## MCP Tools

Once configured, OpenCode has access to these tools:

### `memory_get_context`

**Call this when starting work on a project** to retrieve stored knowledge.

```
projectId: "my-app"
query: "authentication" (optional - focus on specific topic)
limit: 10 (optional)
```

Returns important and recent knowledge about the project.

### `memory_store`

**Save important findings while working** - architecture decisions, patterns,
issues, etc.

```
projectId: "my-app"
content: "Using JWT tokens with 24h expiration for API auth"
type: "architecture" | "pattern" | "decision" | "dependency" | "config" | "todo" | "issue" | "context"
importance: 0.8 (0-1, higher = shown first)
tags: ["auth", "security"] (optional)
```

### `memory_search`

Search for specific knowledge.

```
projectId: "my-app"
query: "database configuration"
limit: 5
```

### `memory_list`

List knowledge filtered by type or importance.

```
projectId: "my-app"
filter: "important" | "recent" | "byType" | "byTags"
type: "architecture" (when filter is "byType")
tags: ["auth"] (when filter is "byTags")
```

### `memory_forget`

Remove outdated or incorrect knowledge.

```
projectId: "my-app"
id: "knowledge-entry-id"
```

## Workflow Example

**Session 1 - Initial work on my-app:**

```
OpenCode: Let me check what I know about this project...
[calls memory_get_context with projectId: "my-app"]
→ No stored knowledge yet.

OpenCode: I see you're using Express with TypeScript. Let me store that.
[calls memory_store with content: "Express.js REST API with TypeScript", type: "architecture"]

OpenCode: The auth uses JWT with refresh tokens.
[calls memory_store with content: "JWT auth with refresh tokens, 15min access / 7d refresh", type: "architecture", tags: ["auth"]]
```

**Session 2 - Returning to my-app:**

```
OpenCode: Let me retrieve what I know about this project...
[calls memory_get_context with projectId: "my-app"]
→ Returns:
  1. [architecture] Express.js REST API with TypeScript
  2. [architecture] JWT auth with refresh tokens, 15min access / 7d refresh

OpenCode: I remember this is an Express API with JWT auth. How can I help today?
```

## Getting a GitHub Token

1. Go to
   [GitHub Settings > Developer Settings > Personal access tokens](https://github.com/settings/tokens)
2. Create a new token (classic or fine-grained)
3. For fine-grained tokens, ensure the `models:read` permission is enabled
4. Copy the token and add it to your `.env` file

## CLI Demo

Run the interactive demo to test the memory system:

```bash
npm run dev my-project
```

Commands:

- Type a message to chat
- `/knowledge` - View stored project knowledge
- `/store <type> <content>` - Store knowledge manually
- `/search <query>` - Search project knowledge
- `/clear` - Clear conversation history
- `/new` - Start a new session
- `quit` - Exit

## REST API

Start the API server:

```bash
npm run serve
```

### Endpoints

| Method | Endpoint                      | Description                |
| ------ | ----------------------------- | -------------------------- |
| POST   | `/chat`                       | Send message, get response |
| GET    | `/knowledge/:projectId`       | Get project knowledge      |
| POST   | `/knowledge/:projectId`       | Store knowledge            |
| GET    | `/stats/:projectId`           | Get project stats          |
| DELETE | `/session/:sessionId`         | Clear session              |
| POST   | `/session/:projectId/new`     | Start new session          |
| GET    | `/session/:sessionId/history` | Get conversation history   |
| GET    | `/health`                     | Health check               |

## Architecture

```
src/
├── mcp-server.ts             # MCP server for OpenCode
├── providers/
│   ├── github-models.ts      # GitHub Models API client
│   └── index.ts
├── memory/
│   ├── storage-interface.ts  # Abstract MemoryStorage interface
│   ├── redis-storage.ts      # Redis implementation
│   ├── sqlite-storage.ts     # SQLite implementation
│   ├── project-memory.ts     # Storage wrapper with fallback
│   ├── short-term.ts         # Conversation buffer
│   └── index.ts
├── agent/
│   ├── memory-agent.ts       # Full agent with chat + memory
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

## Development

```bash
# Build
npm run build

# Run MCP server directly
npm run mcp

# Run MCP server in dev mode
npm run mcp:dev

# Run CLI demo
npm run dev my-project

# Run API server
npm run serve
```

## License

MIT
