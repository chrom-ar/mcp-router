import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { jsonSchemaToZodShape, type JsonSchema } from "./schemaTransform.js";
import { ClientManager } from "../services/clientManager.js";
import { SyncService, SyncEventType } from "../services/syncService.js";
import type { McpServerConfig, RouterConfig, RouterStats } from "../types/index.js";

const registeredTools = new Map<string, RegisteredTool>();
const toolHandlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();

export const unregisterToolsFromMcpServer = (
  serverName: string,
): string[] => {
  const toolPrefix = `${serverName}-->`;
  const toolsToRemove: string[] = [];

  registeredTools.forEach((registeredTool, toolName) => {
    if (toolName.startsWith(toolPrefix)) {
      toolsToRemove.push(toolName);
      registeredTool.remove();
    }
  });

  // Clean up from our tracking maps
  toolsToRemove.forEach(toolName => {
    registeredTools.delete(toolName);
    toolHandlers.delete(toolName);
  });

  if (toolsToRemove.length > 0) {
    console.log(`Removed ${toolsToRemove.length} tools from ${serverName}`);
  }

  return toolsToRemove;
};

export const registerToolsWithMcpServer = async (
  serverConfig: McpServerConfig,
  clientManager: ClientManager,
  server: McpServer,
): Promise<void> => {
  const tools = await clientManager.buildServerTools(serverConfig);

  if (tools) {
    for (const tool of tools) {
      const existingTool = registeredTools.get(tool.name);
      const zodShape = jsonSchemaToZodShape(tool.inputSchema as JsonSchema);

      toolHandlers.set(tool.name, tool.handler);

      if (existingTool) {
        const existingSchemaStr = JSON.stringify(existingTool.inputSchema?._def);
        const newSchemaStr = JSON.stringify(zodShape);
        const schemaChanged = existingSchemaStr !== newSchemaStr;

        if (schemaChanged) {
          console.log(`Tool ${tool.name} schema changed, re-registering...`);
          existingTool.remove();
          registeredTools.delete(tool.name);
          // Fall through to register as new tool
        } else {
          // Tool exists and schema unchanged - handler is already updated in toolHandlers map
          // No listChanged notification needed since nothing visible changed
          continue;
        }
      }

      const registeredTool = server.registerTool(
        tool.name,
        {
          description: tool.description || "Tool from registered MCP server",
          inputSchema: zodShape,
        },
        async (args: Record<string, unknown>, extra?: unknown): Promise<CallToolResult> => {
          const currentHandler = toolHandlers.get(tool.name);

          if (!currentHandler) {
            throw new Error(`Tool handler not found for ${tool.name}`);
          }

          const result = await currentHandler(args, extra) as CallToolResult;

          if (result?.content?.[0]?.type === "text" && typeof result.content[0].text === "string") {
            try {
              const responseData = JSON.parse(result.content[0].text);

              if (responseData.models_metrics || responseData.modelsMetrics) {
                delete responseData.models_metrics;
                delete responseData.modelsMetrics;

                result.content[0].text = JSON.stringify(responseData);
              }
            } catch (parseError: unknown) {
              console.error("Failed to parse response for cleanup:", parseError);
            }
          }

          // Also clean up structuredContent if present
          const resultWithStructured = result as { structuredContent?: { result?: string } };

          if (resultWithStructured?.structuredContent?.result && typeof resultWithStructured.structuredContent.result === "string") {
            try {
              const structuredData = JSON.parse(resultWithStructured.structuredContent.result);

              if (structuredData.models_metrics || structuredData.modelsMetrics) {
                delete structuredData.models_metrics;
                delete structuredData.modelsMetrics;

                resultWithStructured.structuredContent.result = JSON.stringify(structuredData);
              }
            } catch (parseError: unknown) {
              console.error("Failed to parse response for cleanup:", parseError);
            }
          }

          return result;
        },
      );

      registeredTools.set(tool.name, registeredTool);
    }
  }
};

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
    } catch (error: unknown) {
      console.error(`Invalid URL format for ${serverConfig.url}:`, error);

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
          message: `Server "${serverConfig.name}" is already registered with a different URL. Current: ${currentConfig.url}, Attempted: ${serverConfig.url}. Please unregister the existing server first or use a different name.`,
          error: "Name/URL conflict",
        };
      }

      // Server already exists with the same URL
      const serverStatus = existingServer;

      if (serverStatus && serverStatus.connected) {
        // Already connected - just return success without re-registering tools
        const routerStats = clientManager.getStats();

        return {
          success: true,
          message: `Server "${serverConfig.name}" is already registered and connected. ${serverStatus.toolsCount || 0} tools available.`,
          server: serverConfig,
          stats: {
            totalServers: routerStats.totalServers,
            connectedServers: routerStats.connectedServers,
            totalTools: routerStats.totalTools,
          },
        };
      }
      // Server exists but is disconnected - will reconnect below
    }

    if (existingIndex >= 0) {
      config.servers[existingIndex] = serverConfig;
    } else {
      config.servers.push(serverConfig);
    }

    // For updates, we might need to reconnect if disconnected
    // But we should NOT unregister tools as they're still registered with the MCP server
    // The registeredTools Set tracks what's registered with the MCP server
    await clientManager.connectToServer(serverConfig);

    // Only register tools if the server is actually connected
    const serverStatuses = clientManager.getServerStatuses();
    const serverStatus = serverStatuses.find(s => s.name === serverConfig.name);

    if (serverStatus && serverStatus.connected) {
      // Register tools - the function already checks if tools are registered
      // via the registeredTools Set, so it won't try to register duplicates
      await registerToolsWithMcpServer(serverConfig, clientManager, server);
    }

    const routerStats = clientManager.getStats();

    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

    let action: string;
    let message: string;

    if (isUpdate) {
      if (existingServer && !existingServer.connected) {
        action = "Reconnected";
        message = `Successfully reconnected to server "${serverConfig.name}". ${serverStatus?.toolsCount || 0} tools available.`;
      } else {
        action = "Updated";
        message = `Successfully updated server "${serverConfig.name}". ${serverStatus?.toolsCount || 0} tools available.`;
      }
    } else {
      action = "Registered";
      message = `Successfully registered new server "${serverConfig.name}". ${serverStatus?.toolsCount || 0} tools available.`;
    }

    // Publish sync event for other instances
    if (syncService) {
      await syncService.publishEvent(
        isUpdate ? SyncEventType.SERVER_UPDATED : SyncEventType.SERVER_REGISTERED,
        serverConfig as unknown as Record<string, unknown>,
      );
    }

    return {
      success: true,
      message,
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

    if (serverIndex !== -1) {
      config.servers.splice(serverIndex, 1);
    }

    await clientManager.disconnectFromServer(serverName);

    const routerStats = clientManager.getStats();
    stats.totalServers = routerStats.totalServers;
    stats.connectedServers = routerStats.connectedServers;
    stats.totalTools = routerStats.totalTools;

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

export const Active = (toolName: string): boolean => {
  return registeredTools.has(toolName);
};

export const getActiveTools = (): Set<string> => {
  return new Set(registeredTools.keys());
};

export const formatUptime = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) { return `${days}d ${hours % 24}h ${minutes % 60}m`; }
  if (hours > 0) { return `${hours}h ${minutes % 60}m`; }
  if (minutes > 0) { return `${minutes}m ${seconds % 60}s`; }

  return `${seconds}s`;
};
