import { ZodRawShape } from "zod";

// Basic tool interface (matching MCP SDK Tool type)
export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
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
  autoReconnect?: boolean; // Whether to automatically reconnect on ping failures
}

// Input configuration for creating/updating servers (id is optional/generated)
export type McpServerConfigInput = Omit<McpServerConfig, "id"> & { id?: string; };

// Router configuration
export interface RouterConfig {
  servers: McpServerConfig[];
  port?: number;
  routerName?: string;
  routerVersion?: string;
  toolNameSeparator?: string; // Used to separate server name from tool name (e.g., "server:tool")
}

// Tool handler types - matches MCP SDK's CallToolResult
export type ToolHandlerResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: unknown;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ToolHandlerArgs = Record<string, unknown>;

// Aggregated tool with server information
export interface AggregatedTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  inputSchema: unknown; // Original JSON Schema for MCP registration
  handler: (args: ToolHandlerArgs, extra?: unknown) => Promise<ToolHandlerResult>;
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

// Router stats
export interface RouterStats {
  totalServers: number;
  connectedServers: number;
  totalTools: number;
  uptime: number;
  requestCount: number;
  errorCount: number;
}

