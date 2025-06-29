#!/usr/bin/env node

import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import dotenv from 'dotenv';

import { ClientManager } from './services/clientManager.js';
import type { RouterConfig, McpServerConfig, RouterStats } from './types/index.js';

// Load environment variables
dotenv.config();

// Build configuration with dynamic server registration
const config: RouterConfig = {
  servers: [], // Start with empty servers list - they will register themselves
  port: parseInt(process.env.ROUTER_PORT || '4000'),
  routerName: process.env.ROUTER_NAME || 'mcp-router',
  routerVersion: process.env.ROUTER_VERSION || '1.0.0',
  toolNameSeparator: process.env.TOOL_NAME_SEPARATOR || ':'
};

// Create Express app
const app = express();
app.use(express.json());

// Create MCP server instance
const server = new McpServer({
  name: config.routerName || 'mcp-router',
  version: config.routerVersion || '1.0.0',
});

// Initialize client manager
const clientManager = new ClientManager(config.toolNameSeparator);

// Router stats
const stats: RouterStats = {
  totalServers: 0,
  connectedServers: 0,
  totalTools: 0,
  uptime: Date.now(),
  requestCount: 0,
  errorCount: 0
};

// We'll register tools dynamically after connecting to servers

// Add router management tools
server.tool(
  'router:list-servers',
  'List all configured MCP servers and their status',
  {},
  async () => {
    try {
      const serverStatuses = clientManager.getServerStatuses();
      const routerStats = clientManager.getStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: {
                totalServers: routerStats.totalServers,
                connectedServers: routerStats.connectedServers,
                totalTools: routerStats.totalTools
              },
              servers: serverStatuses
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing servers: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  'router:list-tools',
  'List all available tools from connected MCP servers',
  {},
  async () => {
    try {
      const tools = clientManager.getAllTools();
      const routerStats = clientManager.getStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: {
                totalServers: routerStats.totalServers,
                connectedServers: routerStats.connectedServers,
                totalTools: tools.length
              },
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description || 'No description available',
                schema: tool.schema,
              }))
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error listing tools: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  'router:stats',
  'Get router statistics and performance metrics',
  {},
  async () => {
    try {
      const routerStats = clientManager.getStats();
      const currentStats = {
        ...stats,
        ...routerStats,
        uptime: Date.now() - stats.uptime,
        uptimeFormatted: formatUptime(Date.now() - stats.uptime)
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(currentStats, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting stats: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ],
        isError: true
      };
    }
  }
);

// Add server registration tool
server.tool(
  'router:register-server',
  'Register a new MCP server with the router',
  {
    id: z.string().describe('Unique identifier for the server'),
    name: z.string().describe('Unique name for the server'),
    url: z.string().describe('URL of the MCP server endpoint'),
    description: z.string().optional().describe('Optional description of the server'),
    enabled: z.boolean().optional().default(true).describe('Whether the server should be enabled'),
  },
  async (args) => {
    try {
      const serverConfig: McpServerConfig = {
        id: args.id,
        name: args.name,
        url: args.url,
        description: args.description || `MCP Server: ${args.name}`,
        enabled: args.enabled ?? true,
      };

      // Check if server with this name already exists
      const existingIndex = config.servers.findIndex(s => s.name === args.name);

      if (existingIndex >= 0) {
        // Update existing server
        config.servers[existingIndex] = serverConfig;
        console.error(`Updated server configuration: ${args.name}`);
      } else {
        // Add new server
        config.servers.push(serverConfig);
        console.error(`Registered new server: ${args.name}`);
      }

      // Connect to the server immediately
      await clientManager.connectToServer(serverConfig);

      // This should happen here, for some reason inside the buildServerTools it's not working
      const tools = await clientManager.buildServerTools(serverConfig);
      for (const tool of tools) {
        server.tool(tool.name, tool.description, tool.schema.shape, tool.handler);
        console.log(`Registered tool: ${tool.name}`);
      }

      // Update stats
      const routerStats = clientManager.getStats();
      stats.totalServers = routerStats.totalServers;
      stats.connectedServers = routerStats.connectedServers;
      stats.totalTools = routerStats.totalTools;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Successfully registered server: ${args.name}`,
              server: serverConfig,
              stats: {
                totalServers: stats.totalServers,
                connectedServers: stats.connectedServers,
                totalTools: stats.totalTools
              }
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error(`Error registering server ${args.name}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error registering server ${args.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ],
        isError: true
      };
    }
  }
);

server.tool(
  'router:unregister-server',
  'Unregister an MCP server from the router',
  {
    serverName: z.string().describe('Name of the server to unregister')
  },
  async (args) => {
    try {
      // Find and remove server from config
      const serverIndex = config.servers.findIndex(s => s.name === args.serverName);

      if (serverIndex === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `Server not found: ${args.serverName}`
            }
          ],
          isError: true
        };
      }

      // Remove from config
      config.servers.splice(serverIndex, 1);

      // Disconnect from the server
      await clientManager.disconnectFromServer(args.serverName);

      // Update stats
      const routerStats = clientManager.getStats();
      stats.totalServers = routerStats.totalServers;
      stats.connectedServers = routerStats.connectedServers;
      stats.totalTools = routerStats.totalTools;

      console.error(`Unregistered server: ${args.serverName}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Successfully unregistered server: ${args.serverName}`,
              stats: {
                totalServers: stats.totalServers,
                connectedServers: stats.connectedServers,
                totalTools: stats.totalTools
              }
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error(`Error unregistering server ${args.serverName}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error unregistering server ${args.serverName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ],
        isError: true
      };
    }
  }
);

// Utility function to format uptime
const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// MCP endpoint - handles all HTTP methods for stateless operation
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    stats.requestCount++;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    res.on('close', () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    stats.errorCount++;
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// Handle unsupported HTTP methods
app.get('/mcp', async (req: Request, res: Response) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

app.delete('/mcp', async (req: Request, res: Response) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const routerStats = clientManager.getStats();
  res.json({
    status: 'healthy',
    service: config.routerName,
    version: config.routerVersion,
    timestamp: new Date().toISOString(),
    stats: {
      ...routerStats,
      uptime: Date.now() - stats.uptime,
      requestCount: stats.requestCount,
      errorCount: stats.errorCount
    }
  });
});

// Configuration endpoint
app.get('/config', (req: Request, res: Response) => {
  res.json({
    ...config,
    servers: config.servers.map(server => ({
      ...server,
      // Don't expose sensitive information
    }))
  });
});

// Main function to start the router
const main = async () => {
  try {
    const port = config.port || 4000;

    // Start with no servers - they will register themselves dynamically
    console.log('Starting MCP Router with dynamic server registration...');

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    app.listen(port, () => {
      console.log(`MCP Router running on http://localhost:${port}`);
      console.log(`MCP endpoint: http://localhost:${port}/mcp`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Configuration: http://localhost:${port}/config`);
      console.log(`Server registration: POST http://localhost:${port}/register`);
      console.log(`Server unregistration: DELETE http://localhost:${port}/register/<serverName>`);
      console.log('\nRouter Status:');
      console.log(`   Total servers: ${stats.totalServers}`);
      console.log(`   Connected servers: ${stats.connectedServers}`);
      console.log(`   Total tools available: ${stats.totalTools}`);
      console.log('\n🔧 Router Management Tools:');
      console.log('   - router:list-servers: List all servers and their status');
      console.log('   - router:list-tools: List all available tools from connected servers');
      console.log('   - router:stats: Get router statistics');
      console.log('   - router:register-server: Register a new MCP server');
      console.log('   - router:unregister-server: Unregister an MCP server');
      console.log('\n📡 Server Registration:');
      console.log('   - MCP Tool: router:register-server');
      console.log('   - MCP Tool: router:unregister-server');
      console.log(`\nEnvironment: ${process.env.NODE_ENV || 'development'}`);

      console.log('\n🚀 Ready for server registrations!');
      console.log('   Servers can register themselves by calling:');
      console.log(`   POST http://localhost:${port}/register`);
      console.log('   with JSON body: {"name": "server-name", "url": "http://server:port/mcp"}');
    });
  } catch (error) {
    console.error('Failed to start MCP Router:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.error(`\nReceived ${signal}, shutting down gracefully...`);

  try {
    await clientManager.disconnectAll();
    console.error('Disconnected from all MCP servers');
  } catch (error) {
    console.error('Error during shutdown:', error);
  }

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the router
main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
