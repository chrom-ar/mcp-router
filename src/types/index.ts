import { ZodRawShape } from 'zod';

// Basic tool interface (matching MCP SDK Tool type)
export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// Configuration for a single MCP server
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  description?: string;
  enabled?: boolean;
  timeout?: number;
  retryAttempts?: number;
}

// Router configuration
export interface RouterConfig {
  servers: McpServerConfig[];
  port?: number;
  routerName?: string;
  routerVersion?: string;
  toolNameSeparator?: string; // Used to separate server name from tool name (e.g., "server:tool")
}

// Aggregated tool with server information
export interface AggregatedTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: any) => Promise<any>;
}

// Server connection status
export interface ServerStatus {
  name: string;
  url: string;
  connected: boolean;
  lastConnected?: Date;
  lastError?: string;
  toolsCount: number;
}

// Tool call routing information
export interface ToolRoute {
  serverId: string;
  serverName: string;
  originalToolName: string;
  serverUrl: string;
}

// Router stats
export interface RouterStats {
  totalServers: number;
  connectedServers: number;
  totalTools: number;
  uptime: number;
  requestCount: number;
  errorCount: number;
}

// Tool call request with routing context
export interface RoutedToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  route: ToolRoute;
}
