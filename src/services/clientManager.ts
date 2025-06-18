import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  McpServerConfig,
    ServerStatus,
    AggregatedTool,
    ToolRoute
} from '../types/index.js';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import { z, ZodRawShape } from 'zod';
// @ts-ignore - z is used in eval() but TypeScript can't detect it
z;

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

  constructor(toolNameSeparator: string = ':') {
    this.toolNameSeparator = toolNameSeparator;
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
      console.log(`Connecting to MCP server: ${config.name} at ${config.url}`);

      const client = new Client({
        name: 'mcp-router-client',
        version: '1.0.0'
      });

      client.onerror = (error: any) => {
        console.log(`Client error for ${config.name}:`, error);
        this.updateServerStatus(config.name, { connected: false, lastError: error?.message || 'Unknown error' });
      };

      const transport = new StreamableHTTPClientTransport(new URL(config.url));
      await client.connect(transport);

      const status: ServerStatus = {
        name: config.name,
        url: config.url,
        connected: true,
        lastConnected: new Date(),
        toolsCount: 0
      };

      const connection: ClientConnection = {
        client,
        transport,
        config,
        status,
        tools: []
      };

      this.connections.set(config.id, connection);

      console.log(`Successfully connected to ${config.id}`);
    } catch (error) {
      console.error(`Failed to connect to ${config.name}:`, error);
      const status: ServerStatus = {
        name: config.name,
        url: config.url,
        connected: false,
        lastError: error instanceof Error ? error.message : 'Unknown error',
        toolsCount: 0
      };

      // Store failed connection for status tracking
      this.connections.set(config.name, {
        client: null as any,
        transport: null as any,
        config,
        status,
        tools: []
      });
    }
  }

  /**
   * Load tools from a connected server
   */
  async buildServerTools(config: McpServerConfig): Promise<any> {
    const connection = this.connections.get(config.id);

    if (!connection || !connection.client || !connection.status.connected) {
      return;
    }

    try {
      const toolsResult = await connection.client.listTools();
      if (toolsResult && toolsResult.tools) {
        const aggregatedTools: AggregatedTool[] = toolsResult.tools.map((tool: any) => {
          const aggregatedName = `${config.id}${this.toolNameSeparator}${tool.name}`;

          const schema: ZodRawShape = eval(jsonSchemaToZod(tool.inputSchema));

          return {
            name: aggregatedName,
            description: `[${config.name}] ${tool.description}`,
            schema: schema,
            handler: async (args: any) => {
              try {
                // stats.requestCount++;
                console.log(`Routing ${config.name}:${tool.name} with args: ${JSON.stringify(args)}`);

                const result = await connection.client.callTool({
                  name: tool.name,
                  arguments: args || {}
                });
                return result;
              } catch (error) {
                // stats.errorCount++;
                console.error(`Error calling tool ${tool.name}:`, error);
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Error calling tool ${tool.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
                    }
                  ],
                  isError: true
                };
              }
            }
          };
        });

        connection.tools = aggregatedTools;
        connection.status.toolsCount = aggregatedTools.length;

        return aggregatedTools;
      }
    } catch (error) {
      console.error(`Failed to load tools from ${config.name}:`, error);
      connection.status.lastError = error instanceof Error ? error.message : 'Failed to load tools';
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
  // async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  //   const route = this.toolRoutes.get(toolName);
  //   if (!route) {
  //     throw new Error(`Tool not found: ${toolName}`);
  //   }

  //   const connection = this.connections.get(route.serverId);
  //   if (!connection || !connection.client || !connection.status.connected) {
  //     throw new Error(`Server ${route.serverName} is not connected`);
  //   }

  //   try {
  //     console.error(`Routing tool call ${toolName} to server ${route.serverName}`);

  //     const result = await connection.client.callTool({
  //       name: route.originalToolName,
  //       arguments: args
  //     });

  //     return result;
  //   } catch (error) {
  //     console.error(`Error calling tool ${toolName} on server ${route.serverName}:`, error);
  //     throw error;
  //   }
  // }

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

    // Close existing connection if any
    if (connection.transport) {
      try {
        await connection.transport.close();
      } catch (error) {
        console.error(`Error closing existing connection to ${serverName}:`, error);
      }
    }

    // Remove old connection
    this.connections.delete(serverName);
    this.clearServerRoutes(serverName);

    // Reconnect
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

    // Close existing connection if any
    if (connection.transport) {
      try {
        await connection.transport.close();
      } catch (error) {
        console.error(`Error closing connection to ${serverName}:`, error);
      }
    }

    // Remove connection and routes
    this.connections.delete(serverName);
    this.clearServerRoutes(serverName);

    console.error(`Disconnected from server: ${serverName}`);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.connections.values()).map(async (connection) => {
      if (connection.transport) {
        try {
          await connection.transport.close();
        } catch (error) {
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
      conn => conn.status.connected
    ).length;

    return {
      totalServers: this.connections.size,
      connectedServers,
      totalTools: this.getAllTools().length,
      toolRoutes: this.toolRoutes.size
    };
  }
}
