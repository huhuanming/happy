import { db, getPGlite } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { log } from "@/utils/log";

/**
 * Periodic database maintenance.
 * Runs VACUUM ANALYZE on key tables weekly to reclaim space
 * and update query planner statistics after archive cleanup.
 */

const MAINTENANCE_INTERVAL_MS = parseInt(
    process.env.DB_MAINTENANCE_INTERVAL_MS ?? String(7 * 24 * 60 * 60 * 1000),
    10
);

const TABLES_TO_MAINTAIN = [
    'SessionMessage',
    'Session',
    'UsageReport',
    'TerminalAuthRequest',
    'AccountAuthRequest',
    'GlobalLock',
    'RepeatKey',
];

export function startDbMaintenance() {
    forever('db-maintenance', async () => {
        // Wait 1 hour after startup before first run
        await delay(60 * 60 * 1000, shutdownSignal);

        while (true) {
            try {
                await runMaintenance();
            } catch (e) {
                log({ module: 'db-maintenance', level: 'error' }, `Maintenance failed: ${e}`);
            }
            await delay(MAINTENANCE_INTERVAL_MS, shutdownSignal);
        }
    });
}

/**
 * Run VACUUM ANALYZE on key tables and report table sizes.
 * Returns a summary of the maintenance run for API responses.
 */
export async function runMaintenance(): Promise<{
    vacuumed: string[];
    tableSizes: Array<{ table: string; rows: number; sizeBytes: string }>;
    durationMs: number;
}> {
    const startTime = Date.now();
    log({ module: 'db-maintenance' }, 'Starting database maintenance');

    const vacuumed: string[] = [];

    // PGlite does not support VACUUM in transactions, skip if using PGlite
    const pglite = getPGlite();

    if (!pglite) {
        for (const table of TABLES_TO_MAINTAIN) {
            try {
                // Quote table name with double quotes for Prisma-generated table names
                await db.$executeRawUnsafe(`VACUUM ANALYZE "${table}"`);
                vacuumed.push(table);
            } catch (e) {
                log(
                    { module: 'db-maintenance', table, level: 'error' },
                    `VACUUM ANALYZE failed for ${table}: ${e}`
                );
            }
        }
    }

    // Collect table size statistics
    const tableSizes: Array<{ table: string; rows: number; sizeBytes: string }> = [];
    try {
        const sizes = await db.$queryRaw<Array<{
            relname: string;
            n_live_tup: bigint;
            pg_total_relation_size: bigint;
        }>>`
            SELECT
                c.relname,
                c.n_live_tup,
                pg_total_relation_size(c.relname::regclass) as pg_total_relation_size
            FROM pg_stat_user_tables c
            ORDER BY pg_total_relation_size(c.relname::regclass) DESC
        `;

        for (const row of sizes) {
            tableSizes.push({
                table: row.relname,
                rows: Number(row.n_live_tup),
                sizeBytes: row.pg_total_relation_size.toString()
            });
        }
    } catch (e) {
        log({ module: 'db-maintenance', level: 'error' }, `Failed to collect table sizes: ${e}`);
    }

    const durationMs = Date.now() - startTime;
    log(
        {
            module: 'db-maintenance',
            vacuumedCount: vacuumed.length,
            tableCount: tableSizes.length,
            durationMs
        },
        `Maintenance completed in ${durationMs}ms: vacuumed ${vacuumed.length} tables`
    );

    return { vacuumed, tableSizes, durationMs };
}
