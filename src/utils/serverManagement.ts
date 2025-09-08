import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ClientManager } from "../services/clientManager.js";
import { SyncService, SyncEventType } from "../services/syncService.js";
import type { McpServerConfig, RouterConfig, RouterStats } from "../types/index.js";
import { jsonSchemaToZodShape, type JsonSchema } from "./schemaTransform.js";

const registeredTools = new Set<string>();
const toolToServerMap = new Map<string, string>();

export const registerServer = async (
  serverConfig: McpServerConfig,
  clientManager: ClientManager,
  config: RouterConfig,
  stats: RouterStats,
  server: McpServer,
  syncService?: SyncService,
): Promise<{
  success: boolean;
  message: string;
  server?: McpServerConfig;
  stats?: unknown;
  error?: string;
}> => {
  try {
    // Basic input validation
    if (!serverConfig.name || typeof serverConfig.name !== "string" || serverConfig.name.trim() === "") {
      return {
        success: false,
        message: "Server name is required and must be a non-empty string",
        error: "Invalid server name",
      };
    }

    if (!serverConfig.url || typeof serverConfig.url !== "string" || serverConfig.url.trim() === "") {
      return {
        success: false,
        message: "Server URL is required and must be a non-empty string",
        error: "Invalid server URL",
      };
    }

    // Validate server name format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(serverConfig.name.trim())) {
      return {
        success: false,
        message: "Server name can only contain letters, numbers, hyphens, and underscores",
        error: "Invalid server name format",
      };
    }

    // Validate URL format
    try {
      new URL(serverConfig.url.trim());
    } catch {
      return {
        success: false,
        message: "Server URL must be a valid URL",
        error: "Invalid URL format",
      };
    }

    // Normalize inputs
    serverConfig.name = serverConfig.name.trim();
    serverConfig.url = serverConfig.url.trim();
    const existingServers = clientManager.getServerStatuses();
    const existingIndex = config.servers.findIndex(s => s.name === serverConfig.name);
    const existingServer = existingServers.find(s => s.name === serverConfig.name);
    const isUpdate = existingServer !== undefined;

    // Validate server name and URL consistency
    if (isUpdate && existingIndex >= 0) {
      const currentConfig = config.servers[existingIndex];
      if (currentConfig.url !== serverConfig.url) {
        return {
          success: false,
          message: `Server name "${serverConfig.name}" is already registered with URL "${currentConfig.url}". Cannot register with different URL "${serverConfig.url}".`,
          error: "Name/URL conflict",
        };
      }
    }

    if (existingIndex >= 0) {
      config.servers[existingIndex] = serverConfig;
    } else {
      config.servers.push(serverConfig);
    }

    const oldToolPrefix = `${serverConfig.name}:`;
    const toolsToRemove = Array.from(registeredTools).filter(toolName =>
      toolName.startsWith(oldToolPrefix),
    );

    console.log(`Clearing ${toolsToRemove.length} existing tools for server ${serverConfig.name}`);

    toolsToRemove.forEach(toolName => {
      console.log(`  Removing tool: ${toolName}`);
      registeredTools.delete(toolName);
      toolToServerMap.delete(toolName);
    });

    await clientManager.connectToServer(serverConfig);

    const tools = await clientManager.buildServerTools(serverConfig);

    if (tools) {
      for (const tool of tools) {
        if (registeredTools.has(tool.name)) {
          console.log(`Tool ${tool.name} already registered, skipping...`);
          continue;
        }

        const zodShape = jsonSchemaToZodShape(tool.inputSchema as JsonSchema);

        const mcpServer = server as {
          tool: (name: string, desc: string, schema: Record<string, unknown>,
          callback: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => void
        };

        mcpServer.tool(
          tool.name,
          tool.description || "Tool from registered MCP server",
          zodShape,
          async (args: Record<string, unknown>, extra?: unknown) => {
            const serverName = toolToServerMap.get(tool.name);

            if (!serverName || !registeredTools.has(tool.name)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Server for tool ${tool.name} has been unregistered`,
                  },
                ],
                isError: true,
              };
            }

            return await tool.handler(args, extra);
          },
        );

        registeredTools.add(tool.name);
        toolToServerMap.set(tool.name, serverConfig.name);
      }
    }

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    const action = isUpdate ? "Updated" : "Registered";

    console.log(`${action} server: ${serverConfig.name}`);

    // Publish sync event for other instances
    if (syncService) {
      await syncService.publishEvent(
        isUpdate ? SyncEventType.SERVER_UPDATED : SyncEventType.SERVER_REGISTERED,
        serverConfig as unknown as Record<string, unknown>,
      );
    }

    return {
      success: true,
      message: `Successfully ${action.toLowerCase()} server: ${serverConfig.name}`,
      server: serverConfig,
      stats: {
        totalServers: stats.totalServers,
        connectedServers: stats.connectedServers,
        totalTools: stats.totalTools,
      },
    };
  } catch (error: unknown) {
    console.error(`Error registering server ${serverConfig.name}:`, error);

    return {
      success: false,
      message: `Error registering server ${serverConfig.name}`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

export const unregisterServer = async (
  serverName: string,
  clientManager: ClientManager,
  config: RouterConfig,
  stats: RouterStats,
  syncService?: SyncService,
): Promise<{
  success: boolean;
  message: string;
  stats?: unknown;
  error?: string;
}> => {
  try {
    const serverIndex = config.servers.findIndex(s => s.name === serverName);
    const existingServers = clientManager.getServerStatuses();

    if (!existingServers.find(s => s.name === serverName)) {
      return {
        success: false,
        message: `Server not found: ${serverName}`,
        error: "Server not found",
      };
    }

    const toolPrefix = `${serverName}:`;
    const toolsToRemove = Array.from(registeredTools).filter(toolName =>
      toolName.startsWith(toolPrefix),
    );

    console.log(`Removing ${toolsToRemove.length} tools from server ${serverName}`);

    toolsToRemove.forEach(toolName => {
      registeredTools.delete(toolName);
      toolToServerMap.delete(toolName);
      console.log(`  Removed tool: ${toolName}`);
    });

    if (serverIndex !== -1) {
      config.servers.splice(serverIndex, 1);
    }

    await clientManager.disconnectFromServer(serverName);

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    console.log(`Unregistered server: ${serverName}`);

    // Publish sync event for other instances
    if (syncService) {
      await syncService.publishEvent(
        SyncEventType.SERVER_UNREGISTERED,
        { name: serverName },
      );
    }

    return {
      success: true,
      message: `Successfully unregistered server: ${serverName}`,
      stats: {
        totalServers: stats.totalServers,
        connectedServers: stats.connectedServers,
        totalTools: stats.totalTools,
      },
    };
  } catch (error: unknown) {
    console.error(`Error unregistering server ${serverName}:`, error);

    return {
      success: false,
      message: `Error unregistering server ${serverName}`,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

export const isToolActive = (toolName: string): boolean => {
  return registeredTools.has(toolName);
};

export const getActiveTools = (): Set<string> => {
  return new Set(registeredTools);
};

export const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {return `${days}d ${hours % 24}h ${minutes % 60}m`;}
  if (hours > 0) {return `${hours}h ${minutes % 60}m`;}
  if (minutes > 0) {return `${minutes}m ${seconds % 60}s`;}

  return `${seconds}s`;
};
