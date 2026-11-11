# Database backup and recovery

`scripts/backup-vercel.mjs` reads a consistent libSQL transaction, exports application schema and rows, then restores the artifact into a **new local SQLite file**. It makes no remote writes, deletes, resets, or deployment changes. Existing output files are never overwritten.

The backup includes agreements, signatures, payment intent locks, receipts, pending encrypted transaction disclosures, wallet sessions, and the migration ledger. It preserves 64-bit SQLite integers and binary values. Validation checks every table's row count, foreign keys, and SQLite integrity. A SHA-256 checksum detects accidental artifact corruption; it is not an authenticity signature.

## Reviewed command

Use Node.js 24 or later. Both output paths and the explicitly selected environment file must be inside this checkout and ignored by Git. Use a fresh timestamp for every run:

```sh
node scripts/backup-vercel.mjs \
  --env-file .env.vercel.ops \
  --output backups/devnet-2026-11-11T120000Z.json \
  --restore-check backups/devnet-2026-11-11T120000Z.sqlite
```

Only `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` from that file select the source. Shell environment variables cannot silently change the target. A read-only database token is preferable where available. The script bounds exports to 100,000 rows per table and 50 MiB; exceeding a limit fails instead of truncating data.

The script creates mode-600 files, fsyncs the snapshot and directory, and logs aggregate counts and the artifact checksum. It does not log SQL rows, environment contents, connection strings, API tokens, or provider exception messages. A failed local restore does not delete the snapshot; it is not considered a validated recovery artifact.

## Storage and keys

Backups contain private deal terms and should live in encrypted, access-controlled storage. Git ignore and Unix file permissions prevent common accidents; they do not encrypt the artifact. Keep a dated copy outside the deployment's filesystem and periodically repeat the local restore check.

**Back up `RECEIPT_ENCRYPTION_KEY` separately in an access-controlled secrets vault. Never add it to the database backup.** Retain the correct key for every snapshot that contains pending encrypted records. The tool validates ciphertext preservation, not decryption-key availability. Do not rotate away the old key while recoverable records still require it.

Keep devnet and mainnet backups, database credentials, and encryption keys distinctly labelled. Confirm the source network and destination database before any operational cutover.

## Incident or migration recovery

1. Pause new payments before a planned cutover. Preserve the current database and its recovery records. During an actual restore cutover, also stop jobs that write to the source; pausing payments alone deliberately leaves reconciliation running.
2. Export and validate the snapshot. Recover into a new database or an isolated local file, preserving the original. The provided tool restores locally only; it cannot publish a restored database.
3. Compare the snapshot time with all later signed or broadcast transactions. **Never resume payments from an older snapshot until post-snapshot transactions and payment-intent locks are recovered or reconciled.** A valid SQLite restore can still omit payments made after its timestamp; losing those locks can allow a duplicate payment.
4. Confirm the corresponding encryption key is recoverable. Verify representative pending encrypted records in an isolated environment without broadcasting transactions. Revoke restored sessions before reopening the recovered application so previously revoked sessions cannot become valid again.
5. Verify counts, migration checksums, balances, and receipts; then point the application to the new database through a reviewed deployment. Keep the original database and snapshots until reconciliation and the recovery review are complete.

Take a validated snapshot before schema changes and environment cutovers. Set an appropriate recurring backup schedule and retention policy for actual usage; this script does not create a scheduler or claim an offsite backup already exists.

## Turso's native recovery options

Turso documents `.dump` exports that can rebuild a database, and `db create --from-file` / `--from-dump` for creating a new database from a local artifact. Those provider commands are alternatives when the bounded tool is too small for the data. They are not executed by this script. [Turso database shell](https://docs.turso.tech/cli/db/shell), [database creation](https://docs.turso.tech/cli/db/create).

Turso also documents automatic point-in-time recovery at commits, with retention determined by plan. PITR creates a **new database** and requires changing the application connection; it does not restore over an existing database. Confirm the actual account's retention and availability before relying on it. [Turso point-in-time recovery](https://docs.turso.tech/features/point-in-time-recovery).

The exporter uses the installed libSQL client's `transaction('read')` API. That mode rejects write statements and keeps the schema and rows in one snapshot. [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference).
