import path from "path";
import { Umzug } from "umzug";
import { fileURLToPath } from "url";

import { Database } from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type MigrationContext = Database;

export class MigrationRunner {
  private umzug: Umzug<MigrationContext> | null = null;
  private database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  /**
   * Initialize the migration runner
   */
  async initialize(): Promise<void> {
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        name VARCHAR(255) PRIMARY KEY,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    this.umzug = new Umzug({
      migrations: {
        glob: path.join(__dirname, "../migrations/*.js"),
        resolve: ({ name, path: filepath, context }) => {
          return {
            name,
            up: async () => {
              const migration = await import(filepath!);
              return migration.up(context);
            },
            down: async () => {
              const migration = await import(filepath!);
              return migration.down ? migration.down(context) : undefined;
            },
          };
        },
      },
      context: this.database,
      storage: {
        async executed({ context: database }: { context: MigrationContext }) {
          const result = await database.query<{ name: string }>(
            "SELECT name FROM migrations ORDER BY name",
          );
          return result.rows.map(row => row.name);
        },
        async logMigration({ name, context: database }: { name: string; context: MigrationContext }) {
          await database.query(
            "INSERT INTO migrations (name) VALUES ($1)",
            [name],
          );
        },
        async unlogMigration({ name, context: database }: { name: string; context: MigrationContext }) {
          await database.query(
            "DELETE FROM migrations WHERE name = $1",
            [name],
          );
        },
      },
      logger: console,
    });
  }

  /**
   * Run pending migrations
   */
  async up(): Promise<void> {
    if (!this.umzug) {
      await this.initialize();
    }

    try {
      const migrations = await this.umzug!.up();

      if (migrations.length === 0) {
        console.log("No pending migrations");
      } else {
        console.log("Executed migrations:", migrations.map(m => m.name));
      }
    } catch (error: unknown) {
      console.error("Migration failed:", error);
      throw error;
    }
  }

  /**
   * Rollback the last migration
   */
  async down(): Promise<void> {
    if (!this.umzug) {
      await this.initialize();
    }

    try {
      const migrations = await this.umzug!.down();

      if (migrations.length === 0) {
        console.log("No migrations to rollback");
      } else {
        console.log("Rolled back migration:", migrations[0].name);
      }
    } catch (error: unknown) {
      console.error("Rollback failed:", error);
      throw error;
    }
  }

  /**
   * Get list of pending migrations
   */
  async pending(): Promise<string[]> {
    if (!this.umzug) {
      await this.initialize();
    }

    const pendingMigrations = await this.umzug!.pending();

    return pendingMigrations.map(m => m.name);
  }

  /**
   * Get list of executed migrations
   */
  async executed(): Promise<string[]> {
    if (!this.umzug) {
      await this.initialize();
    }

    const executedMigrations = await this.umzug!.executed();

    return executedMigrations.map(m => m.name);
  }
}
