import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchemaToZod, type JsonSchema } from "json-schema-to-zod";
import { z, ZodRawShape } from "zod";

import { ServerRepository } from "../repositories/serverRepository.js";
import { EventLogger } from "./eventLogger.js";
import { AuditLogger } from "./auditLogger.js";

import type {
  AggregatedTool,
  McpServerConfig,
  ServerStatus,
  ToolHandlerArgs,
  ToolHandlerResult,
  ToolRoute,
} from "../types/index.js";

interface ClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  config: McpServerConfig;
  status: ServerStatus;
  tools: AggregatedTool[];
}

export class ClientManager {
  private connections = new Map<string, ClientConnection>();
  private toolRoutes = new Map<string, ToolRoute>();
  private toolNameSeparator: string;
  private serverRepository?: ServerRepository;
  private eventLogger?: EventLogger;
  private auditLogger?: AuditLogger;

  constructor(
    toolNameSeparator: string = ":",
    options?: {
      serverRepository?: ServerRepository;
      eventLogger?: EventLogger;
      auditLogger?: AuditLogger;
    },
  ) {
    this.toolNameSeparator = toolNameSeparator;
    this.serverRepository = options?.serverRepository;
    this.eventLogger = options?.eventLogger;
    this.auditLogger = options?.auditLogger;
  }

  /**
   * Load and connect to persisted servers
   */
  async loadPersistedServers(): Promise<void> {
    if (!this.serverRepository) {
      return;
    }

    try {
      const servers = await this.serverRepository.getAllAsConfigs();
      // console.log(`Loading ${servers.length} persisted servers...`);

      if (servers.length > 0) {
        await this.connectToServers(servers);
      }
    } catch (error: unknown) {
      console.error("Failed to load persisted servers:", error);
      // Continue without persisted servers
    }
  }

  /**
   * Connect to multiple MCP servers
   */
  async connectToServers(configs: McpServerConfig[]): Promise<void> {
    const connectionPromises = configs
      .filter(config => config.enabled !== false)
      .map(config => this.connectToServer(config));

    await Promise.allSettled(connectionPromises);
  }

  /**
   * Connect to a single MCP server
   */
  async connectToServer(config: McpServerConfig): Promise<void> {
    try {
      // console.log(`Connecting to MCP server: ${config.name} at ${config.url}`);

      // Persist the server configuration if repository available
      if (this.serverRepository) {
        try {
          const serverRecord = await this.serverRepository.upsert(config);
          config.id = serverRecord.id; // Use database ID
        } catch (dbError: unknown) {
          console.error(`Failed to persist server ${config.name}:`, dbError);
          // Continue without persistence
        }
      }

      const client = new Client({
        name: "mcp-router-client",
        version: "1.0.0",
      });

      // Use config.id if available, otherwise use config.name as the key
      const serverId = config.id || config.name;

      client.onerror = (error: unknown) => {
        // console.log(`Client error for ${config.name}:`, error);
        this.updateServerStatus(serverId, { connected: false, lastError: error instanceof Error ? error.message : "Unknown error" });

        // Log error event
        if (this.eventLogger && config.id) {
          this.eventLogger.logError(config.id, config.name, error instanceof Error ? error.message : "Unknown error");
        }
      };

      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      await client.connect(transport);

      const status: ServerStatus = {
        name: config.name,
        url: config.url,
        connected: true,
        lastConnected: new Date(),
        toolsCount: 0,
      };

      const connection: ClientConnection = {
        client,
        transport,
        config,
        status,
        tools: [],
      };

      this.connections.set(serverId, connection);

      // Load tools from the connected server
      await this.loadServerTools(config);

      if (this.eventLogger && config.id) {
        await this.eventLogger.logConnection(config.id, config.name, {
          url: config.url,
          toolsCount: connection.status.toolsCount,
        });
      }

      // console.log(`Successfully connected to ${serverId}`);
    } catch (error: unknown) {
      console.error(`Failed to connect to ${config.name}:`, error);
      const status: ServerStatus = {
        name: config.name,
        url: config.url,
        connected: false,
        lastError: error instanceof Error ? error.message : "Unknown error",
        toolsCount: 0,
      };

      // Store failed connection for status tracking
      this.connections.set(config.name, {
        // Store failed connection with null client/transport for status tracking
        client: {} as Client,
        transport: {} as StreamableHTTPClientTransport,
        config,
        status,
        tools: [],
      });
    }
  }

  /**
   * Load tools from a connected server and store them internally
   */
  private async loadServerTools(config: McpServerConfig): Promise<void> {
    const serverId = config.id || config.name;
    const connection = this.connections.get(serverId);

    if (!connection || !connection.client || !connection.status.connected) {
      return;
    }

    try {
      const toolsResult = await connection.client.listTools();

      if (toolsResult && toolsResult.tools) {
        const aggregatedTools: AggregatedTool[] = toolsResult.tools.map((tool: { name: string; description?: string; inputSchema: unknown }) => {
          const aggregatedName = `${serverId}${this.toolNameSeparator}${tool.name}`;

          let schema: ZodRawShape = {};
          try {
            const schemaString = jsonSchemaToZod(tool.inputSchema as JsonSchema);
            const evalContext = { z };

            schema = eval(`(function() { const { z } = arguments[0]; return ${schemaString}; })`)(evalContext);
          } catch (evalError: unknown) {
            console.error(`Failed to eval schema for ${tool.name}:`, evalError);
            throw evalError;
          }

          // Store the tool route for efficient lookup
          this.toolRoutes.set(aggregatedName, {
            serverId: serverId,
            serverName: config.name,
            originalToolName: tool.name,
            serverUrl: config.url,
          });

          return {
            name: aggregatedName,
            description: `[${config.name}] ${tool.description}`,
            schema,
            handler: async (args: ToolHandlerArgs): Promise<ToolHandlerResult> => {
              try {
                // console.log(`Routing ${config.name}:${tool.name} with args: ${JSON.stringify(args)}`);

                const result = await connection.client.callTool({
                  name: tool.name,
                  arguments: args || {},
                });
                // Ensure content is always present
                return {
                  ...result,
                  content: result.content || [],
                } as ToolHandlerResult;
              } catch (error: unknown) {
                console.error(`Error calling tool ${tool.name}:`, error);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error calling tool ${tool.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
                    },
                  ],
                  isError: true,
                };
              }
            },
          };
        });

        connection.tools = aggregatedTools;
        connection.status.toolsCount = aggregatedTools.length;
      }
    } catch (error: unknown) {
      console.error(`Failed to load tools from ${config.name}:`, error);
      connection.status.lastError = error instanceof Error ? error.message : "Failed to load tools";
    }
  }

  /**
   * Load tools from a connected server (public method for external use)
   */
  async buildServerTools(config: McpServerConfig): Promise<AggregatedTool[] | undefined> {
    const serverId = config.id || config.name;
    const connection = this.connections.get(serverId);

    if (!connection || !connection.client || !connection.status.connected) {
      return;
    }

    try {
      const toolsResult = await connection.client.listTools();
      if (toolsResult && toolsResult.tools) {
        const aggregatedTools: AggregatedTool[] = toolsResult.tools.map((tool: { name: string; description?: string; inputSchema: unknown }) => {
          const aggregatedName = `${serverId}${this.toolNameSeparator}${tool.name}`;

          let schema: ZodRawShape = {};
          try {
            const schemaString = jsonSchemaToZod(tool.inputSchema as JsonSchema);
            // Make z available in eval context
            const evalContext = { z };
            schema = eval(`(function() { const { z } = arguments[0]; return ${schemaString}; })`)(evalContext);
          } catch (evalError: unknown) {
            console.error(`Failed to eval schema for ${tool.name}:`, evalError);
            throw evalError;
          }

          return {
            name: aggregatedName,
            description: `[${config.name}] ${tool.description}`,
            schema,
            handler: async (args: ToolHandlerArgs): Promise<ToolHandlerResult> => {
              try {
                // stats.requestCount++;
                // console.log(`Routing ${config.name}:${tool.name} with args: ${JSON.stringify(args)}`);

                const result = await connection.client.callTool({
                  name: tool.name,
                  arguments: args || {},
                });
                // Ensure content is always present
                return {
                  ...result,
                  content: result.content || [],
                } as ToolHandlerResult;
              } catch (error: unknown) {
                // stats.errorCount++;
                console.error(`Error calling tool ${tool.name}:`, error);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error calling tool ${tool.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
                    },
                  ],
                  isError: true,
                };
              }
            },
          };
        });

        connection.tools = aggregatedTools;
        connection.status.toolsCount = aggregatedTools.length;

        return aggregatedTools;
      }
    } catch (error: unknown) {
      console.error(`Failed to load tools from ${config.name}:`, error);
      connection.status.lastError = error instanceof Error ? error.message : "Failed to load tools";
    }
  }

  /**
   * Get all aggregated tools from all connected servers
   */
  getAllTools(): AggregatedTool[] {
    const allTools: AggregatedTool[] = [];

    for (const connection of this.connections.values()) {
      if (connection.status.connected && connection.tools) {
        allTools.push(...connection.tools);
      }
    }

    return allTools;
  }

  /**
   * Call a tool on the appropriate server
   */
  async callTool(toolName: string, args: ToolHandlerArgs): Promise<ToolHandlerResult> {
    const separatorIndex = toolName.indexOf(this.toolNameSeparator);

    if (separatorIndex === -1) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const serverName = toolName.substring(0, separatorIndex);
    const actualToolName = toolName.substring(separatorIndex + this.toolNameSeparator.length);
    const connection = this.connections.get(serverName);

    if (!connection) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    if (!connection.status.connected) {
      throw new Error(`Server ${serverName} is not connected`);
    }

    const startTime = Date.now();

    let result: ToolHandlerResult | undefined;
    let status: "success" | "error" = "success";
    let errorMessage: string | undefined;

    try {
      const rawResult = await connection.client.callTool({
        name: actualToolName,
        arguments: args || {},
      });
      // Ensure content is always present
      result = {
        ...rawResult,
        content: rawResult.content || [],
      } as ToolHandlerResult;
      return result;
    } catch (error: unknown) {
      status = "error";
      errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error calling tool ${toolName}:`, error);
      throw error;
    } finally {
      // Log audit if logger is available
      if (this.auditLogger) {
        const durationMs = Date.now() - startTime;

        await this.auditLogger.logToolCall({
          serverName,
          toolName: actualToolName,
          arguments: args,
          response: status === "success" && result ? result : undefined,
          durationMs,
          status,
          errorMessage,
        }).catch(err => {
          console.error("Failed to log tool call audit:", err);
        });
      }
    }
  }

  /**
   * Get server status information
   */
  getServerStatuses(): ServerStatus[] {
    return Array.from(this.connections.values()).map(conn => conn.status);
  }

  /**
   * Update server status
   */
  private updateServerStatus(serverName: string, updates: Partial<ServerStatus>): void {
    const connection = this.connections.get(serverName);

    if (connection) {
      connection.status = { ...connection.status, ...updates };
    }
  }

  /**
   * Reconnect to a specific server
   */
  async reconnectToServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server ${serverName} not found`);
    }

    if (connection.transport) {
      try {
        await connection.transport.close();
      } catch (error: unknown) {
        console.error(`Error closing existing connection to ${serverName}:`, error);
      }
    }

    this.connections.delete(serverName);
    this.clearServerRoutes(serverName);

    await this.connectToServer(connection.config);
  }

  /**
   * Clear tool routes for a specific server
   */
  private clearServerRoutes(serverName: string): void {
    for (const [toolName, route] of this.toolRoutes.entries()) {
      if (route.serverId === serverName) {
        this.toolRoutes.delete(toolName);
      }
    }
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      throw new Error(`Server ${serverName} not found`);
    }

    if (this.eventLogger && connection.config.id) {
      await this.eventLogger.logDisconnection(
        connection.config.id,
        connection.config.name,
        "Manual disconnection",
      );
    }

    if (connection.transport) {
      try {
        await connection.transport.close();
      } catch (error: unknown) {
        console.error(`Error closing connection to ${serverName}:`, error);
      }
    }

    this.connections.delete(serverName);
    this.clearServerRoutes(serverName);

    if (this.serverRepository) {
      try {
        await this.serverRepository.setEnabled(connection.config.name, false);
      } catch (dbError: unknown) {
        console.error("Failed to update server status in database:", dbError);
      }
    }

    console.error(`Disconnected from server: ${serverName}`);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.connections.values()).map(async connection => {
      if (connection.transport) {
        try {
          await connection.transport.close();
        } catch (error: unknown) {
          console.error(`Error disconnecting from ${connection.config.name}:`, error);
        }
      }
    });

    await Promise.allSettled(disconnectPromises);
    this.connections.clear();
    this.toolRoutes.clear();
  }

  /**
   * Get router statistics
   */
  getStats() {
    const connectedServers = Array.from(this.connections.values()).filter(
      conn => conn.status.connected,
    ).length;

    return {
      totalServers: this.connections.size,
      connectedServers,
      totalTools: this.getAllTools().length,
      toolRoutes: this.toolRoutes.size,
    };
  }
}
