import 'fake-indexeddb/auto'

// Dexie checks for structuredClone; Node has it, but fake-indexeddb wants the
// globals wired before any database is opened, which the import above does.
