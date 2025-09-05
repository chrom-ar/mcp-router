/**
 * Tests for TypeScript types and interfaces
 *
 * These tests validate that the types are properly structured and can be used correctly.
 */

import { describe, test, expect } from "vitest";
import type {
  Tool,
  McpServerConfig,
  RouterConfig,
  AggregatedTool,
  ServerStatus,
  ToolRoute,
  RouterStats,
  RoutedToolCall,
} from "./index.js";

describe("Types", () => {
  test("Tool interface should be properly typed", () => {
    const tool: Tool = {
      name: "test-tool",
      description: "Test tool description",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string" },
          param2: { type: "number" },
        },
        required: ["param1"],
      },
    };

    expect(tool.name).toBe("test-tool");
    expect(tool.description).toBe("Test tool description");
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["param1"]);
  });

  test("Tool interface should work without optional fields", () => {
    const minimalTool: Tool = {
      name: "minimal-tool",
      inputSchema: {
        type: "object",
      },
    };

    expect(minimalTool.name).toBe("minimal-tool");
    expect(minimalTool.description).toBeUndefined();
    expect(minimalTool.inputSchema.properties).toBeUndefined();
    expect(minimalTool.inputSchema.required).toBeUndefined();
  });

  test("McpServerConfig interface should be properly typed", () => {
    const config: McpServerConfig = {
      name: "test-server",
      url: "http://localhost:3000/mcp",
      description: "Test server",
      enabled: true,
      timeout: 5000,
      retryAttempts: 3,
    };

    expect(config.name).toBe("test-server");
    expect(config.url).toBe("http://localhost:3000/mcp");
    expect(config.description).toBe("Test server");
    expect(config.enabled).toBe(true);
    expect(config.timeout).toBe(5000);
    expect(config.retryAttempts).toBe(3);
  });

  test("McpServerConfig interface should work with minimal required fields", () => {
    const minimalConfig: McpServerConfig = {
      name: "minimal-server",
      url: "http://localhost:3000/mcp",
    };

    expect(minimalConfig.name).toBe("minimal-server");
    expect(minimalConfig.url).toBe("http://localhost:3000/mcp");
    expect(minimalConfig.description).toBeUndefined();
    expect(minimalConfig.enabled).toBeUndefined();
    expect(minimalConfig.timeout).toBeUndefined();
    expect(minimalConfig.retryAttempts).toBeUndefined();
  });

  test("RouterConfig interface should be properly typed", () => {
    const config: RouterConfig = {
      servers: [
        {
          name: "server1",
          url: "http://localhost:3000/mcp",
        },
        {
          name: "server2",
          url: "http://localhost:3001/mcp",
        },
      ],
      port: 4000,
      routerName: "test-router",
      routerVersion: "1.0.0",
      toolNameSeparator: ":",
    };

    expect(config.servers).toHaveLength(2);
    expect(config.port).toBe(4000);
    expect(config.routerName).toBe("test-router");
    expect(config.routerVersion).toBe("1.0.0");
    expect(config.toolNameSeparator).toBe(":");
  });

  test("AggregatedTool interface should extend Tool with server info", () => {
    const aggregatedTool: AggregatedTool = {
      name: "server1:test-tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
      },
      serverId: "server1",
      serverName: "server1",
      originalName: "test-tool",
    };

    expect(aggregatedTool.name).toBe("server1:test-tool");
    expect(aggregatedTool.serverId).toBe("server1");
    expect(aggregatedTool.serverName).toBe("server1");
    expect(aggregatedTool.originalName).toBe("test-tool");
    expect(aggregatedTool.description).toBe("Test tool");
    expect(aggregatedTool.inputSchema.type).toBe("object");
  });

  test("ServerStatus interface should be properly typed", () => {
    const status: ServerStatus = {
      name: "test-server",
      url: "http://localhost:3000/mcp",
      connected: true,
      lastConnected: new Date("2023-01-01"),
      lastError: "Some error",
      toolsCount: 5,
    };

    expect(status.name).toBe("test-server");
    expect(status.url).toBe("http://localhost:3000/mcp");
    expect(status.connected).toBe(true);
    expect(status.lastConnected).toBeInstanceOf(Date);
    expect(status.lastError).toBe("Some error");
    expect(status.toolsCount).toBe(5);
  });

  test("ServerStatus interface should work with minimal required fields", () => {
    const minimalStatus: ServerStatus = {
      name: "minimal-server",
      url: "http://localhost:3000/mcp",
      connected: false,
      toolsCount: 0,
    };

    expect(minimalStatus.name).toBe("minimal-server");
    expect(minimalStatus.url).toBe("http://localhost:3000/mcp");
    expect(minimalStatus.connected).toBe(false);
    expect(minimalStatus.toolsCount).toBe(0);
    expect(minimalStatus.lastConnected).toBeUndefined();
    expect(minimalStatus.lastError).toBeUndefined();
  });

  test("ToolRoute interface should be properly typed", () => {
    const route: ToolRoute = {
      serverId: "server1",
      serverName: "server1",
      originalToolName: "test-tool",
      serverUrl: "http://localhost:3000/mcp",
    };

    expect(route.serverId).toBe("server1");
    expect(route.serverName).toBe("server1");
    expect(route.originalToolName).toBe("test-tool");
    expect(route.serverUrl).toBe("http://localhost:3000/mcp");
  });

  test("RouterStats interface should be properly typed", () => {
    const stats: RouterStats = {
      totalServers: 3,
      connectedServers: 2,
      totalTools: 10,
      uptime: 123456,
      requestCount: 100,
      errorCount: 5,
    };

    expect(stats.totalServers).toBe(3);
    expect(stats.connectedServers).toBe(2);
    expect(stats.totalTools).toBe(10);
    expect(stats.uptime).toBe(123456);
    expect(stats.requestCount).toBe(100);
    expect(stats.errorCount).toBe(5);
  });

  test("RoutedToolCall interface should be properly typed", () => {
    const toolCall: RoutedToolCall = {
      toolName: "server1:test-tool",
      arguments: {
        param1: "value1",
        param2: 42,
      },
      route: {
        serverId: "server1",
        serverName: "server1",
        originalToolName: "test-tool",
        serverUrl: "http://localhost:3000/mcp",
      },
    };

    expect(toolCall.toolName).toBe("server1:test-tool");
    expect(toolCall.arguments.param1).toBe("value1");
    expect(toolCall.arguments.param2).toBe(42);
    expect(toolCall.route.serverId).toBe("server1");
    expect(toolCall.route.originalToolName).toBe("test-tool");
  });

  test("should handle empty objects and arrays correctly", () => {
    const emptyRouterConfig: RouterConfig = {
      servers: [],
    };

    const emptyArguments: Record<string, unknown> = {};

    expect(emptyRouterConfig.servers).toHaveLength(0);
    expect(Object.keys(emptyArguments)).toHaveLength(0);
  });
});
