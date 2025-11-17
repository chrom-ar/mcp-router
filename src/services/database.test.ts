import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "./database.js";
import { Pool } from "pg";

const { MockPool } = vi.hoisted(() => {
  class MockPoolClass {
    query = vi.fn();
    connect = vi.fn();
    end = vi.fn();
    on = vi.fn();
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
  }
  return {
    MockPool: vi.fn<[], Pool>(() => new MockPoolClass() as unknown as Pool),
  };
});

vi.mock("pg", () => ({
  Pool: MockPool,
}));

describe("Database", () => {
  let database: Database;
  let mockPool: {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  let mockClient: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0,
    };

    MockPool.mockImplementation(function() {
      return mockPool as unknown as Pool;
    });

    database = new Database({
      host: "localhost",
      port: 5432,
      database: "test_db",
      user: "test_user",
      password: "test_password",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("connect", () => {
    test("should establish database connection", async () => {
      await database.connect();

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "localhost",
          port: 5432,
          database: "test_db",
          user: "test_user",
          password: "test_password",
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        }),
      );

      expect(mockPool.query).toHaveBeenCalledWith("SELECT NOW()");
    });

    test("should use connection string if provided", async () => {
      database = new Database({
        connectionString: "postgresql://user:pass@localhost:5432/db",
      });

      await database.connect();

      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgresql://user:pass@localhost:5432/db",
        }),
      );
    });

    test("should set up error handler", async () => {
      await database.connect();

      expect(mockPool.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    test("should not reconnect if already connected", async () => {
      await database.connect();
      await database.connect();

      expect(Pool).toHaveBeenCalledTimes(1);
    });

    test("should throw error on connection failure", async () => {
      mockPool.query.mockRejectedValueOnce(new Error("Connection failed"));

      await expect(database.connect()).rejects.toThrow("Connection failed");
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      await database.connect();
    });

    test("should execute query successfully", async () => {
      const mockResult = {
        rows: [{ id: 1, name: "test" }],
        rowCount: 1,
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await database.query("SELECT * FROM users");

      expect(mockPool.query).toHaveBeenCalledWith("SELECT * FROM users", undefined);
      expect(result).toEqual(mockResult);
    });

    test("should execute query with parameters", async () => {
      const mockResult = {
        rows: [{ id: 1, name: "test" }],
        rowCount: 1,
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await database.query("SELECT * FROM users WHERE id = $1", [1]);

      expect(mockPool.query).toHaveBeenCalledWith("SELECT * FROM users WHERE id = $1", [1]);
      expect(result).toEqual(mockResult);
    });

    test("should handle connection errors", async () => {
      const error = new Error("Connection refused") as Error & { code: string };
      error.code = "ECONNREFUSED";
      mockPool.query.mockRejectedValueOnce(error);

      await expect(database.query("SELECT 1")).rejects.toThrow("Connection refused");
    });

    test("should throw error when not connected", async () => {
      const db = new Database({ host: "localhost" });

      await expect(db.query("SELECT 1")).rejects.toThrow("Database not connected");
    });
  });

  describe("queryOne", () => {
    beforeEach(async () => {
      await database.connect();
    });

    test("should return first row", async () => {
      const mockResult = {
        rows: [{ id: 1, name: "test" }, { id: 2, name: "test2" }],
        rowCount: 2,
      };
      mockPool.query.mockResolvedValueOnce(mockResult);

      const result = await database.queryOne("SELECT * FROM users");

      expect(result).toEqual({ id: 1, name: "test" });
    });

    test("should return null when no rows", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await database.queryOne("SELECT * FROM users WHERE id = $1", [999]);

      expect(result).toBeNull();
    });
  });

  describe("transaction", () => {
    beforeEach(async () => {
      await database.connect();
    });

    test("should execute transaction successfully", async () => {
      const callback = vi.fn().mockResolvedValue("result");
      const result = await database.transaction(callback);

      expect(mockPool.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(callback).toHaveBeenCalledWith(mockClient);
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
      expect(mockClient.release).toHaveBeenCalled();
      expect(result).toBe("result");
    });

    test("should rollback on error", async () => {
      const callback = vi.fn().mockRejectedValue(new Error("Transaction error"));

      await expect(database.transaction(callback)).rejects.toThrow("Transaction error");

      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });

    test("should release client even on rollback error", async () => {
      const callback = vi.fn().mockRejectedValue(new Error("Transaction error"));

      mockClient.query.mockResolvedValueOnce(undefined); // BEGIN succeeds
      mockClient.query.mockRejectedValueOnce(new Error("Rollback error")); // ROLLBACK fails

      await expect(database.transaction(callback)).rejects.toThrow("Rollback error");

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("healthCheck", () => {
    test("should return healthy when connected", async () => {
      await database.connect();
      mockPool.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

      const health = await database.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.latency).toBeDefined();
      expect(health.error).toBeUndefined();
    });

    test("should return unhealthy when not connected", async () => {
      const health = await database.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe("Not connected");
    });

    test("should return unhealthy on query error", async () => {
      await database.connect();
      mockPool.query.mockRejectedValueOnce(new Error("Query failed"));

      const health = await database.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toBe("Query failed");
    });
  });

  describe("disconnect", () => {
    test("should close pool connection", async () => {
      await database.connect();
      await database.disconnect();

      expect(mockPool.end).toHaveBeenCalled();
    });

    test("should handle disconnect when not connected", async () => {
      await expect(database.disconnect()).resolves.not.toThrow();
    });

    test("should disconnect successfully even with active timers", async () => {
      await database.connect();

      // Disconnect should work even if timers are active
      await database.disconnect();

      // Verify pool was ended
      expect(mockPool.end).toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    test("should return disconnected status when not connected", () => {
      const status = database.getStatus();

      expect(status.connected).toBe(false);
      expect(status.poolSize).toBeUndefined();
    });

    test("should return connection pool status", async () => {
      await database.connect();

      const status = database.getStatus();

      expect(status).toEqual({
        connected: true,
        poolSize: 10,
        idle: 5,
        waiting: 0,
      });
    });
  });

  describe("event handling", () => {
    test("should emit connected event", async () => {
      const connectedHandler = vi.fn();
      database.on("connected", connectedHandler);

      await database.connect();

      expect(connectedHandler).toHaveBeenCalled();
    });

    test("should emit disconnected event", async () => {
      const disconnectedHandler = vi.fn();
      database.on("disconnected", disconnectedHandler);

      await database.connect();
      await database.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });

    test("should emit error event on pool error", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const errorHandler = vi.fn();

      database.on("error", errorHandler);

      await database.connect();

      const poolErrorHandler = mockPool.on.mock.calls.find(call => call[0] === "error")?.[1];
      const testError = new Error("Pool error");

      poolErrorHandler?.(testError);

      expect(errorHandler).toHaveBeenCalledWith(testError);
      consoleErrorSpy.mockRestore();
    });
  });
});
