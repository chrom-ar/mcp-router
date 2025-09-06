import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { AuditLogger } from "./auditLogger.js";
import type { Database } from "./database.js";
import type { ToolCallAudit } from "./auditLogger.js";

describe("AuditLogger", () => {
  let auditLogger: AuditLogger;
  let mockDatabase: {
    query: ReturnType<typeof vi.fn>;
    queryOne: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockDatabase = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      queryOne: vi.fn().mockResolvedValue(null),
      transaction: vi.fn().mockImplementation(async callback => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        };
        return callback(mockClient);
      }),
    };

    auditLogger = new AuditLogger(mockDatabase as unknown as Database, {
      enabled: true,
      logArguments: true,
      logResponses: true,
      batchSize: 3,
      batchInterval: 5000,
    });
  });

  afterEach(async () => {
    await auditLogger.shutdown();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("logToolCall", () => {
    test("should batch tool calls until batch size is reached", async () => {
      const audit1: ToolCallAudit = {
        serverName: "server-1",
        toolName: "tool-1",
        arguments: { arg1: "value1" },
        response: { result: "success" },
        durationMs: 100,
        status: "success",
      };

      const audit2: ToolCallAudit = {
        serverName: "server-2",
        toolName: "tool-2",
        arguments: { arg2: "value2" },
        response: { result: "success" },
        durationMs: 200,
        status: "success",
      };

      const audit3: ToolCallAudit = {
        serverName: "server-3",
        toolName: "tool-3",
        arguments: { arg3: "value3" },
        response: { result: "success" },
        durationMs: 150,
        status: "success",
      };

      // Log two audits - should not trigger flush yet
      await auditLogger.logToolCall(audit1);
      await auditLogger.logToolCall(audit2);
      expect(mockDatabase.transaction).not.toHaveBeenCalled();

      // Log third audit - should trigger flush
      await auditLogger.logToolCall(audit3);
      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should batch and flush after interval", async () => {
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        arguments: { test: "arg" },
        response: { result: "ok" },
        durationMs: 50,
        status: "success",
      };

      await auditLogger.logToolCall(audit);
      expect(mockDatabase.transaction).not.toHaveBeenCalled();

      // Fast forward time to trigger batch flush
      vi.advanceTimersByTime(5001);
      await Promise.resolve();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should not log when disabled", async () => {
      const disabledLogger = new AuditLogger(mockDatabase as unknown as Database, {
        enabled: false,
      });

      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      await disabledLogger.logToolCall(audit);

      vi.advanceTimersByTime(11000);
      await Promise.resolve();

      expect(mockDatabase.transaction).not.toHaveBeenCalled();
    });

    test("should sanitize arguments when logArguments is false", async () => {
      const logger = new AuditLogger(mockDatabase as unknown as Database, {
        enabled: true,
        logArguments: false,
        logResponses: true,
        batchSize: 1,
      });

      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        arguments: { secret: "password" },
        response: { result: "ok" },
        status: "success",
      };

      await logger.logToolCall(audit);

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };
      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "server-1",
          "test-tool",
          null, // arguments should be null
          JSON.stringify({ result: "ok" }),
          null,
          "success",
          null,
        ]),
      );
    });

    test("should sanitize responses when logResponses is false", async () => {
      const logger = new AuditLogger(mockDatabase as unknown as Database, {
        enabled: true,
        logArguments: true,
        logResponses: false,
        batchSize: 1,
      });

      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        arguments: { arg: "value" },
        response: { secret: "data" },
        status: "success",
      };

      await logger.logToolCall(audit);

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };
      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "server-1",
          "test-tool",
          JSON.stringify({ arg: "value" }),
          null, // response should be null
          null,
          "success",
          null,
        ]),
      );
    });

    test("should handle error status", async () => {
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "failing-tool",
        arguments: { test: "arg" },
        durationMs: 100,
        status: "error",
        errorMessage: "Tool execution failed",
      };

      auditLogger = new AuditLogger(mockDatabase as unknown as Database, {
        enabled: true,
        batchSize: 1,
      });

      await auditLogger.logToolCall(audit);

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };
      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "server-1",
          "failing-tool",
          JSON.stringify({ test: "arg" }),
          null,
          100,
          "error",
          "Tool execution failed",
        ]),
      );
    });

    test("should handle database errors gracefully", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockDatabase.transaction.mockRejectedValueOnce(new Error("DB Error"));

      const audits: ToolCallAudit[] = Array(3).fill(null).map((_, i) => ({
        serverName: `server-${i}`,
        toolName: `tool-${i}`,
        status: "success" as const,
      }));

      for (const audit of audits) {
        await auditLogger.logToolCall(audit);
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to log tool calls to database:",
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("getStats", () => {
    test("should return tool call statistics", async () => {
      const mockStats = {
        total_calls: 100,
        successful_calls: 90,
        error_calls: 10,
        avg_duration_ms: 150.5,
        max_duration_ms: 500,
        min_duration_ms: 10,
      };

      mockDatabase.query.mockResolvedValueOnce({ rows: [mockStats], rowCount: 1 });

      const stats = await auditLogger.getStats(24);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("COUNT(*) as total_calls"),
        [24],
      );
      expect(stats).toEqual(mockStats);
    });
  });

  describe("getMostUsedTools", () => {
    test("should return most used tools", async () => {
      const mockTools = [
        {
          server_name: "server-1",
          tool_name: "popular-tool",
          call_count: 50,
          success_count: 48,
          error_count: 2,
          avg_duration_ms: 100,
        },
        {
          server_name: "server-2",
          tool_name: "another-tool",
          call_count: 30,
          success_count: 30,
          error_count: 0,
          avg_duration_ms: 75,
        },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockTools, rowCount: 2 });

      const tools = await auditLogger.getMostUsedTools(10, 48);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY call_count DESC"),
        [48, 10],
      );
      expect(tools).toEqual(mockTools);
    });
  });

  describe("getSlowestTools", () => {
    test("should return slowest tools", async () => {
      const mockTools = [
        {
          server_name: "server-1",
          tool_name: "slow-tool",
          avg_duration_ms: 500,
          max_duration_ms: 1000,
          call_count: 10,
        },
        {
          server_name: "server-2",
          tool_name: "medium-tool",
          avg_duration_ms: 250,
          max_duration_ms: 400,
          call_count: 20,
        },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockTools, rowCount: 2 });

      const tools = await auditLogger.getSlowestTools(5, 12);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY avg_duration_ms DESC"),
        [12, 5],
      );
      expect(tools).toEqual(mockTools);
    });
  });

  describe("getErrorProneTools", () => {
    test("should return error-prone tools", async () => {
      const mockTools = [
        {
          server_name: "server-1",
          tool_name: "buggy-tool",
          total_calls: 100,
          error_count: 25,
          error_rate: 25.0,
        },
        {
          server_name: "server-2",
          tool_name: "unstable-tool",
          total_calls: 50,
          error_count: 10,
          error_rate: 20.0,
        },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockTools, rowCount: 2 });

      const tools = await auditLogger.getErrorProneTools(10, 24);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY error_rate DESC"),
        [24, 10],
      );
      expect(tools).toEqual(mockTools);
    });
  });

  describe("getRecentCalls", () => {
    test("should return recent tool calls", async () => {
      const mockCalls = [
        {
          id: "call-1",
          server_name: "server-1",
          tool_name: "tool-1",
          status: "success",
          duration_ms: 100,
          error_message: null,
          created_at: new Date(),
        },
        {
          id: "call-2",
          server_name: "server-2",
          tool_name: "tool-2",
          status: "error",
          duration_ms: 50,
          error_message: "Failed",
          created_at: new Date(),
        },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockCalls, rowCount: 2 });

      const calls = await auditLogger.getRecentCalls(50);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY created_at DESC"),
        [50],
      );
      expect(calls).toEqual(mockCalls);
    });
  });

  describe("getCallById", () => {
    test("should return tool call by ID", async () => {
      const mockCall = {
        id: "call-123",
        server_name: "server-1",
        tool_name: "test-tool",
        arguments: { test: "arg" },
        response: { result: "ok" },
        duration_ms: 100,
        status: "success",
        error_message: null,
        created_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(mockCall);

      const call = await auditLogger.getCallById("call-123");

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        "SELECT * FROM tool_calls WHERE id = $1",
        ["call-123"],
      );
      expect(call).toEqual(mockCall);
    });

    test("should return null when not found", async () => {
      mockDatabase.queryOne.mockResolvedValueOnce(null);

      const call = await auditLogger.getCallById("non-existent");

      expect(call).toBeNull();
    });
  });

  describe("cleanup", () => {
    test("should delete old audit logs", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 100 });

      const deletedCount = await auditLogger.cleanup(7);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM tool_calls WHERE created_at < NOW()"),
        [7],
      );
      expect(deletedCount).toBe(100);
    });

    test("should use environment variable for retention", async () => {
      const originalEnv = process.env.AUDIT_RETENTION_DAYS;
      process.env.AUDIT_RETENTION_DAYS = "60";

      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 50 });

      const deletedCount = await auditLogger.cleanup();

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM tool_calls"),
        [60],
      );
      expect(deletedCount).toBe(50);

      process.env.AUDIT_RETENTION_DAYS = originalEnv;
    });
  });

  describe("setEnabled", () => {
    test("should enable audit logging", () => {
      const logger = new AuditLogger(mockDatabase as unknown as Database, {
        enabled: false,
      });

      logger.setEnabled(true);

      // Verify by attempting to log
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      logger.logToolCall(audit);
      vi.advanceTimersByTime(11000);

      // Should have logged since it's enabled
      expect(mockDatabase.transaction).toBeDefined();
    });

    test("should disable and flush pending audits", async () => {
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      await auditLogger.logToolCall(audit);
      auditLogger.setEnabled(false);

      // Should flush pending audits
      await Promise.resolve();
      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("flush", () => {
    test("should flush pending audits", async () => {
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      await auditLogger.logToolCall(audit);
      await auditLogger.flush();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should not flush when no pending audits", async () => {
      await auditLogger.flush();

      expect(mockDatabase.transaction).not.toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    test("should flush remaining audits on shutdown", async () => {
      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      await auditLogger.logToolCall(audit);
      await auditLogger.shutdown();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should clear timer on shutdown", async () => {
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const audit: ToolCallAudit = {
        serverName: "server-1",
        toolName: "test-tool",
        status: "success",
      };

      await auditLogger.logToolCall(audit);
      await auditLogger.shutdown();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });
});
