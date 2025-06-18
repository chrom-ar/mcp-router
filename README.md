# MCP Router

A Model Context Protocol (MCP) router that allows multiple MCP servers to register themselves dynamically and provides aggregated access to their tools through a unified interface.

## Features

- **Dynamic Server Registration**: MCP servers can register themselves at runtime
- **Tool Aggregation**: All registered server tools are available through a single endpoint
- **REST API**: HTTP endpoints for server management and health checks
- **MCP Tools**: Built-in router management tools accessible via MCP protocol
- **Server Status Monitoring**: Track connection status and tool availability
- **Graceful Error Handling**: Robust error handling and retry mechanisms

## Quick Start

### Starting the Router

```bash
npm install
npm run build
npm start
```

The router will start on port 4000 by default and wait for servers to register themselves.

### Server Registration

Servers can register themselves in two ways:

#### 1. REST API

```bash
# Register a new MCP server
curl -X POST http://localhost:4000/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-server",
    "url": "http://localhost:3000/mcp",
    "description": "My MCP Server",
    "enabled": true
  }'

# Unregister a server
curl -X DELETE http://localhost:4000/register/my-server
```

#### 2. MCP Tools

Use the router's built-in tools via the MCP protocol:

- `router:register-server`: Register a new server
- `router:unregister-server`: Unregister an existing server

## Configuration

Environment variables:

- `ROUTER_PORT`: Port number (default: 4000)
- `ROUTER_NAME`: Router service name (default: 'mcp-router')
- `ROUTER_VERSION`: Router version (default: '1.0.0')
- `TOOL_NAME_SEPARATOR`: Separator for tool names (default: ':')

## API Endpoints

- `POST /mcp`: Main MCP protocol endpoint
- `GET /health`: Health check and statistics
- `GET /config`: Current router configuration
- `POST /register`: Register a new MCP server
- `DELETE /register/:serverName`: Unregister an MCP server

## Router Management Tools

The router provides built-in MCP tools for management:

- `router:list-servers`: List all registered servers and their status
- `router:list-tools`: List all available tools from connected servers
- `router:reconnect-server`: Reconnect to a specific server
- `router:stats`: Get router statistics and performance metrics
- `router:register-server`: Register a new MCP server
- `router:unregister-server`: Unregister an MCP server

## Example: Programmatic Server Registration

```typescript
// Example of how an MCP server can register itself with the router
async function registerWithRouter() {
  const registration = {
    name: 'my-awesome-server',
    url: 'http://localhost:3000/mcp',
    description: 'My Awesome MCP Server',
    enabled: true
  };

  try {
    const response = await fetch('http://localhost:4000/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(registration)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('Successfully registered with router:', result);
    } else {
      console.error('Failed to register:', await response.text());
    }
  } catch (error) {
    console.error('Registration error:', error);
  }
}
```

## Tool Naming Convention

When servers register, their tools are namespaced using the format:
```
{serverName}:{originalToolName}
```

For example, if a server named "calculator" has a tool "add", it becomes "calculator:add" in the router.

## Development

```bash
npm run dev    # Start in development mode
npm run build  # Build TypeScript
npm run test   # Run tests
```

## License

MIT