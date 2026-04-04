# Backend Data Domain

Pay attention to these concerns when working in this domain.

- **Schema design**: Model data to reflect the domain accurately; think through how the schema will evolve before committing to a structure.
- **Migrations**: Write forward migrations that are safe to run on live data; test rollback paths before deploying.
- **Query performance**: Add indexes for columns used in WHERE and JOIN clauses; watch for N+1 query patterns in loops.
- **Transaction boundaries**: Wrap operations that must succeed or fail together in a single transaction; keep transactions short to avoid lock contention.
- **Data validation**: Validate data before persistence even if the API layer has already validated it; enforce constraints at the database level too.
- **Null handling**: Be explicit about which columns can be null; avoid nullable columns where a default value communicates intent better.
- **Referential integrity**: Use foreign keys to enforce relationships; decide on cascade behavior deliberately (restrict, cascade, set null).
- **Backup and recovery**: Confirm that any new data store or table is covered by existing backup and recovery procedures.
