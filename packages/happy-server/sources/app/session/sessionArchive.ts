import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { log } from "@/utils/log";

/**
 * Archive stale session data by deleting messages from sessions
 * that have been inactive for longer than the retention period.
 *
 * Runs periodically (default every 6 hours).
 * - Finds sessions with lastActiveAt older than ARCHIVE_RETENTION_DAYS (default 30).
 * - Deletes their messages in batches to avoid long-running transactions.
 * - Also cleans up expired auth requests, locks, and repeat keys.
 */

const ARCHIVE_RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS ?? '30', 10);
const ARCHIVE_INTERVAL_MS = parseInt(process.env.ARCHIVE_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), 10);
const ARCHIVE_BATCH_SIZE = 1000;

export function startSessionArchive() {
    forever('session-archive', async () => {
        while (true) {
            try {
                await archiveStaleData();
            } catch (e) {
                log({ module: 'session-archive', level: 'error' }, `Archive cycle failed: ${e}`);
            }
            await delay(ARCHIVE_INTERVAL_MS, shutdownSignal);
        }
    });
}

/**
 * Main archive routine. Cleans up:
 * 1. Messages from sessions inactive > ARCHIVE_RETENTION_DAYS
 * 2. Expired terminal/account auth requests (> 1 day)
 * 3. Expired global locks and repeat keys
 * 4. Old usage reports (> 90 days)
 */
async function archiveStaleData() {
    const startTime = Date.now();
    log({ module: 'session-archive' }, 'Starting archive cycle');

    const cutoffDate = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let totalMessagesDeleted = 0;

    // 1. Find stale sessions
    const staleSessions = await db.session.findMany({
        where: {
            lastActiveAt: { lte: cutoffDate }
        },
        select: { id: true, accountId: true }
    });

    log(
        { module: 'session-archive', count: staleSessions.length },
        `Found ${staleSessions.length} stale sessions (inactive > ${ARCHIVE_RETENTION_DAYS} days)`
    );

    // 2. Delete messages in batches per session
    for (const session of staleSessions) {
        let deletedInSession = 0;
        while (true) {
            const batch = await db.sessionMessage.findMany({
                where: { sessionId: session.id },
                select: { id: true },
                take: ARCHIVE_BATCH_SIZE
            });

            if (batch.length === 0) {
                break;
            }

            const result = await db.sessionMessage.deleteMany({
                where: {
                    id: { in: batch.map(m => m.id) }
                }
            });

            deletedInSession += result.count;
            totalMessagesDeleted += result.count;

            if (batch.length < ARCHIVE_BATCH_SIZE) {
                break;
            }
        }

        if (deletedInSession > 0) {
            log(
                { module: 'session-archive', sessionId: session.id, deletedCount: deletedInSession },
                `Archived ${deletedInSession} messages from session ${session.id}`
            );
        }
    }

    // 3. Clean up expired auth requests (> 1 day old)
    const authCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const deletedTerminalAuth = await db.terminalAuthRequest.deleteMany({
        where: { createdAt: { lte: authCutoff } }
    });

    const deletedAccountAuth = await db.accountAuthRequest.deleteMany({
        where: { createdAt: { lte: authCutoff } }
    });

    // 4. Clean up expired locks and repeat keys
    const now = new Date();

    const deletedLocks = await db.globalLock.deleteMany({
        where: { expiresAt: { lte: now } }
    });

    const deletedRepeatKeys = await db.repeatKey.deleteMany({
        where: { expiresAt: { lte: now } }
    });

    // 5. Clean up old usage reports (> 90 days)
    const usageCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const deletedUsageReports = await db.usageReport.deleteMany({
        where: { createdAt: { lte: usageCutoff } }
    });

    const durationMs = Date.now() - startTime;
    log(
        {
            module: 'session-archive',
            totalMessagesDeleted,
            staleSessions: staleSessions.length,
            deletedTerminalAuth: deletedTerminalAuth.count,
            deletedAccountAuth: deletedAccountAuth.count,
            deletedLocks: deletedLocks.count,
            deletedRepeatKeys: deletedRepeatKeys.count,
            deletedUsageReports: deletedUsageReports.count,
            durationMs
        },
        `Archive cycle completed in ${durationMs}ms: ${totalMessagesDeleted} messages, ${deletedTerminalAuth.count + deletedAccountAuth.count} auth requests, ${deletedLocks.count} locks, ${deletedRepeatKeys.count} repeat keys, ${deletedUsageReports.count} usage reports`
    );
}
