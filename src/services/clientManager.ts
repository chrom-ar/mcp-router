import { ZodRawShape } from "zod";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { CreditManager } from "./creditManager.js";
import { EventLogger } from "./eventLogger.js";
import { AuditLogger } from "./auditLogger.js";
import { getRequestContext } from "./requestContext.js";
import { ServerRepository } from "../repositories/serverRepository.js";

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
  reconnectAttempts?: number;
}

export class ClientManager {
  private connections = new Map<string, ClientConnection>();
  private toolNameSeparator: string;
  private serverRepository?: ServerRepository;
  private eventLogger?: EventLogger;
  private auditLogger?: AuditLogger;
  private creditManager?: CreditManager;
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

    try {
      this.creditManager = new CreditManager();
    } catch (error: unknown) {
      console.error("Credit manager not initialized:", error);
    }
  }

  async loadPersistedServers(): Promise<void> {
    if (!this.serverRepository) {
      return;
    }

    try {
      const servers = await this.serverRepository.getAllAsConfigs();

      if (servers.length > 0) {
        await this.connectToServers(servers);
        this.startPingInterval();
      }
    } catch (error: unknown) {
      console.error("Failed to load persisted servers:", error);
    }
  }

  async connectToServers(configs: McpServerConfig[]): Promise<void> {
    const connectionPromises = configs
      .filter(config => config.enabled !== false)
      .map(config => this.connectToServer(config));

    await Promise.allSettled(connectionPromises);

    if (this.connections.size > 0) {
      this.startPingInterval();
    }
  }

  async connectToServer(config: McpServerConfig): Promise<void> {
    try {
      if (this.serverRepository) {
        try {
          const serverRecord = await this.serverRepository.upsert(config);

          config.id = serverRecord.id;
        } catch (dbError: unknown) {
          console.error(`Failed to persist server ${config.name}:`, dbError);
        }
      }

      const client = new Client({
        name: "mcp-router-client",
        version: "1.0.0",
      });

      const serverId = config.name;

      client.onerror = (error: unknown) => {
        this.updateServerStatus(serverId, { connected: false, lastError: error instanceof Error ? error.message : "Unknown error" });

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

      await this.loadServerTools(config);

      if (this.eventLogger && config.id) {
        await this.eventLogger.logConnection(config.id, config.name, {
          url: config.url,
          toolsCount: connection.status.toolsCount,
        });
      }
    } catch (error: unknown) {
      console.error(`Failed to connect to ${config.name}:`, error);

      const status: ServerStatus = {
        name: config.name,
        url: config.url,
        connected: false,
        lastError: error instanceof Error ? error.message : "Unknown error",
        toolsCount: 0,
      };

      this.connections.set(config.name, {
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
            handler: async (args: ToolHandlerArgs, extra?: unknown): Promise<ToolHandlerResult> => {
              return await this.callTool(aggregatedName, args);
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

  async buildServerTools(config: McpServerConfig): Promise<AggregatedTool[] | undefined> {
    await this.loadServerTools(config);

    const connection = this.connections.get(config.name);

    return connection?.tools;
  }

  getAllTools(): AggregatedTool[] {
    const allTools: AggregatedTool[] = [];

    for (const connection of this.connections.values()) {
      if (connection.status.connected && connection.tools) {
        allTools.push(...connection.tools);
      }
    }

    return allTools;
  }

  hasServerTool(serverName: string, toolName: string): boolean {
    const connection = this.connections.get(serverName);

    if (!connection || !connection.status.connected || !connection.tools) {
      return false;
    }

    const fullToolName = `${serverName}${this.toolNameSeparator}${toolName}`;
    return connection.tools.some(tool => tool.name === fullToolName);
  }

  async callTool(toolName: string, args: ToolHandlerArgs): Promise<ToolHandlerResult> {
    const separatorIndex = toolName.indexOf(this.toolNameSeparator);

    if (separatorIndex === -1) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const serverName = toolName.substring(0, separatorIndex);
    const actualToolName = toolName.substring(separatorIndex + this.toolNameSeparator.length);
    const context = getRequestContext();

    if (this.creditManager && context?.apiKey) {
      const hasQuoteTool = this.hasServerTool(serverName, 'quote');
      const result = await this.creditManager.executeWithCreditCheck(
        serverName,
        actualToolName,
        args,
        async (fullToolName, toolArgs) => {
          return await this._internalCallTool(fullToolName, toolArgs);
        },
        hasQuoteTool
      );
      return result as ToolHandlerResult;
    }

    return await this._internalCallTool(toolName, args);
  }

  private async _internalCallTool(toolName: string, args: ToolHandlerArgs): Promise<ToolHandlerResult> {
    const separatorIndex = toolName.indexOf(this.toolNameSeparator);

    if (separatorIndex === -1) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const serverName = toolName.substring(0, separatorIndex);
    const actualToolName = toolName.substring(separatorIndex + this.toolNameSeparator.length);
    let connection = this.connections.get(serverName);

    if (!connection) {
      if (this.serverRepository) {
        try {
          const serverConfig = await this.serverRepository.getByName(serverName);

          if (serverConfig && serverConfig.enabled) {
            await this.connectToServer({
              id: serverConfig.id,
              name: serverConfig.name,
              url: serverConfig.url,
              description: serverConfig.description || undefined,
              enabled: serverConfig.enabled,
            });

            connection = this.connections.get(serverName);
          }
        } catch (error: unknown) {
          console.error(`Failed to connect to server ${serverName}:`, error);
        }
      }

      if (!connection) {
        throw new Error(`Server ${serverName} not found`);
      }
    }

    if (!connection.status.connected) {
      try {
        console.log(`Server ${serverName} disconnected, attempting to reconnect...`);

        await this.reconnectToServer(serverName);

        connection = this.connections.get(serverName);

        if (!connection || !connection.status.connected) {
          throw new Error(`Server ${serverName} is not connected and reconnection failed`);
        }
      } catch (error: unknown) {
        throw new Error(`Server ${serverName} is not connected`);
      }
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
      if (this.auditLogger) {
        const durationMs = Date.now() - startTime;
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
        }).catch(error => {
          console.error("Failed to log tool call audit:", error);
        });
      }
    }
  }

  getServerStatuses(): ServerStatus[] {
    return Array.from(this.connections.values()).map(conn => conn.status);
  }

  private updateServerStatus(serverName: string, updates: Partial<ServerStatus>): void {
    const connection = this.connections.get(serverName);

    if (connection) {
      connection.status = { ...connection.status, ...updates };
    }
  }

  async reconnectToServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`Server ${serverName} not found`);
    }

    if (connection.transport && typeof connection.transport.close === 'function') {
      try {
        await connection.transport.close();
      } catch (error: unknown) {
        console.error(`Error closing existing connection to ${serverName}:`, error);
      }
    }

    this.connections.delete(serverName);

    await this.connectToServer(connection.config);
  }

  async disconnectFromServer(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);

    if (!connection) {

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

  private startPingInterval(): void {
    this.stopPingInterval();


    this.pingInterval = setInterval(async () => {
      await this.pingAllServers();
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  private async pingAllServers(): Promise<void> {
    const pingPromises = Array.from(this.connections.entries()).map(async ([serverId, connection]) => {
      if (!connection.status.connected) {
        const lastAttempt = connection.lastPingTime || new Date(0);
        const timeSinceLastAttempt = Date.now() - lastAttempt.getTime();

        if (connection.config.autoReconnect !== false && timeSinceLastAttempt > 60000) {
          connection.lastPingTime = new Date();
          connection.reconnectAttempts = (connection.reconnectAttempts || 0) + 1;


          try {
            await this.reconnectToServer(serverId);

            const newConnection = this.connections.get(serverId);

            if (newConnection && newConnection.status.connected) {
              console.log(`Reconnected to ${connection.config.name} after ${connection.reconnectAttempts} attempts`);

              connection.reconnectAttempts = 0;
            } else {
              if (connection.reconnectAttempts % 20 === 0) {
                console.error(`Unable to reconnect to ${connection.config.name} after ${connection.reconnectAttempts} attempts`);
              }
            }
          } catch (error: unknown) {
            if (connection.reconnectAttempts % 20 === 0) {
              console.error(`Reconnection attempt ${connection.reconnectAttempts} failed for ${connection.config.name}:`, error);
            }
          }
        }
        return;
      }

      try {
        await connection.client.ping();

        connection.lastPingTime = new Date();
        connection.consecutivePingFailures = 0;

        if (connection.status.lastError?.includes("ping")) {
          connection.status.lastError = undefined;
        }
      } catch (error: unknown) {
        connection.consecutivePingFailures = (connection.consecutivePingFailures || 0) + 1;

        const errorMessage = error instanceof Error ? error.message : "Ping failed";

        console.error(`Ping failed for server ${connection.config.name}: ${errorMessage}`);

        if (connection.consecutivePingFailures >= this.maxConsecutivePingFailures) {
          connection.status.connected = false;
          connection.status.lastError = `Server not responding to ping (${connection.consecutivePingFailures} consecutive failures)`;

          connection.tools = [];

          if (this.eventLogger && connection.config.id) {
            await this.eventLogger.logDisconnection(
              connection.config.id,
              connection.config.name,
              `Ping timeout after ${connection.consecutivePingFailures} failures`,
            );
          }

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

  async disconnectAll(): Promise<void> {
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
