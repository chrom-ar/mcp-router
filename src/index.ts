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
import { SyncService } from "./services/syncService.js";
import type { RouterConfig, McpServerConfig, RouterStats } from "./types/index.js";
import { registerServer, unregisterServer, formatUptime } from "./utils/serverManagement.js";

// Load environment variables from .env file (unless explicitly disabled for testing)
if (process.env.SKIP_DOTENV !== "true") {
  dotenv.config();
}

// Build configuration with dynamic server registration
const config: RouterConfig = {
  servers: [], // Start with empty servers list - they will register themselves
  port: parseInt(process.env.ROUTER_PORT || "4000"),
  routerName: process.env.ROUTER_NAME || "mcp-router",
  routerVersion: process.env.ROUTER_VERSION || "1.0.0",
  toolNameSeparator: process.env.TOOL_NAME_SEPARATOR || "-->",
};

// Create Express app
const app = express();

app.use(express.json());

// Setup authentication middleware
const authConfig = getAuthConfig();

app.use(authMiddleware(authConfig));

// Create MCP server instance
const server = new McpServer(
  {
    name: config.routerName || "mcp-router",
    version: config.routerVersion || "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
  },
);

// Initialize database and persistence services (async setup in main())
let database: ReturnType<typeof initDatabaseFromEnv> | null = null;
let serverRepository: ServerRepository | undefined;
let eventLogger: EventLogger | undefined;
let auditLogger: AuditLogger | undefined;

// Initialize client manager (will be updated with persistence in main())
const clientManager = new ClientManager(config.toolNameSeparator);

// Sync service will be initialized after database connection
let syncService: SyncService | undefined;

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
server.registerTool(
  `router${config.toolNameSeparator}list-servers`,
  {
    description: "List all configured MCP servers and their status",
  },
  async (_args: Record<string, unknown>, _extra: unknown) => {
    try {
      const serverStatuses = clientManager.getServerStatuses();
      const routerStats = clientManager.getStats();

      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
            text: `Error listing servers: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  `router${config.toolNameSeparator}list-tools`,
  {
    description: "List all available tools from connected MCP servers",
  },
  async (_args: Record<string, unknown>, _extra: unknown) => {
    try {
      const tools = clientManager.getAllTools();
      const routerStats = clientManager.getStats();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              summary: {
                totalServers: routerStats.totalServers,
                connectedServers: routerStats.connectedServers,
                totalTools: tools.length,
              },
              tools: tools.map(tool => ({
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
            type: "text" as const,
            text: `Error listing tools: ${error instanceof Error ? error.message : "Unknown error"}`,
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

server.registerTool(
  `router${config.toolNameSeparator}register-server`,
  {
    description: "Register a new MCP server with the router",
    inputSchema: registerServerSchema.shape,
  },
  async (args: Record<string, unknown>, _extra: unknown) => {
    const typedArgs = args as { name: string; url: string; description?: string; enabled?: boolean; autoReconnect?: boolean };
    const serverConfig: McpServerConfig = {
      id: "",
      name: typedArgs.name,
      url: typedArgs.url,
      description: typedArgs.description || `MCP Server: ${typedArgs.name}`,
      enabled: typedArgs.enabled ?? true,
      autoReconnect: typedArgs.autoReconnect ?? true,
    };

    const result = await registerServer(serverConfig, clientManager, config, stats, server, syncService);

    if (result.success) {
      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
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

server.registerTool(
  `router${config.toolNameSeparator}unregister-server`,
  {
    description: "Unregister an MCP server from the router",
    inputSchema: unregisterServerSchema.shape,
  },
  async (args: Record<string, unknown>, _extra: unknown) => {
    const typedArgs = args as { serverName: string };
    const result = await unregisterServer(typedArgs.serverName, clientManager, config, stats, syncService);

    if (result.success) {
      return {
        content: [
          {
            type: "text" as const,
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
            type: "text" as const,
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

server.registerTool(
  `router${config.toolNameSeparator}reconnect-server`,
  {
    description: "Reconnect to a specific MCP server",
    inputSchema: reconnectServerSchema.shape,
  },
  async (args: Record<string, unknown>, _extra: unknown) => {
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
            type: "text" as const,
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
            type: "text" as const,
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

// Stats endpoint - aggregated statistics from all connected servers
app.options("/stats", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.status(204).send();
});

app.get("/stats", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    // Get servers that have a stats tool
    const serversWithStats = await clientManager.getServersWithStatsTool();
    const aggregatedStats: Record<string, unknown> = {};

    // Call stats tool on each server that has it
    const statsPromises = serversWithStats.map(async serverName => {
      try {
        const result = await clientManager.callServerStatsTool(serverName);

        // Parse the result to extract the actual stats data
        let statsData: unknown;

        if (result.content && result.content.length > 0) {
          const firstContent = result.content[0];

          if (firstContent.type === "text" && firstContent.text) {
            try {
              statsData = JSON.parse(firstContent.text);
            } catch {
              statsData = firstContent.text;
            }
          } else {
            statsData = firstContent;
          }
        }

        return { serverName, statsData };
      } catch (error: unknown) {
        return {
          serverName,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    const results = await Promise.allSettled(statsPromises);

    // Build the aggregated response
    results.forEach(result => {
      if (result.status === "fulfilled") {
        const { serverName, statsData, error } = result.value as { serverName: string; statsData?: unknown; error?: string };

        if (error) {
          aggregatedStats[serverName] = { error };
        } else {
          aggregatedStats[serverName] = statsData;
        }
      }
    });

    res.json(aggregatedStats);
  } catch (error: unknown) {
    console.error("Error getting aggregated stats:", error);

    res.status(500).json({
      error: `Error getting aggregated stats: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
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
        error: "Missing required fields: name and url",
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

    const result = await registerServer(serverConfig, clientManager, config, stats, server, syncService);

    if (result.success) {
      res.json({
        success: result.success,
        message: result.message,
        server: result.server,
        stats: result.stats,
      });
    } else {
      if (result.error?.includes("already exists") || result.error === "Name/URL conflict") {
        res.status(409).json({
          error: result.error,
          message: result.message,
        });
      } else if (result.error?.startsWith("Invalid")) {
        res.status(400).json({
          error: result.error,
          message: result.message,
        });
      } else {
        res.status(500).json({
          error: result.error,
          message: result.message,
        });
      }
    }
  } catch (error: unknown) {
    console.error("Error registering server:", error);

    res.status(500).json({
      error: `Error registering server: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
});

// Server unregistration endpoint
app.delete("/register/:serverName", async (req: Request, res: Response) => {
  try {
    const { serverName } = req.params;
    const result = await unregisterServer(serverName, clientManager, config, stats, syncService);

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
      error: `Error unregistering server: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
});

// 404 handler - must be last
app.use((req: Request, res: Response) => {
  const user = getUserFromRequest(req);

  console.log(`404 - ${req.method} ${req.path} - User: ${user?.email || "anonymous"} - IP: ${req.ip}`);

  res.status(404).json({
    error: "Not Found",
    path: req.path,
    method: req.method,
  });
});

// Main function to start the router
const main = async () => {
  try {
    const port = config.port || 4000;

    // Initialize database if configured (only if non-empty values provided)
    const hasValidDatabaseConfig =
      (process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0) ||
      (process.env.DB_HOST && process.env.DB_HOST.trim().length > 0);

    if (hasValidDatabaseConfig) {
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

        const newClientManager = new ClientManager(config.toolNameSeparator || "-->", {
          serverRepository,
          eventLogger,
          auditLogger,
          pingIntervalMs: Number(process.env.PING_INTERVAL_MS) || 30000,
          maxConsecutivePingFailures: Number(process.env.MAX_PING_FAILURES) || 3,
        });

        Object.assign(clientManager, newClientManager);

        console.log("Database initialized successfully");

        // Initialize sync service for multi-instance coordination
        syncService = new SyncService(database, clientManager, {
          instanceId: process.env.INSTANCE_ID || undefined,
          pollIntervalMs: Number(process.env.SYNC_POLL_INTERVAL_MS) || 5000,
          cleanupIntervalMs: Number(process.env.SYNC_CLEANUP_INTERVAL_MS) || 3600000,
          eventRetentionHours: Number(process.env.SYNC_EVENT_RETENTION_HOURS) || 24,
          mcpServer: server,
        });

        // Start sync service which will handle loading all servers and registering tools
        await syncService.start();

        // The sync service now handles loading and registering all servers
        const loadedServers = clientManager.getServerStatuses();

        console.log(`Total servers loaded: ${loadedServers.length}, Connected: ${loadedServers.filter(s => s.connected).length}`);
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
      console.log(`Aggregated stats: http://localhost:${port}/stats`);
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

    if (syncService) {
      syncService.stop();
      console.error("Sync service stopped");
    }

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
