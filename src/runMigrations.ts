#!/usr/bin/env node

import dotenv from "dotenv";

import { initDatabaseFromEnv } from "./services/database.js";
import { MigrationRunner } from "./services/migrationRunner.js";

dotenv.config();

const runMigrations = async () => {
  console.log("Starting migration runner...");

  try {
    const database = initDatabaseFromEnv();

    await database.connect();
    console.log("Connected to database");

    const migrationRunner = new MigrationRunner(database);
    await migrationRunner.up();

    await database.disconnect();
    console.log("Migrations completed successfully");

    process.exit(0);
  } catch (error: unknown) {
    console.error("Migration failed:", error);

    process.exit(1);
  }
};

runMigrations();
