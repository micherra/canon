# platform/storage/drift/

SQLite-backed drift storage layer. Owns the schema (`drift-schema.ts`), the `DriftDb` facade, all DAO classes (`DriftDbSignals`, `OutcomeStore`, `AreaMemoryDao`, `CraftProfileDao`), the JSONL review store (`store.ts`), and confidence-decay adapters.

See `.claude/CLAUDE.md` for schema details, DAO contracts, and import conventions.
