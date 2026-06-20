// Phase 1: Client Portal + Admin Portal auth tables.
// Sync via syncSchemaFromTables() also handles fresh DBs — this migration
// is a no-op for the schema, but exists so SCHEMA_VERSION bumps to 2 and the
// versioned-migrations runner records the milestone.
export default {
  version: 2,
  name: "phase-1-db-auth",
  up(_db) {
    // Tables are declared in src/lib/db/schema.js and created/synced by
    // syncSchemaFromTables(). Nothing destructive to do here.
  },
};