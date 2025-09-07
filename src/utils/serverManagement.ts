import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ClientManager } from "../services/clientManager.js";
import type { McpServerConfig, RouterConfig, RouterStats } from "../types/index.js";

export const registerServer = async (
  serverConfig: McpServerConfig,
  clientManager: ClientManager,
  config: RouterConfig,
  stats: RouterStats,
  server: McpServer
): Promise<{
  success: boolean;
  message: string;
  server?: McpServerConfig;
  stats?: any;
  error?: string;
}> => {
  try {
    const existingServers = clientManager.getServerStatuses();
    const existingIndex = config.servers.findIndex(s => s.name === serverConfig.name);
    const isUpdate = existingServers.find(s => s.name === serverConfig.name) !== undefined;

    if (existingIndex >= 0) {
      config.servers[existingIndex] = serverConfig;
    } else {
      config.servers.push(serverConfig);
    }

    await clientManager.connectToServer(serverConfig);

    const tools = await clientManager.buildServerTools(serverConfig);

    if (tools) {
      for (const tool of tools) {
        (server.tool as unknown as (name: string, description: string, schema: unknown, handler: unknown) => void)(
          tool.name,
          tool.description,
          tool.schema,
          async (args: Record<string, unknown>, extra?: unknown) => {
            return await tool.handler(args, extra);
          },
        );
      }
    }

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    const action = isUpdate ? "Updated" : "Registered";

    console.log(`${action} server: ${serverConfig.name}`);

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
  stats: RouterStats
): Promise<{
  success: boolean;
  message: string;
  stats?: any;
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

    if (serverIndex !== -1) {
      config.servers.splice(serverIndex, 1);
    }

    await clientManager.disconnectFromServer(serverName);

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    console.log(`Unregistered server: ${serverName}`);

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

export const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;

  return `${seconds}s`;
};
