import { v4 as uuidv4 } from "uuid";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ClientManager } from "./clientManager.js";
import { Database } from "./database.js";
import { McpServerConfig } from "../types/index.js";
import { registerToolsWithMcpServer, unregisterToolsFromMcpServer } from "../utils/serverManagement.js";

export enum SyncEventType {
  SERVER_REGISTERED = "SERVER_REGISTERED",
  SERVER_UNREGISTERED = "SERVER_UNREGISTERED",
  SERVER_UPDATED = "SERVER_UPDATED",
  SERVER_RECONNECTED = "SERVER_RECONNECTED",
  SERVER_DISCONNECTED = "SERVER_DISCONNECTED",
}

export interface SyncEvent {
  id?: string;
  event_type: SyncEventType;
  event_data: Record<string, unknown>;
  instance_id: string;
  created_at?: Date;
  processed_at?: Date | null;
  processed_by?: string[];
}

export class SyncService {
  private instanceId: string;
  private database: Database;
  private clientManager: ClientManager;
  private mcpServer?: McpServer;
  private pollInterval?: NodeJS.Timeout;
  private pollIntervalMs: number;
  private cleanupIntervalMs: number;
  private cleanupInterval?: NodeJS.Timeout;
  private eventRetentionHours: number;
  private dbSyncInterval?: NodeJS.Timeout;
  private dbSyncIntervalMs: number;

  constructor(
    database: Database,
    clientManager: ClientManager,
    options?: {
      instanceId?: string;
      pollIntervalMs?: number;
      cleanupIntervalMs?: number;
      eventRetentionHours?: number;
      mcpServer?: McpServer;
      dbSyncIntervalMs?: number;
    },
  ) {
    this.instanceId = options?.instanceId || `router-${uuidv4()}`;
    this.database = database;
    this.clientManager = clientManager;
    this.mcpServer = options?.mcpServer;
    this.pollIntervalMs = options?.pollIntervalMs || 5000; // Poll every 5 seconds
    this.cleanupIntervalMs = options?.cleanupIntervalMs || 3600000; // Cleanup every hour
    this.eventRetentionHours = options?.eventRetentionHours || 24; // Keep events for 24 hours
    this.dbSyncIntervalMs = options?.dbSyncIntervalMs || 30000; // Sync with DB every 30 seconds

    console.log(`SyncService initialized with instance ID: ${this.instanceId}`);
  }

  async start(): Promise<void> {
    // First, sync with all existing registered servers from database
    await this.syncExistingServers();

    // Then process any unprocessed events
    await this.processUnprocessedEvents();

    // Set up periodic polling for unprocessed events
    this.pollInterval = setInterval(async () => {
      await this.processUnprocessedEvents();
    }, this.pollIntervalMs);

    // Set up periodic database sync to catch any servers added directly to DB
    this.dbSyncInterval = setInterval(async () => {
      await this.syncExistingServers();
    }, this.dbSyncIntervalMs);

    // Set up periodic cleanup of old events
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupOldEvents();
    }, this.cleanupIntervalMs);

    console.log(`SyncService started - polling events every ${this.pollIntervalMs}ms, syncing DB every ${this.dbSyncIntervalMs}ms`);
  }

  private async syncExistingServers(): Promise<void> {
    try {
      // Get all servers from the database
      const result = await this.database.query<McpServerConfig>(
        "SELECT id, name, url, description, enabled FROM servers WHERE enabled = true AND deleted_at IS NULL",
      );

      if (result.rows.length === 0) {
        console.log("No servers in DB");

        return;
      }

      const existingServers = this.clientManager.getServerStatuses();
      const newServersFound: string[] = [];
      const reconnectedServers: string[] = [];

      for (const row of result.rows) {
        const serverConfig: McpServerConfig = {
          id: row.id,
          name: row.name,
          url: row.url,
          description: row.description || undefined,
          enabled: row.enabled !== false,
        };

        const serverStatus = existingServers.find(s => s.name === serverConfig.name);

        if (!serverStatus) {
          // New server found in database that we don't have locally
          newServersFound.push(serverConfig.name);

          console.log(`Registering server: ${serverConfig.name} at ${serverConfig.url}`);

          try {
            await this.clientManager.connectToServer(serverConfig);

            // Check if connection was successful
            const updatedStatuses = this.clientManager.getServerStatuses();
            const newServerStatus = updatedStatuses.find(s => s.name === serverConfig.name);

            if (newServerStatus && newServerStatus.connected) {
              if (this.mcpServer) {
                const tools = await this.clientManager.buildServerTools(serverConfig);

                if (tools && tools.length > 0) {
                  await registerToolsWithMcpServer(serverConfig, this.clientManager, this.mcpServer);

                  console.log(`Connected to ${serverConfig.name}: ${tools.length} tools available`);
                } else {
                  console.log(`Connected to ${serverConfig.name}: no tools available`);
                }
              } else {
                console.log("Warning: mcpServer not available for tool registration");
              }
            } else {
              console.log(`Server ${serverConfig.name} failed to connect (connected: ${newServerStatus?.connected})`);
            }
          } catch (error: unknown) {
            console.error(`Failed to sync server ${serverConfig.name}:`, error);
          }
        } else if (!serverStatus.connected) {
          try {
            console.log(`Attempting to reconnect to disconnected server: ${serverConfig.name}`);

            await this.clientManager.reconnectToServer(serverConfig.name);

            const updatedStatuses = this.clientManager.getServerStatuses();
            const updatedStatus = updatedStatuses.find(s => s.name === serverConfig.name);

            if (updatedStatus && updatedStatus.connected && this.mcpServer) {
              reconnectedServers.push(serverConfig.name);

              const tools = await this.clientManager.buildServerTools(serverConfig);

              if (tools && tools.length > 0) {
                await registerToolsWithMcpServer(serverConfig, this.clientManager, this.mcpServer);

                console.log(`Re-registered ${tools.length} tools for reconnected server: ${serverConfig.name}`);
              }
            }
          } catch (error: unknown) {
            console.error(`Failed to reconnect to server ${serverConfig.name}:`, error);
          }
        }
      }

      // Only log if there were changes
      if (newServersFound.length > 0) {
        console.log(`Database sync found ${newServersFound.length} new servers: ${newServersFound.join(", ")}`);
      }

      if (reconnectedServers.length > 0) {
        console.log(`Database sync reconnected ${reconnectedServers.length} servers: ${reconnectedServers.join(", ")}`);
      }
    } catch (error: unknown) {
      console.error("Failed to sync existing servers:", error);
    }
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    if (this.dbSyncInterval) {
      clearInterval(this.dbSyncInterval);
      this.dbSyncInterval = undefined;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    console.log("SyncService stopped");
  }

  async publishEvent(eventType: SyncEventType, eventData: Record<string, unknown>): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO sync_events (event_type, event_data, instance_id)
         VALUES ($1, $2, $3)`,
        [eventType, JSON.stringify(eventData), this.instanceId],
      );
    } catch (error: unknown) {
      console.error(`Failed to publish sync event ${eventType}:`, error);
    }
  }

  private async processUnprocessedEvents(): Promise<void> {
    try {
      const result = await this.database.query<SyncEvent>(
        `SELECT * FROM sync_events
         WHERE processed_by IS NULL OR NOT ($1 = ANY(processed_by))
         ORDER BY created_at ASC
         LIMIT 100`,
        [this.instanceId],
      );

      for (const event of result.rows) {
        if (event.instance_id === this.instanceId) {
          await this.markEventProcessed(event.id!);
          continue;
        }

        const wasProcessed = await this.processEvent(event);

        if (wasProcessed) {
          await this.markEventProcessed(event.id!);
        }
      }
    } catch (error: unknown) {
      console.error("Failed to process unprocessed events:", error);
    }
  }

  private async processEvent(event: SyncEvent): Promise<boolean> {
    if (event.event_type === SyncEventType.SERVER_REGISTERED ||
        event.event_type === SyncEventType.SERVER_UNREGISTERED) {
      console.log(`Processing sync event: ${event.event_type} - ${(event.event_data as any).name || 'unknown'}`);
    }

    try {
      switch (event.event_type) {
      case SyncEventType.SERVER_REGISTERED:
      case SyncEventType.SERVER_UPDATED:
        return await this.handleServerRegistered(event.event_data as unknown as McpServerConfig);

      case SyncEventType.SERVER_UNREGISTERED:
        return await this.handleServerUnregistered(event.event_data as { name: string });

      case SyncEventType.SERVER_RECONNECTED:
        return await this.handleServerReconnected(event.event_data as { name: string });

      case SyncEventType.SERVER_DISCONNECTED:
        return await this.handleServerDisconnected(event.event_data as { name: string });

      default:
        console.warn(`Unknown sync event type: ${event.event_type}`);

        return true; // Mark unknown events as processed to avoid infinite loop
      }
    } catch (error: unknown) {
      console.error(`Failed to process sync event ${event.event_type}:`, error);

      return false; // Don't mark as processed if there was an error
    }
  }

  private async handleServerRegistered(config: McpServerConfig): Promise<boolean> {
    const existingServers = this.clientManager.getServerStatuses();
    const exists = existingServers.some(s => s.name === config.name);

    if (!exists) {
      console.log(`Syncing server registration: ${config.name} from ${config.url}`);

      try {
        await this.clientManager.connectToServer(config);

        const serverStatuses = this.clientManager.getServerStatuses();
        const serverStatus = serverStatuses.find(s => s.name === config.name);

        if (serverStatus && serverStatus.connected && this.mcpServer) {
          const tools = await this.clientManager.buildServerTools(config);

          if (tools && tools.length > 0) {
            await registerToolsWithMcpServer(config, this.clientManager, this.mcpServer);

            console.log(`Server ${config.name} synced: ${tools.length} tools registered`);
          } else {
            console.log(`Server ${config.name} synced: no tools available`);
          }
        } else {
          console.log(`Server ${config.name} sync failed - not connected, skipping tool registration`);
        }

        return true;
      } catch (error: unknown) {
        console.error(`Failed to sync server ${config.name}:`, error);

        return false;
      }
    } else {
      console.log(`Server ${config.name} already exists, not processing event`);

      return false;
    }
  }

  private async handleServerUnregistered(data: { name: string }): Promise<boolean> {
    const existingServers = this.clientManager.getServerStatuses();
    const exists = existingServers.some(s => s.name === data.name);

    if (exists) {
      console.log(`Syncing server unregistration: ${data.name}`);

      unregisterToolsFromMcpServer(data.name);
      await this.clientManager.disconnectFromServer(data.name);

      return true;
    }

    return false;
  }

  private async handleServerReconnected(data: { name: string }): Promise<boolean> {
    const existingServers = this.clientManager.getServerStatuses();
    const server = existingServers.find(s => s.name === data.name);

    if (server && !server.connected) {
      console.log(`Syncing server reconnection: ${data.name}`);

      await this.clientManager.reconnectToServer(data.name);

      return true;
    }

    return false;
  }

  private async handleServerDisconnected(data: { name: string }): Promise<boolean> {
    const existingServers = this.clientManager.getServerStatuses();
    const server = existingServers.find(s => s.name === data.name);

    if (server && server.connected) {
      console.log(`Syncing server disconnection: ${data.name}`);

      await this.clientManager.disconnectFromServer(data.name);

      return true;
    }

    return false;
  }

  private async markEventProcessed(eventId: string): Promise<void> {
    try {
      await this.database.query(
        `UPDATE sync_events
         SET processed_by = array_append(COALESCE(processed_by, ARRAY[]::varchar[]), $1),
             processed_at = CASE
               WHEN processed_at IS NULL THEN NOW()
               ELSE processed_at
             END
         WHERE id = $2`,
        [this.instanceId, eventId],
      );
    } catch (error: unknown) {
      console.error(`Failed to mark event ${eventId} as processed:`, error);
    }
  }

  private async cleanupOldEvents(): Promise<void> {
    try {
      const result = await this.database.query(
        `DELETE FROM sync_events
         WHERE created_at < NOW() - INTERVAL '${this.eventRetentionHours} hours'
         RETURNING id`,
      );

      const recentResult = await this.database.query(
        `DELETE FROM sync_events
         WHERE created_at < NOW() - INTERVAL '5 minutes'
         AND processed_by IS NOT NULL
         AND array_length(processed_by, 1) > 0
         RETURNING id`,
      );

      const totalCleaned = (result.rowCount || 0) + (recentResult.rowCount || 0);

      if (totalCleaned > 0) {
        console.log(`Cleaned up ${totalCleaned} old sync events`);
      }
    } catch (error: unknown) {
      console.error("Failed to cleanup old sync events:", error);
    }
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}
