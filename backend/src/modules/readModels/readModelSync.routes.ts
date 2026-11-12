import { Router, type Request, type Response, type NextFunction } from 'express';
import { appPool } from '../../config/database.js';
import { isMongoEnabled, isMongoReady } from '../../config/mongodb.js';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { DashboardSnapshotModel } from './models.js';
import { notifyOutboxCommitted } from './outbox.service.js';
import { readModelOutboxWorker } from './readModelOutbox.worker.js';
import { readModelsQueryService } from './readModelsQuery.service.js';

const router = Router();

router.use(requireOwnerSession);

/**
 * GET /api/v1/read-model-sync/status
 * Owner-authenticated operational status endpoint returning outbox queue metrics,
 * recent dead-letter events, MongoDB snapshot freshness, and worker diagnostics.
 */
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [countsRes, deadLettersRes] = await Promise.all([
      appPool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
          COUNT(*) FILTER (WHERE status = 'failed' AND attempt_count < max_attempts)::int AS failed_retryable_count,
          COUNT(*) FILTER (WHERE status = 'dead_letter' OR (status = 'failed' AND attempt_count >= max_attempts))::int AS dead_letter_count,
          COUNT(*) FILTER (WHERE status = 'processed')::int AS processed_count,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
               OR (status = 'failed' AND attempt_count < max_attempts)
          ))) * 1000 AS oldest_unresolved_age_ms
        FROM app_outbox_events
      `),
      appPool.query(`
        SELECT
          id,
          event_id,
          aggregate_type,
          aggregate_id,
          event_type,
          attempt_count,
          max_attempts,
          last_error,
          dead_letter_at,
          created_at,
          updated_at
        FROM app_outbox_events
        WHERE status = 'dead_letter'
        ORDER BY dead_letter_at DESC NULLS LAST, id DESC
        LIMIT 20
      `),
    ]);

    const c = countsRes.rows[0] || {};
    const deadLetterCount = Number(c.dead_letter_count || 0);
    readModelsQueryService.setOutboxDeadLetterCount(deadLetterCount);

    let snapshot: {
      lastOutboxEventId?: number | null;
      lastSyncedAt?: Date | null;
      lastProjectionSyncAt?: Date | null;
      lastDashboardRefreshAt?: Date | null;
    } | null = null;

    if (isMongoEnabled() && isMongoReady()) {
      snapshot = await DashboardSnapshotModel.findOne({ snapshotKey: '__global__' })
        .select({
          lastOutboxEventId: 1,
          lastSyncedAt: 1,
          lastProjectionSyncAt: 1,
          lastDashboardRefreshAt: 1,
        })
        .lean();
    }

    const syncStatus = isMongoEnabled()
      ? readModelsQueryService.buildSyncStatus(snapshot, 'dashboard')
      : null;

    res.status(200).json({
      success: true,
      data: {
        mongodbEnabled: isMongoEnabled(),
        mongodbReady: isMongoReady(),
        outbox: {
          pendingCount: Number(c.pending_count || 0),
          processingCount: Number(c.processing_count || 0),
          failedRetryableCount: Number(c.failed_retryable_count || 0),
          deadLetterCount,
          processedCount: Number(c.processed_count || 0),
          oldestUnresolvedAgeMs:
            c.oldest_unresolved_age_ms !== null && c.oldest_unresolved_age_ms !== undefined
              ? Math.max(0, Math.round(Number(c.oldest_unresolved_age_ms)))
              : null,
          recentDeadLetters: deadLettersRes.rows.map((row) => ({
            id: Number(row.id),
            eventId: String(row.event_id),
            aggregateType: String(row.aggregate_type),
            aggregateId: String(row.aggregate_id),
            eventType: String(row.event_type),
            attemptCount: Number(row.attempt_count),
            maxAttempts: Number(row.max_attempts),
            lastError: row.last_error ? String(row.last_error) : null,
            deadLetterAt: row.dead_letter_at ? new Date(row.dead_letter_at).toISOString() : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          })),
        },
        snapshot: snapshot
          ? {
              lastOutboxEventId: snapshot.lastOutboxEventId ?? null,
              lastSyncedAt: snapshot.lastSyncedAt
                ? new Date(snapshot.lastSyncedAt).toISOString()
                : null,
              lastProjectionSyncAt: snapshot.lastProjectionSyncAt
                ? new Date(snapshot.lastProjectionSyncAt).toISOString()
                : null,
              lastDashboardRefreshAt: snapshot.lastDashboardRefreshAt
                ? new Date(snapshot.lastDashboardRefreshAt).toISOString()
                : null,
            }
          : null,
        syncStatus,
        worker: readModelOutboxWorker.getStatus(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/read-model-sync/outbox/:id/retry
 * Owner-authenticated dead-letter / failed outbox recovery endpoint.
 * Resets attempt_count and status back to 'pending' so the outbox worker reprocesses it.
 */
router.post('/outbox/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = String(req.params.id || '').trim();
    if (!/^\d+$/.test(rawId)) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Outbox event id must be a positive integer.',
      });
      return;
    }

    const eventId = Number(rawId);
    if (!Number.isSafeInteger(eventId) || eventId <= 0) {
      res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Outbox event id must be a valid positive integer.',
      });
      return;
    }

    const updateRes = await appPool.query(
      `UPDATE app_outbox_events
       SET status = 'pending',
           attempt_count = 0,
           dead_letter_at = NULL,
           lease_expires_at = NULL,
           next_attempt_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('dead_letter', 'failed')
       RETURNING id, event_id, aggregate_type, aggregate_id, event_type, status, attempt_count, max_attempts`,
      [eventId]
    );

    if (updateRes.rows.length === 0) {
      const existingRes = await appPool.query(
        `SELECT id, status FROM app_outbox_events WHERE id = $1`,
        [eventId]
      );
      if (existingRes.rows.length === 0) {
        res.status(404).json({
          success: false,
          code: 'NOT_FOUND',
          message: 'Outbox event not found.',
        });
        return;
      }

      res.status(409).json({
        success: false,
        code: 'INVALID_OUTBOX_STATE',
        message: `Outbox event cannot be retried from status '${existingRes.rows[0].status}'.`,
      });
      return;
    }

    await readModelOutboxWorker.refreshDeadLetterIndicator().catch(() => {});
    readModelsQueryService.markOutboxBacklogPending(true);
    if (readModelOutboxWorker.isRunning()) {
      notifyOutboxCommitted();
    }

    const row = updateRes.rows[0];
    res.status(200).json({
      success: true,
      event: {
        id: Number(row.id),
        eventId: String(row.event_id),
        aggregateType: String(row.aggregate_type),
        aggregateId: String(row.aggregate_id),
        eventType: String(row.event_type),
        status: String(row.status),
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
      },
    });
  } catch (err) {
    next(err);
  }
});

export const readModelSyncRouter = router;
