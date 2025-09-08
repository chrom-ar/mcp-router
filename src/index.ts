#!/usr/bin/env node

import express, { Request, Response } from "express";
import { z } from "zod";
import dotenv from "dotenv";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ServerRepository } from "./repositories/serverRepository.js";
import { AuditLogger } from "./services/auditLogger.js";
import { authMiddleware, getAuthConfig, getUserFromRequest } from "./services/auth.js";
import { ClientManager } from "./services/clientManager.js";
import { initDatabaseFromEnv } from "./services/database.js";
import { EventLogger } from "./services/eventLogger.js";
import { MigrationRunner } from "./services/migrationRunner.js";
import { runWithContext } from "./services/requestContext.js";
import type { RouterConfig, McpServerConfig, RouterStats } from "./types/index.js";
import { registerServer, unregisterServer, formatUptime, isToolActive } from "./utils/serverManagement.js";

// Load environment variables
dotenv.config();

// Build configuration with dynamic server registration
const config: RouterConfig = {
  servers: [], // Start with empty servers list - they will register themselves
  port: parseInt(process.env.ROUTER_PORT || "4000"),
  routerName: process.env.ROUTER_NAME || "mcp-router",
  routerVersion: process.env.ROUTER_VERSION || "1.0.0",
  toolNameSeparator: process.env.TOOL_NAME_SEPARATOR || ":",
};

// Create Express app
const app = express();
app.use(express.json());

// Setup authentication middleware
const authConfig = getAuthConfig();
app.use(authMiddleware(authConfig));

// Create MCP server instance
const server = new McpServer({
  name: config.routerName || "mcp-router",
  version: config.routerVersion || "1.0.0",
  capabilities: {
    tools: {
      listChanged: true,
    },
  },
});

// Initialize database and persistence services (async setup in main())
let database: ReturnType<typeof initDatabaseFromEnv> | null = null;
let serverRepository: ServerRepository | undefined;
let eventLogger: EventLogger | undefined;
let auditLogger: AuditLogger | undefined;

// Initialize client manager (will be updated with persistence in main())
const clientManager = new ClientManager(config.toolNameSeparator);

// Router stats
const stats: RouterStats = {
  totalServers: 0,
  connectedServers: 0,
  totalTools: 0,
  uptime: Date.now(),
  requestCount: 0,
  errorCount: 0,
};

// We'll register tools dynamically after connecting to servers

// Add router management tools
server.tool(
  "router:list-servers",
  "List all configured MCP servers and their status",
  {},
  async () => {
    try {
      const serverStatuses = clientManager.getServerStatuses();
      const routerStats = clientManager.getStats();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: {
                totalServers: routerStats.totalServers,
                connectedServers: routerStats.connectedServers,
                totalTools: routerStats.totalTools,
              },
              servers: serverStatuses,
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing servers: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "router:list-tools",
  "List all available tools from connected MCP servers",
  {},
  async () => {
    try {
      const tools = clientManager.getAllTools();
      const routerStats = clientManager.getStats();
      const activeTools = tools.filter(tool => isToolActive(tool.name));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: {
                totalServers: routerStats.totalServers,
                connectedServers: routerStats.connectedServers,
                totalTools: activeTools.length,
              },
              tools: activeTools.map(tool => ({
                name: tool.name,
                description: tool.description || "No description available",
                schema: tool.schema.shape,
              })),
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing tools: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "router:stats",
  "Get router statistics and performance metrics",
  {},
  async () => {
    try {
      const routerStats = clientManager.getStats();
      const currentStats = {
        ...stats,
        ...routerStats,
        uptime: Date.now() - stats.uptime,
        uptimeFormatted: formatUptime(Date.now() - stats.uptime),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(currentStats, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting stats: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add server registration tool
const registerServerSchema = z.object({
  name: z.string().describe("Unique name for the server"),
  url: z.string().describe("URL of the MCP server endpoint"),
  description: z.string().optional().describe("Optional description of the server"),
  enabled: z.boolean().optional().default(true).describe("Whether the server should be enabled"),
  autoReconnect: z.boolean().optional().default(true).describe("Whether to auto-reconnect on ping failures"),
});

// @ts-ignore TypeScript has issues with deep type instantiation in MCP SDK with Zod
server.tool(
  "router:register-server",
  "Register a new MCP server with the router",
  registerServerSchema.shape as Record<string, z.ZodTypeAny>,
  async (args) => {
    const typedArgs = args as { name: string; url: string; description?: string; enabled?: boolean; autoReconnect?: boolean };
    const serverConfig: McpServerConfig = {
      id: "",
      name: typedArgs.name,
      url: typedArgs.url,
      description: typedArgs.description || `MCP Server: ${typedArgs.name}`,
      enabled: typedArgs.enabled ?? true,
      autoReconnect: typedArgs.autoReconnect ?? true,
    };

    const result = await registerServer(serverConfig, clientManager, config, stats, server);

    if (result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: result.success,
              message: result.message,
              server: result.server,
              stats: result.stats,
            }, null, 2),
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `${result.message}: ${result.error}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const unregisterServerSchema = z.object({
  serverName: z.string().describe("Name of the server to unregister"),
});

// @ts-ignore TypeScript has issues with deep type instantiation in MCP SDK with Zod
server.tool(
  "router:unregister-server",
  "Unregister an MCP server from the router",
  unregisterServerSchema.shape as Record<string, z.ZodTypeAny>,
  async (args) => {
    const typedArgs = args as { serverName: string };
    const result = await unregisterServer(typedArgs.serverName, clientManager, config, stats);

    if (result.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: result.success,
              message: result.message,
              stats: result.stats,
            }, null, 2),
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: result.message,
          },
        ],
        isError: true,
      };
    }
  },
);

// Add reconnect server tool
const reconnectServerSchema = z.object({
  serverName: z.string().describe("Name of the server to reconnect"),
});

// @ts-ignore TypeScript has issues with deep type instantiation in MCP SDK with Zod
server.tool(
  "router:reconnect-server",
  "Reconnect to a specific MCP server",
  reconnectServerSchema.shape as Record<string, z.ZodTypeAny>,
  async (args) => {
    const typedArgs = args as { serverName: string };
    try {
      await clientManager.reconnectToServer(typedArgs.serverName);

      // Update stats after reconnection
      const routerStats = clientManager.getStats();
      stats.totalServers = routerStats.totalServers;
      stats.connectedServers = routerStats.connectedServers;
      stats.totalTools = routerStats.totalTools;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Successfully reconnected to server: ${typedArgs.serverName}`,
              stats: {
                totalServers: stats.totalServers,
                connectedServers: stats.connectedServers,
                totalTools: stats.totalTools,
              },
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      console.error(`Error reconnecting to server ${typedArgs.serverName}:`, error);

      return {
        content: [
          {
            type: "text",
            text: `Error reconnecting to server ${typedArgs.serverName}: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// MCP endpoint - handles all HTTP methods for stateless operation
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    stats.requestCount++;

    const user = getUserFromRequest(req);

    const context = {
      userId: user?.userId,
      userEmail: user?.email,
      apiKey: user?.apiKey,
      requestId: req.headers["x-request-id"] as string || `req-${Date.now()}`,
    };

    await runWithContext(context, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });

      res.on("close", () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (error: unknown) {
    stats.errorCount++;
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Handle unsupported HTTP methods
app.get("/mcp", async (req: Request, res: Response) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  }));
});

app.delete("/mcp", async (req: Request, res: Response) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  }));
});

// Health check endpoint
app.get("/health", async (req: Request, res: Response) => {
  const routerStats = clientManager.getStats();
  let databaseStatus: { connected: boolean; healthy: boolean; latency?: number } = { connected: false, healthy: false };

  if (database) {
    try {
      const dbHealth = await database.healthCheck();
      databaseStatus = {
        connected: true,
        healthy: dbHealth.healthy,
        latency: dbHealth.latency,
      };
    } catch (error: unknown) {
      databaseStatus = { connected: false, healthy: false };
    }
  }

  res.json({
    status: "healthy",
    service: config.routerName,
    version: config.routerVersion,
    timestamp: new Date().toISOString(),
    database: databaseStatus,
    stats: {
      ...routerStats,
      uptime: Date.now() - stats.uptime,
      requestCount: stats.requestCount,
      errorCount: stats.errorCount,
    },
  });
});

// Configuration endpoint
app.get("/config", (req: Request, res: Response) => {
  res.json({
    ...config,
    servers: config.servers.map(server => ({
      ...server,
      // Don't expose sensitive information
    })),
  });
});

// Server registration endpoint
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, url, description, enabled = true, autoReconnect = true } = req.body;

    if (!name || !url) {
      return res.status(400).json({
        error: "Missing required fields: name and url"
      });
    }

    // Create server configuration
    const serverConfig: McpServerConfig = {
      id: "",
      name: name,
      url: url,
      description: description || `MCP Server: ${name}`,
      enabled: enabled,
      autoReconnect: autoReconnect,
    };

    const result = await registerServer(serverConfig, clientManager, config, stats, server);

    if (result.success) {
      res.json({
        success: result.success,
        message: result.message,
        server: result.server,
        stats: result.stats,
      });
    } else {
      if (result.error?.includes("already exists")) {
        res.status(409).json({
          error: result.error,
        });
      } else {
        res.status(500).json({
          error: result.error,
        });
      }
    }
  } catch (error: unknown) {
    console.error(`Error registering server:`, error);

    res.status(500).json({
      error: `Error registering server: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
});

// Server unregistration endpoint
app.delete("/register/:serverName", async (req: Request, res: Response) => {
  try {
    const { serverName } = req.params;
    const result = await unregisterServer(serverName, clientManager, config, stats);

    if (result.success) {
      res.json({
        success: result.success,
        message: result.message,
        stats: result.stats,
      });
    } else {
      if (result.error === "Server not found") {
        res.status(404).json({
          error: `Server '${serverName}' not found`,
        });
      } else {
        res.status(500).json({
          error: result.error,
        });
      }
    }
  } catch (error: unknown) {
    console.error(`Error unregistering server ${req.params.serverName}:`, error);

    res.status(500).json({
      error: `Error unregistering server: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
});

// Main function to start the router
const main = async () => {
  try {
    const port = config.port || 4000;

    // Initialize database if configured
    if (process.env.DATABASE_URL || process.env.DB_HOST) {
      try {
        console.log("Initializing database connection...");

        database = initDatabaseFromEnv();

        await database.connect();

        if (process.env.RUN_MIGRATIONS !== "false") {
          console.log("Running database migrations...");

          const migrationRunner = new MigrationRunner(database);

          await migrationRunner.up();
        }

        serverRepository = new ServerRepository(database);
        eventLogger = new EventLogger(database, {
          enabled: process.env.ENABLE_EVENT_LOG !== "false",
        });
        auditLogger = new AuditLogger(database, {
          enabled: process.env.ENABLE_AUDIT_LOG === "true",
        });

        const newClientManager = new ClientManager(config.toolNameSeparator || ":", {
          serverRepository,
          eventLogger,
          auditLogger,
          pingIntervalMs: Number(process.env.PING_INTERVAL_MS) || 30000,
          maxConsecutivePingFailures: Number(process.env.MAX_PING_FAILURES) || 3,
        });

        Object.assign(clientManager, newClientManager);

        console.log("Database initialized successfully");

        // Load persisted servers
        await clientManager.loadPersistedServers();
      } catch (dbError: unknown) {
        console.error("Failed to initialize database:", dbError);
        console.log("Continuing without persistence...");
      }
    }

    // Start with no servers - they will register themselves dynamically
    console.log("Starting MCP Router with dynamic server registration...");

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
      console.log("\nRouter Status:");
      console.log(`   Total servers: ${stats.totalServers}`);
      console.log(`   Connected servers: ${stats.connectedServers}`);
      console.log(`   Total tools available: ${stats.totalTools}`);
      console.log("\n🔧 Router Management Tools:");
      console.log("   - router:list-servers: List all servers and their status");
      console.log("   - router:list-tools: List all available tools from connected servers");
      console.log("   - router:stats: Get router statistics");
      console.log("   - router:register-server: Register a new MCP server");
      console.log("   - router:unregister-server: Unregister an MCP server");
      console.log("   - router:reconnect-server: Reconnect to a specific server");
      console.log("\n📡 Server Registration:");
      console.log("   - MCP Tool: router:register-server");
      console.log("   - MCP Tool: router:unregister-server");
      console.log(`\nEnvironment: ${process.env.NODE_ENV || "development"}`);

      console.log("\n🚀 Ready for server registrations!");
      console.log("   Servers can register themselves by calling:");
      console.log(`   POST http://localhost:${port}/register`);
      console.log("   with JSON body: {\"name\": \"server-name\", \"url\": \"http://server:port/mcp\"}");
    });
  } catch (error: unknown) {
    console.error("Failed to start MCP Router:", error);
    process.exit(1);
  }
};

// Handle graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.error(`\nReceived ${signal}, shutting down gracefully...`);

  try {
    await clientManager.disconnectAll();
    console.error("Disconnected from all MCP servers");

    if (eventLogger) {
      await eventLogger.shutdown();
    }

    if (auditLogger) {
      await auditLogger.shutdown();
    }

    if (database) {
      await database.disconnect();

      console.error("Database connection closed");
    }
  } catch (error: unknown) {
    console.error("Error during shutdown:", error);
  }

  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Start the router
main().catch((error: unknown) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
