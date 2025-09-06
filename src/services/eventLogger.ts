import { Database } from "./database.js";

export type EventType = "connected" | "disconnected" | "error" | "registered" | "unregistered" | "tool_loaded" | "health_check";

export interface ServerEvent {
  serverId: string;
  serverName: string;
  eventType: EventType;
  details?: Record<string, unknown>;
}

export interface ServerEventRecord extends ServerEvent {
  id: string;
  created_at: Date;
}

export class EventLogger {
  private database: Database;
  private batchQueue: ServerEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private batchSize = 10;
  private batchInterval = 5000; // 5 seconds
  private enabled = true;

  constructor(database: Database, options?: { batchSize?: number; batchInterval?: number; enabled?: boolean }) {
    this.database = database;
    this.batchSize = options?.batchSize || 10;
    this.batchInterval = options?.batchInterval || 5000;
    this.enabled = options?.enabled !== false;
  }

  /**
   * Log a server event
   */
  async logEvent(event: ServerEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    this.batchQueue.push(event);

    if (this.batchQueue.length >= this.batchSize) {
      await this.flush();
    } else {
      this.scheduleBatchFlush();
    }
  }

  /**
   * Log server connection
   */
  async logConnection(serverId: string, serverName: string, details?: Record<string, unknown>): Promise<void> {
    await this.logEvent({
      serverId,
      serverName,
      eventType: "connected",
      details: details || {},
    });
  }

  /**
   * Log server disconnection
   */
  async logDisconnection(serverId: string, serverName: string, reason?: string): Promise<void> {
    await this.logEvent({
      serverId,
      serverName,
      eventType: "disconnected",
      details: reason ? { reason } : {},
    });
  }

  /**
   * Log server error
   */
  async logError(serverId: string, serverName: string, error: Error | string): Promise<void> {
    await this.logEvent({
      serverId,
      serverName,
      eventType: "error",
      details: {
        error: typeof error === "string" ? error : error.message,
        stack: typeof error === "object" ? error.stack : undefined,
      },
    });
  }

  /**
   * Log server registration
   */
  async logRegistration(serverId: string, serverName: string, url: string): Promise<void> {
    await this.logEvent({
      serverId,
      serverName,
      eventType: "registered",
      details: { url },
    });
  }

  /**
   * Log tools loaded from server
   */
  async logToolsLoaded(serverId: string, serverName: string, toolCount: number): Promise<void> {
    await this.logEvent({
      serverId,
      serverName,
      eventType: "tool_loaded",
      details: { toolCount },
    });
  }

  /**
   * Schedule batch flush
   */
  private scheduleBatchFlush(): void {
    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.flush().catch(error => {
        console.error("Error flushing event batch:", error);
      });
    }, this.batchInterval);
  }

  /**
   * Flush the batch queue to database
   */
  async flush(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);

      this.batchTimer = null;
    }

    const eventsToFlush = [...this.batchQueue];
    this.batchQueue = [];

    try {
      await this.database.transaction(async client => {
        for (const event of eventsToFlush) {
          await client.query(
            "INSERT INTO server_events (server_id, event_type, details) VALUES ($1::uuid, $2, $3)",
            [event.serverId, event.eventType, JSON.stringify(event.details || {})],
          );
        }
      });
    } catch (error: unknown) {
      console.error("Failed to log events to database:", error);
    }
  }

  /**
   * Get recent events for a server
   */
  async getServerEvents(serverName: string, limit = 100): Promise<ServerEventRecord[]> {
    const result = await this.database.query<ServerEventRecord>(
      `SELECT se.*, s.name as server_name
       FROM server_events se
       JOIN servers s ON se.server_id = s.id
       WHERE s.name = $1
       ORDER BY se.created_at DESC
       LIMIT $2`,
      [serverName, limit],
    );
    return result.rows;
  }

  /**
   * Get recent events of a specific type
   */
  async getEventsByType(eventType: EventType, limit = 100): Promise<ServerEventRecord[]> {
    const result = await this.database.query<ServerEventRecord>(
      `SELECT se.*, s.name as server_name
       FROM server_events se
       JOIN servers s ON se.server_id = s.id
       WHERE se.event_type = $1
       ORDER BY se.created_at DESC
       LIMIT $2`,
      [eventType, limit],
    );
    return result.rows;
  }

  /**
   * Get server health history
   */
  async getServerHealth(serverName: string, hoursBack = 24): Promise<ServerEventRecord[]> {
    const result = await this.database.query<ServerEventRecord>(
      `SELECT se.*, s.name as server_name
       FROM server_events se
       JOIN servers s ON se.server_id = s.id
       WHERE s.name = $1
         AND se.event_type IN ('connected', 'disconnected', 'error')
         AND se.created_at > NOW() - INTERVAL '$2 hours'
       ORDER BY se.created_at DESC`,
      [serverName, hoursBack],
    );
    return result.rows;
  }

  /**
   * Cleanup old events
   */
  async cleanup(daysOld = 30): Promise<number> {
    const result = await this.database.query(
      "DELETE FROM server_events WHERE created_at < NOW() - INTERVAL '$1 days'",
      [daysOld],
    );
    return result.rowCount;
  }

  /**
   * Shutdown the event logger (flush remaining events)
   */
  async shutdown(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);

      this.batchTimer = null;
    }

    await this.flush();
  }
}
