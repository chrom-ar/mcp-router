import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { EventLogger } from "./eventLogger.js";
import type { Database } from "./database.js";
import type { ServerEvent, EventType } from "./eventLogger.js";

describe("EventLogger", () => {
  let eventLogger: EventLogger;
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

    eventLogger = new EventLogger(mockDatabase as unknown as Database, {
      batchSize: 3,
      batchInterval: 1000,
      enabled: true,
    });
  });

  afterEach(async () => {
    await eventLogger.shutdown();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("logEvent", () => {
    test("should batch events until batch size is reached", async () => {
      const event1: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server-1",
        eventType: "connected",
        details: { test: "data1" },
      };

      const event2: ServerEvent = {
        serverId: "server-2",
        serverName: "test-server-2",
        eventType: "disconnected",
        details: { test: "data2" },
      };

      const event3: ServerEvent = {
        serverId: "server-3",
        serverName: "test-server-3",
        eventType: "error",
        details: { error: "test error" },
      };

      // Log two events - should not trigger flush yet
      await eventLogger.logEvent(event1);
      await eventLogger.logEvent(event2);
      expect(mockDatabase.transaction).not.toHaveBeenCalled();

      // Log third event - should trigger flush
      await eventLogger.logEvent(event3);
      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should batch events and flush after interval", async () => {
      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
        details: { test: "data" },
      };

      await eventLogger.logEvent(event);
      expect(mockDatabase.transaction).not.toHaveBeenCalled();

      // Fast forward time to trigger batch flush
      vi.advanceTimersByTime(1001);
      await Promise.resolve(); // Let async operations complete

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should not log events when disabled", async () => {
      const disabledLogger = new EventLogger(mockDatabase as unknown as Database, {
        enabled: false,
      });

      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
      };

      await disabledLogger.logEvent(event);

      vi.advanceTimersByTime(6000);
      await Promise.resolve();

      expect(mockDatabase.transaction).not.toHaveBeenCalled();
    });

    test("should handle database errors gracefully", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockDatabase.transaction.mockRejectedValueOnce(new Error("DB Error"));

      const events: ServerEvent[] = Array(3).fill(null).map((_, i) => ({
        serverId: `server-${i}`,
        serverName: `test-server-${i}`,
        eventType: "connected" as EventType,
      }));

      for (const event of events) {
        await eventLogger.logEvent(event);
      }

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to log events to database:",
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe("logConnection", () => {
    test("should log connection event", async () => {
      await eventLogger.logConnection("server-1", "test-server", { version: "1.0.0" });

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };
      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "connected", JSON.stringify({ version: "1.0.0" })],
      );
    });
  });

  describe("logDisconnection", () => {
    test("should log disconnection event with reason", async () => {
      await eventLogger.logDisconnection("server-1", "test-server", "Connection lost");

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };
      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "disconnected", JSON.stringify({ reason: "Connection lost" })],
      );
    });

    test("should log disconnection event without reason", async () => {
      await eventLogger.logDisconnection("server-1", "test-server");

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };

      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "disconnected", "{}"],
      );
    });
  });

  describe("logError", () => {
    test("should log error event with Error object", async () => {
      const error = new Error("Test error");
      error.stack = "Error stack trace";

      await eventLogger.logError("server-1", "test-server", error);

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };

      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "error", expect.stringContaining("Test error")],
      );

      const details = JSON.parse(mockClient.query.mock.calls[0][1][2]);

      expect(details.error).toBe("Test error");
      expect(details.stack).toBe("Error stack trace");
    });

    test("should log error event with string", async () => {
      await eventLogger.logError("server-1", "test-server", "String error");

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };

      await transactionCall(mockClient);

      const details = JSON.parse(mockClient.query.mock.calls[0][1][2]);

      expect(details.error).toBe("String error");
      expect(details.stack).toBeUndefined();
    });
  });

  describe("logRegistration", () => {
    test("should log registration event", async () => {
      await eventLogger.logRegistration("server-1", "test-server", "http://localhost:3000");

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };

      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "registered", JSON.stringify({ url: "http://localhost:3000" })],
      );
    });
  });

  describe("logToolsLoaded", () => {
    test("should log tools loaded event", async () => {
      await eventLogger.logToolsLoaded("server-1", "test-server", 5);

      vi.advanceTimersByTime(1001);
      await Promise.resolve();

      const transactionCall = mockDatabase.transaction.mock.calls[0][0];
      const mockClient = { query: vi.fn() };

      await transactionCall(mockClient);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO server_events"),
        ["server-1", "tool_loaded", JSON.stringify({ toolCount: 5 })],
      );
    });
  });

  describe("getServerEvents", () => {
    test("should return server events", async () => {
      const mockEvents = [
        { id: "1", server_name: "test-server", event_type: "connected" },
        { id: "2", server_name: "test-server", event_type: "disconnected" },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockEvents, rowCount: 2 });

      const result = await eventLogger.getServerEvents("test-server", 50);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE s.name = $1"),
        ["test-server", 50],
      );
      expect(result).toEqual(mockEvents);
    });
  });

  describe("getEventsByType", () => {
    test("should return events by type", async () => {
      const mockEvents = [
        { id: "1", server_name: "server1", event_type: "error" },
        { id: "2", server_name: "server2", event_type: "error" },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockEvents, rowCount: 2 });

      const result = await eventLogger.getEventsByType("error", 100);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE se.event_type = $1"),
        ["error", 100],
      );
      expect(result).toEqual(mockEvents);
    });
  });

  describe("getServerHealth", () => {
    test("should return server health history", async () => {
      const mockEvents = [
        { id: "1", server_name: "test-server", event_type: "connected", created_at: new Date() },
        { id: "2", server_name: "test-server", event_type: "error", created_at: new Date() },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: mockEvents, rowCount: 2 });

      const result = await eventLogger.getServerHealth("test-server", 12);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("AND se.event_type IN ('connected', 'disconnected', 'error')"),
        ["test-server", 12],
      );
      expect(result).toEqual(mockEvents);
    });
  });

  describe("cleanup", () => {
    test("should delete old events", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 10 });

      const deletedCount = await eventLogger.cleanup(7);

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM server_events WHERE created_at < NOW() - INTERVAL"),
        [7],
      );
      expect(deletedCount).toBe(10);
    });

    test("should use default retention period", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 5 });

      const deletedCount = await eventLogger.cleanup();

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM server_events"),
        [30],
      );
      expect(deletedCount).toBe(5);
    });
  });

  describe("flush", () => {
    test("should flush pending events", async () => {
      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
      };

      await eventLogger.logEvent(event);
      await eventLogger.flush();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should not flush when no pending events", async () => {
      await eventLogger.flush();

      expect(mockDatabase.transaction).not.toHaveBeenCalled();
    });

    test("should clear batch timer on flush", async () => {
      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
      };

      await eventLogger.logEvent(event);

      // Timer should be set
      vi.advanceTimersByTime(500);

      // Manual flush should clear timer
      await eventLogger.flush();

      // Advancing time should not cause another flush
      vi.advanceTimersByTime(600);
      await Promise.resolve();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("shutdown", () => {
    test("should flush remaining events on shutdown", async () => {
      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
      };

      await eventLogger.logEvent(event);
      await eventLogger.shutdown();

      expect(mockDatabase.transaction).toHaveBeenCalledTimes(1);
    });

    test("should clear timer on shutdown", async () => {
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const event: ServerEvent = {
        serverId: "server-1",
        serverName: "test-server",
        eventType: "connected",
      };

      await eventLogger.logEvent(event);
      await eventLogger.shutdown();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });
});
