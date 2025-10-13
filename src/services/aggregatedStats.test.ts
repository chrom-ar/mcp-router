import { describe, it, expect, beforeEach, vi } from "vitest";

import { ClientManager } from "./clientManager.js";
import type { McpServerConfig } from "../types/index.js";

describe("Aggregated Stats", () => {
  let clientManager: ClientManager;

  beforeEach(() => {
    clientManager = new ClientManager(":");
  });

  describe("getServersWithStatsTool", () => {
    it("should return empty array when no servers are connected", async () => {
      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toEqual([]);
    });

    it("should identify servers that have a stats tool", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-1",
        name: "test-server",
        url: "http://localhost:3000",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "stats", description: "Get stats" },
            { name: "other-tool", description: "Other tool" },
          ],
        }),
      };

      (clientManager as any).connections.set("test-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "test-server", url: "http://localhost:3000", toolsCount: 1 },
        tools: [],
      });

      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toEqual(["test-server"]);
      expect(mockClient.listTools).toHaveBeenCalled();
    });

    it("should not include servers without stats tool", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-2",
        name: "no-stats-server",
        url: "http://localhost:3001",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "other-tool", description: "Other tool" },
          ],
        }),
      };

      (clientManager as any).connections.set("no-stats-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "no-stats-server", url: "http://localhost:3001", toolsCount: 1 },
        tools: [],
      });

      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toEqual([]);
    });

    it("should not include disconnected servers", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-3",
        name: "disconnected-server",
        url: "http://localhost:3002",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "stats", description: "Get stats" },
          ],
        }),
      };

      (clientManager as any).connections.set("disconnected-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: false, name: "disconnected-server", url: "http://localhost:3002", toolsCount: 0 },
        tools: [],
      });

      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toEqual([]);
      expect(mockClient.listTools).not.toHaveBeenCalled();
    });

    it("should handle multiple servers with and without stats tools", async () => {
      const mockConfig1: McpServerConfig = {
        id: "test-4",
        name: "server-with-stats",
        url: "http://localhost:3003",
        enabled: true,
      };

      const mockConfig2: McpServerConfig = {
        id: "test-5",
        name: "server-without-stats",
        url: "http://localhost:3004",
        enabled: true,
      };

      const mockConfig3: McpServerConfig = {
        id: "test-6",
        name: "another-server-with-stats",
        url: "http://localhost:3005",
        enabled: true,
      };

      const mockClient1 = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "stats", description: "Get stats" },
            { name: "tool1", description: "Tool 1" },
          ],
        }),
      };

      const mockClient2 = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "tool2", description: "Tool 2" },
          ],
        }),
      };

      const mockClient3 = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "stats", description: "Server stats" },
          ],
        }),
      };

      (clientManager as any).connections.set("server-with-stats", {
        client: mockClient1,
        config: mockConfig1,
        status: { connected: true, name: "server-with-stats", url: "http://localhost:3003", toolsCount: 1 },
        tools: [],
      });

      (clientManager as any).connections.set("server-without-stats", {
        client: mockClient2,
        config: mockConfig2,
        status: { connected: true, name: "server-without-stats", url: "http://localhost:3004", toolsCount: 1 },
        tools: [],
      });

      (clientManager as any).connections.set("another-server-with-stats", {
        client: mockClient3,
        config: mockConfig3,
        status: { connected: true, name: "another-server-with-stats", url: "http://localhost:3005", toolsCount: 1 },
        tools: [],
      });

      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toHaveLength(2);
      expect(serversWithStats).toContain("server-with-stats");
      expect(serversWithStats).toContain("another-server-with-stats");
      expect(serversWithStats).not.toContain("server-without-stats");
    });

    it("should handle errors gracefully when checking tools", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-7",
        name: "error-server",
        url: "http://localhost:3006",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockRejectedValue(new Error("Failed to list tools")),
      };

      (clientManager as any).connections.set("error-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "error-server", url: "http://localhost:3006", toolsCount: 0 },
        tools: [],
      });

      const serversWithStats = await clientManager.getServersWithStatsTool();

      expect(serversWithStats).toEqual([]);
    });
  });

  describe("callServerStatsTool", () => {
    it("should call stats tool on a server and return result", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-8",
        name: "stats-server",
        url: "http://localhost:3007",
        enabled: true,
      };

      const mockStatsResult = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ totalRequests: 100, totalErrors: 5 }),
          },
        ],
      };

      const mockClient = {
        callTool: vi.fn().mockResolvedValue(mockStatsResult),
      };

      (clientManager as any).connections.set("stats-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "stats-server", url: "http://localhost:3007", toolsCount: 1 },
        tools: [],
      });

      const result = await clientManager.callServerStatsTool("stats-server");

      expect(result).toEqual(mockStatsResult);
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: "stats",
        arguments: {},
      });
    });

    it("should throw error when server is not found", async () => {
      await expect(clientManager.callServerStatsTool("non-existent-server")).rejects.toThrow(
        "Server non-existent-server not found",
      );
    });

    it("should throw error when server is not connected", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-9",
        name: "disconnected-stats-server",
        url: "http://localhost:3008",
        enabled: true,
      };

      (clientManager as any).connections.set("disconnected-stats-server", {
        client: {},
        config: mockConfig,
        status: { connected: false, name: "disconnected-stats-server", url: "http://localhost:3008", toolsCount: 0 },
        tools: [],
      });

      await expect(clientManager.callServerStatsTool("disconnected-stats-server")).rejects.toThrow(
        "Server disconnected-stats-server is not connected",
      );
    });

    it("should propagate errors from the stats tool call", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-10",
        name: "error-stats-server",
        url: "http://localhost:3009",
        enabled: true,
      };

      const mockClient = {
        callTool: vi.fn().mockRejectedValue(new Error("Stats tool failed")),
      };

      (clientManager as any).connections.set("error-stats-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "error-stats-server", url: "http://localhost:3009", toolsCount: 1 },
        tools: [],
      });

      await expect(clientManager.callServerStatsTool("error-stats-server")).rejects.toThrow("Stats tool failed");
    });

    it("should handle empty content in response", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-11",
        name: "empty-stats-server",
        url: "http://localhost:3010",
        enabled: true,
      };

      const mockStatsResult = {
        content: [],
      };

      const mockClient = {
        callTool: vi.fn().mockResolvedValue(mockStatsResult),
      };

      (clientManager as any).connections.set("empty-stats-server", {
        client: mockClient,
        config: mockConfig,
        status: { connected: true, name: "empty-stats-server", url: "http://localhost:3010", toolsCount: 1 },
        tools: [],
      });

      const result = await clientManager.callServerStatsTool("empty-stats-server");

      expect(result).toEqual({ content: [] });
    });
  });

  describe("stats tool filtering", () => {
    it("should filter out stats tools when loading server tools", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-12",
        name: "filter-test-server",
        url: "http://localhost:3011",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "stats", description: "Get server stats", inputSchema: {} },
            { name: "tool1", description: "Tool 1", inputSchema: {} },
            { name: "tool2", description: "Tool 2", inputSchema: {} },
          ],
        }),
        connect: vi.fn().mockResolvedValue(undefined),
      };

      const mockTransport = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      (clientManager as any).connections.set("filter-test-server", {
        client: mockClient,
        transport: mockTransport,
        config: mockConfig,
        status: { connected: true, name: "filter-test-server", url: "http://localhost:3011", toolsCount: 0 },
        tools: [],
      });

      await (clientManager as any).loadServerTools(mockConfig);

      const connection = (clientManager as any).connections.get("filter-test-server");

      expect(connection.tools).toHaveLength(2);
      expect(connection.tools.map((t: any) => t.name)).toEqual([
        "filter-test-server:tool1",
        "filter-test-server:tool2",
      ]);
      expect(connection.tools.map((t: any) => t.name)).not.toContain("filter-test-server:stats");
    });

    it("should not filter out other tools", async () => {
      const mockConfig: McpServerConfig = {
        id: "test-13",
        name: "no-stats-filter-server",
        url: "http://localhost:3012",
        enabled: true,
      };

      const mockClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            { name: "tool1", description: "Tool 1", inputSchema: {} },
            { name: "tool2", description: "Tool 2", inputSchema: {} },
          ],
        }),
        connect: vi.fn().mockResolvedValue(undefined),
      };

      const mockTransport = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      (clientManager as any).connections.set("no-stats-filter-server", {
        client: mockClient,
        transport: mockTransport,
        config: mockConfig,
        status: { connected: true, name: "no-stats-filter-server", url: "http://localhost:3012", toolsCount: 0 },
        tools: [],
      });

      await (clientManager as any).loadServerTools(mockConfig);

      const connection = (clientManager as any).connections.get("no-stats-filter-server");

      expect(connection.tools).toHaveLength(2);
      expect(connection.tools.map((t: any) => t.name)).toEqual([
        "no-stats-filter-server:tool1",
        "no-stats-filter-server:tool2",
      ]);
    });
  });
});
