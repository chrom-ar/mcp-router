import { ZodRawShape } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ServerRepository } from "../repositories/serverRepository.js";
import { EventLogger } from "./eventLogger.js";
import { AuditLogger } from "./auditLogger.js";
import { getRequestContext } from "./requestContext.js";

import type {
  AggregatedTool,
  McpServerConfig,
  ServerStatus,
  ToolHandlerArgs,
  ToolHandlerResult,
} from "../types/index.js";

interface ClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  config: McpServerConfig;
  status: ServerStatus;
  tools: AggregatedTool[];
  lastPingTime?: Date;
  consecutivePingFailures?: number;
}

export class ClientManager {
  private connections = new Map<string, ClientConnection>();
  private toolNameSeparator: string;
  private serverRepository?: ServerRepository;
  private eventLogger?: EventLogger;
  private auditLogger?: AuditLogger;
  private pingInterval?: NodeJS.Timeout;
  private pingIntervalMs: number;
  private maxConsecutivePingFailures: number;

  constructor(
    toolNameSeparator: string = ":",
    options?: {
      serverRepository?: ServerRepository;
      eventLogger?: EventLogger;
      auditLogger?: AuditLogger;
      pingIntervalMs?: number;
      maxConsecutivePingFailures?: number;
    },
  ) {
    this.toolNameSeparator = toolNameSeparator;
    this.serverRepository = options?.serverRepository;
    this.eventLogger = options?.eventLogger;
    this.auditLogger = options?.auditLogger;
    this.pingIntervalMs = options?.pingIntervalMs || 30000; // Default: 30 seconds
    this.maxConsecutivePingFailures = options?.maxConsecutivePingFailures || 3; // Default: 3 failures before marking as disconnected
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
        this.startPingInterval();
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

    // Start ping interval if we have connected servers
    if (this.connections.size > 0) {
      this.startPingInterval();
    }
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

      const serverId = config.name;

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
        lastPingTime: new Date(),
        consecutivePingFailures: 0,
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

    if (!this.pingInterval && this.connections.size > 0) {
      this.startPingInterval();
    }
  }

  /**
   * Load tools from a connected server and store them internally
   */
  private async loadServerTools(config: McpServerConfig): Promise<void> {
    const serverId = config.name;
    const connection = this.connections.get(serverId);

    if (!connection || !connection.client || !connection.status.connected) {
      return;
    }

    try {
      const toolsResult = await connection.client.listTools();

      if (toolsResult && toolsResult.tools) {
        const aggregatedTools: AggregatedTool[] = toolsResult.tools.map((tool: { name: string; description?: string; inputSchema: unknown }) => {
          const aggregatedName = `${serverId}${this.toolNameSeparator}${tool.name}`;
          const schema: ZodRawShape = {};

          return {
            name: aggregatedName,
            description: `[${config.name}] ${tool.description}`,
            schema,
            inputSchema: tool.inputSchema,
            handler: async (args: ToolHandlerArgs): Promise<ToolHandlerResult> => {
              // Get fresh connection in case it was reconnected
              const currentConnection = this.connections.get(serverId);
              if (!currentConnection || !currentConnection.status.connected) {
                throw new Error(`Server ${serverId} is not connected`);
              }

              try {
                const result = await currentConnection.client.callTool({
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
   * Get tools from a specific server (public method for external use)
   */
  async buildServerTools(config: McpServerConfig): Promise<AggregatedTool[] | undefined> {
    await this.loadServerTools(config);
    const connection = this.connections.get(config.name);
    return connection?.tools;
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

        // Get user context from async local storage
        const context = getRequestContext();

        await this.auditLogger.logToolCall({
          serverName,
          toolName: actualToolName,
          arguments: args,
          response: status === "success" && result ? result : undefined,
          durationMs,
          status,
          errorMessage,
          userId: context?.userId,
          userEmail: context?.userEmail,
          apiKey: context?.apiKey,
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

    await this.connectToServer(connection.config);
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectFromServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      console.log(`Server ${serverName} not found - may already be disconnected`);

      return;
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
   * Start periodic ping to all connected servers
   */
  private startPingInterval(): void {
    // Clear existing interval if any
    this.stopPingInterval();

    console.log(`Starting ping interval (every ${this.pingIntervalMs / 1000} seconds)`);

    this.pingInterval = setInterval(async () => {
      await this.pingAllServers();
    }, this.pingIntervalMs);
  }

  /**
   * Stop periodic ping
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  /**
   * Ping all connected servers and attempt to reconnect disconnected ones
   */
  private async pingAllServers(): Promise<void> {
    const pingPromises = Array.from(this.connections.entries()).map(async ([serverId, connection]) => {
      if (!connection.status.connected) {
        if (connection.config.autoReconnect !== false) {
          console.log(`Attempting to reconnect to disconnected server: ${connection.config.name}`);

          try {
            await this.reconnectToServer(serverId);

            const newConnection = this.connections.get(serverId);

            if (newConnection && newConnection.status.connected) {
              console.log(`Successfully reconnected to ${connection.config.name}`);
            } else {
              console.log(`Failed to reconnect to ${connection.config.name}: Server is still not connected`);
            }
          } catch (error: unknown) {
            console.log(`Failed to reconnect to ${connection.config.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }
        return;
      }

      try {
        // Use the MCP protocol's ping method
        await connection.client.ping();

        // Reset failure counter on successful ping
        connection.lastPingTime = new Date();
        connection.consecutivePingFailures = 0;

        // Update status if it was previously marked as having issues
        if (connection.status.lastError?.includes("ping")) {
          connection.status.lastError = undefined;
        }
      } catch (error: unknown) {
        connection.consecutivePingFailures = (connection.consecutivePingFailures || 0) + 1;

        const errorMessage = error instanceof Error ? error.message : "Ping failed";
        console.error(`Ping failed for server ${connection.config.name}: ${errorMessage}`);

        // Mark server as disconnected if too many consecutive failures
        if (connection.consecutivePingFailures >= this.maxConsecutivePingFailures) {
          connection.status.connected = false;
          connection.status.lastError = `Server not responding to ping (${connection.consecutivePingFailures} consecutive failures)`;

          console.log(`Clearing tools for disconnected server: ${connection.config.name}`);
          connection.tools = [];

          // Log the disconnection
          if (this.eventLogger && connection.config.id) {
            await this.eventLogger.logDisconnection(
              connection.config.id,
              connection.config.name,
              `Ping timeout after ${connection.consecutivePingFailures} failures`,
            );
          }

          // Optionally try to reconnect
          if (connection.config.autoReconnect !== false) {
            console.log(`Attempting to reconnect to ${connection.config.name}...`);
            try {
              await this.reconnectToServer(serverId);
            } catch (reconnectError: unknown) {
              console.error(`Failed to reconnect to ${connection.config.name}:`, reconnectError);
            }
          }
        }
      }
    });

    await Promise.allSettled(pingPromises);
  }

  /**
   * Manually ping a specific server
   */
  async pingServer(serverName: string): Promise<boolean> {
    const connection = this.connections.get(serverName);

    if (!connection) {
      throw new Error(`Server ${serverName} not found`);
    }

    if (!connection.status.connected) {
      return false;
    }

    try {
      await connection.client.ping();
      connection.lastPingTime = new Date();
      connection.consecutivePingFailures = 0;
      return true;
    } catch (error: unknown) {
      connection.consecutivePingFailures = (connection.consecutivePingFailures || 0) + 1;
      const errorMessage = error instanceof Error ? error.message : "Ping failed";
      console.error(`Ping failed for server ${serverName}: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    // Stop pinging before disconnecting
    this.stopPingInterval();
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
    };
  }
}
