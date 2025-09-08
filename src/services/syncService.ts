import { Database } from "./database.js";
import { ClientManager } from "./clientManager.js";
import { McpServerConfig } from "../types/index.js";
import { v4 as uuidv4 } from "uuid";

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
  private pollInterval?: NodeJS.Timeout;
  private pollIntervalMs: number;
  private cleanupIntervalMs: number;
  private cleanupInterval?: NodeJS.Timeout;
  private eventRetentionHours: number;

  constructor(
    database: Database,
    clientManager: ClientManager,
    options?: {
      instanceId?: string;
      pollIntervalMs?: number;
      cleanupIntervalMs?: number;
      eventRetentionHours?: number;
    },
  ) {
    this.instanceId = options?.instanceId || `router-${uuidv4()}`;
    this.database = database;
    this.clientManager = clientManager;
    this.pollIntervalMs = options?.pollIntervalMs || 5000; // Poll every 5 seconds
    this.cleanupIntervalMs = options?.cleanupIntervalMs || 3600000; // Cleanup every hour
    this.eventRetentionHours = options?.eventRetentionHours || 24; // Keep events for 24 hours

    console.log(`SyncService initialized with instance ID: ${this.instanceId}`);
  }

  async start(): Promise<void> {
    await this.processUnprocessedEvents();

    this.pollInterval = setInterval(async () => {
      await this.processUnprocessedEvents();
    }, this.pollIntervalMs);

    this.cleanupInterval = setInterval(async () => {
      await this.cleanupOldEvents();
    }, this.cleanupIntervalMs);

    console.log(`SyncService started - polling every ${this.pollIntervalMs}ms`);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
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
    } catch (error) {
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

        await this.processEvent(event);
        await this.markEventProcessed(event.id!);
      }
    } catch (error) {
      console.error("Failed to process unprocessed events:", error);
    }
  }

  private async processEvent(event: SyncEvent): Promise<void> {
    console.log(`Processing sync event: ${event.event_type} from ${event.instance_id}`);

    try {
      switch (event.event_type) {
      case SyncEventType.SERVER_REGISTERED:
      case SyncEventType.SERVER_UPDATED:
        await this.handleServerRegistered(event.event_data as unknown as McpServerConfig);
        break;

      case SyncEventType.SERVER_UNREGISTERED:
        await this.handleServerUnregistered(event.event_data as { name: string });
        break;

      case SyncEventType.SERVER_RECONNECTED:
        await this.handleServerReconnected(event.event_data as { name: string });
        break;

      case SyncEventType.SERVER_DISCONNECTED:
        await this.handleServerDisconnected(event.event_data as { name: string });
        break;

      default:
        console.warn(`Unknown sync event type: ${event.event_type}`);
      }
    } catch (error) {
      console.error(`Failed to process sync event ${event.event_type}:`, error);
    }
  }

  private async handleServerRegistered(config: McpServerConfig): Promise<void> {
    const existingServers = this.clientManager.getServerStatuses();
    const exists = existingServers.some(s => s.name === config.name);

    if (!exists) {
      console.log(`Syncing new server registration: ${config.name}`);
      await this.clientManager.connectToServer(config);
    }
  }

  private async handleServerUnregistered(data: { name: string }): Promise<void> {
    const existingServers = this.clientManager.getServerStatuses();
    const exists = existingServers.some(s => s.name === data.name);

    if (exists) {
      console.log(`Syncing server unregistration: ${data.name}`);
      await this.clientManager.disconnectFromServer(data.name);
    }
  }

  private async handleServerReconnected(data: { name: string }): Promise<void> {
    const existingServers = this.clientManager.getServerStatuses();
    const server = existingServers.find(s => s.name === data.name);

    if (server && !server.connected) {
      console.log(`Syncing server reconnection: ${data.name}`);
      await this.clientManager.reconnectToServer(data.name);
    }
  }

  private async handleServerDisconnected(data: { name: string }): Promise<void> {
    const existingServers = this.clientManager.getServerStatuses();
    const server = existingServers.find(s => s.name === data.name);

    if (server && server.connected) {
      console.log(`Syncing server disconnection: ${data.name}`);
      await this.clientManager.disconnectFromServer(data.name);
    }
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
    } catch (error) {
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

      if (result.rowCount > 0) {
        console.log(`Cleaned up ${result.rowCount} old sync events`);
      }
    } catch (error) {
      console.error("Failed to cleanup old sync events:", error);
    }
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}