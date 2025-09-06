import { describe, test, expect, beforeEach, vi } from "vitest";

import { ServerRepository } from "./serverRepository.js";
import type { Database } from "../services/database.js";
import type { McpServerConfigInput } from "../types/index.js";

describe("ServerRepository", () => {
  let repository: ServerRepository;
  let mockDatabase: {
    query: ReturnType<typeof vi.fn>;
    queryOne: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
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

    repository = new ServerRepository(mockDatabase as unknown as Database);
  });

  describe("create", () => {
    test("should create a new server", async () => {
      const config: McpServerConfigInput = {
        name: "test-server",
        url: "http://localhost:3000",
        description: "Test server",
        enabled: true,
      };

      const mockServerRecord = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        ...config,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(mockServerRecord);

      const result = await repository.create(config);

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO servers"),
        [config.name, config.url, config.description, config.enabled, 30000, 3, "{}"],
      );
      expect(result).toEqual(mockServerRecord);
    });

    test("should handle creation with minimal config", async () => {
      const config: McpServerConfigInput = {
        name: "minimal-server",
        url: "http://localhost:3001",
      };

      const mockServerRecord = {
        id: "123e4567-e89b-12d3-a456-426614174001",
        ...config,
        enabled: true,
        description: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(mockServerRecord);

      const result = await repository.create(config);

      expect(result.enabled).toBe(true);
    });
  });

  describe("update", () => {
    test("should update an existing server", async () => {
      const id = "123e4567-e89b-12d3-a456-426614174000";
      const updates = {
        url: "http://localhost:4000",
        description: "Updated description",
      };

      const existingServer = {
        id,
        name: "test-server",
        url: "http://localhost:3000",
        description: "Original description",
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockUpdatedServer = {
        ...existingServer,
        ...updates,
        updated_at: new Date(),
      };

      mockDatabase.queryOne
        .mockResolvedValueOnce(existingServer) // findById returns existing
        .mockResolvedValueOnce(mockUpdatedServer); // upsert returns updated

      const result = await repository.update(id, updates);

      expect(result).toEqual(mockUpdatedServer);
    });

    test("should return null when server not found", async () => {
      mockDatabase.queryOne.mockResolvedValueOnce(null);

      const result = await repository.update("non-existent-id", { url: "http://new-url" });

      expect(result).toBeNull();
    });
  });

  describe("upsert", () => {
    test("should update existing server", async () => {
      const config: McpServerConfigInput = {
        name: "existing-server",
        url: "http://localhost:3000",
      };

      const existingServer = {
        id: "existing-id",
        ...config,
        enabled: true,
        timeout_ms: 30000,
        retry_attempts: 3,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(existingServer); // upsert returns server

      const result = await repository.upsert(config);

      expect(result.id).toBe("existing-id");
    });

    test("should create new server if not exists", async () => {
      const config: McpServerConfigInput = {
        name: "new-server",
        url: "http://localhost:3000",
      };

      const newServer = {
        id: "new-id",
        name: config.name,
        url: config.url,
        description: null,
        enabled: true,
        timeout_ms: 30000,
        retry_attempts: 3,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };

      mockDatabase.queryOne.mockResolvedValueOnce(newServer); // upsert returns new server

      const result = await repository.upsert(config);

      expect(result.id).toBe("new-id");
    });
  });

  describe("getById", () => {
    test("should return server by id", async () => {
      const server = {
        id: "test-id",
        name: "test-server",
        url: "http://localhost:3000",
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(server);

      const result = await repository.getById("test-id");

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM servers WHERE id = $1"),
        ["test-id"],
      );
      expect(result).toEqual(server);
    });

    test("should return null when not found", async () => {
      mockDatabase.queryOne.mockResolvedValueOnce(null);

      const result = await repository.getById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getByName", () => {
    test("should return server by name", async () => {
      const server = {
        id: "test-id",
        name: "test-server",
        url: "http://localhost:3000",
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockDatabase.queryOne.mockResolvedValueOnce(server);

      const result = await repository.getByName("test-server");

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM servers WHERE name = $1"),
        ["test-server"],
      );
      expect(result).toEqual(server);
    });
  });

  describe("getAll", () => {
    test("should return all servers", async () => {
      const servers = [
        { id: "id1", name: "server1", url: "http://localhost:3001" },
        { id: "id2", name: "server2", url: "http://localhost:3002" },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: servers, rowCount: 2 });

      const result = await repository.getAll();

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM servers WHERE deleted_at IS NULL"),
      );
      expect(result).toEqual(servers);
    });

    test("should return empty array when no servers", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repository.getAll();

      expect(result).toEqual([]);
    });
  });

  describe("getAllAsConfigs", () => {
    test("should return servers as McpServerConfig", async () => {
      const servers = [
        {
          id: "id1",
          name: "server1",
          url: "http://localhost:3001",
          description: "Server 1",
          enabled: true,
          timeout_ms: 30000,
          retry_attempts: 3,
          metadata: { custom: "data" },
        },
        {
          id: "id2",
          name: "server2",
          url: "http://localhost:3002",
          description: null,
          enabled: false,
          timeout_ms: 60000,
          retry_attempts: 5,
          metadata: null,
        },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: servers, rowCount: 2 });

      const result = await repository.getAllAsConfigs();

      expect(result).toEqual([
        {
          id: "id1",
          name: "server1",
          url: "http://localhost:3001",
          description: "Server 1",
          enabled: true,
          timeout: 30000,
          retryAttempts: 3,
        },
        {
          id: "id2",
          name: "server2",
          url: "http://localhost:3002",
          description: null,
          enabled: false,
          timeout: 60000,
          retryAttempts: 5,
        },
      ]);
    });
  });

  describe("getEnabled", () => {
    test("should return only enabled servers", async () => {
      const servers = [
        { id: "id1", name: "server1", url: "http://localhost:3001", enabled: true },
      ];

      mockDatabase.query.mockResolvedValueOnce({ rows: servers, rowCount: 1 });

      const result = await repository.getEnabled();

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE enabled = true AND deleted_at IS NULL"),
      );
      expect(result).toEqual(servers);
    });
  });

  describe("setEnabled", () => {
    test("should enable a server", async () => {
      const updatedServer = {
        id: "test-id",
        name: "test-server",
        enabled: true,
      };

      mockDatabase.queryOne.mockResolvedValueOnce(updatedServer);

      const result = await repository.setEnabled("test-server", true);

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE servers SET enabled = $2"),
        ["test-server", true],
      );
      expect(result).toEqual(updatedServer);
    });

    test("should disable a server", async () => {
      const updatedServer = {
        id: "test-id",
        name: "test-server",
        enabled: false,
      };

      mockDatabase.queryOne.mockResolvedValueOnce(updatedServer);

      const result = await repository.setEnabled("test-server", false);

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE servers SET enabled = $2"),
        ["test-server", false],
      );
      expect(result?.enabled).toBe(false);
    });
  });

  describe("delete", () => {
    test("should soft delete a server", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await repository.delete("test-id");

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE servers SET deleted_at = NOW()"),
        ["test-id"],
      );
      expect(result).toBe(true);
    });

    test("should return false when server not found", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repository.delete("non-existent");

      expect(result).toBe(false);
    });
  });

  describe("hardDelete", () => {
    test("should permanently delete a server", async () => {
      mockDatabase.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await repository.hardDelete("test-id");

      expect(mockDatabase.query).toHaveBeenCalledWith(
        "DELETE FROM servers WHERE id = $1",
        ["test-id"],
      );
      expect(result).toBe(true);
    });
  });

  describe("updateMetadata", () => {
    test("should update server metadata", async () => {
      const metadata = { custom: "value", another: "field" };
      const updatedServer = {
        id: "test-id",
        name: "test-server",
        metadata,
      };

      mockDatabase.queryOne.mockResolvedValueOnce(updatedServer);

      const result = await repository.updateMetadata("test-id", metadata);

      expect(mockDatabase.queryOne).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE servers SET metadata = $2"),
        ["test-id", JSON.stringify(metadata)],
      );
      expect(result).toEqual(updatedServer);
    });

    test("should handle null metadata", async () => {
      mockDatabase.queryOne.mockResolvedValueOnce(null);

      const result = await repository.updateMetadata("test-id", null);

      expect(result).toBeNull();
    });
  });
});
