import { z } from 'zod';
import { env } from '../../config/env.js';
import { isMongoEnabled, isMongoReady } from '../../config/mongodb.js';
import {
  AppActivityEventModel,
  AppTelemetryModel,
  NotificationModel,
  SearchAnalyticsModel,
  UserPreferenceModel,
  type NotificationDoc,
  type SearchAnalyticsDoc,
  type UserPreferenceDoc,
} from './models.js';
import { ReadModelUnavailableError } from '../readModels/readModelsQuery.service.js';

export const DEFAULT_USER_PREFERENCES: Omit<UserPreferenceDoc, 'updatedAt'> = {
  preferenceKey: 'owner',
  theme: {
    version: 3,
    preset: 'flat',
    textSize: '100',
    contrastOverride: 'enhanced',
    reduceMotion: 'system',
    increaseSpacing: false,
    strongFocus: false,
  },
  dashboardDefaults: {
    defaultDatePreset: 'all_time',
  },
  printPreferences: {
    defaultPaperSize: 'A4',
    autoOpenPreview: true,
  },
};

export const userPreferencesUpdateSchema = z
  .object({
    theme: z
      .object({
        version: z.number().int().min(1).max(10).optional(),
        preset: z.string().trim().min(1).max(32).optional(),
        textSize: z.string().trim().min(1).max(16).optional(),
        contrastOverride: z.string().trim().min(1).max(32).optional(),
        reduceMotion: z.string().trim().min(1).max(16).optional(),
        increaseSpacing: z.boolean().optional(),
        strongFocus: z.boolean().optional(),
      })
      .optional(),
    dashboardDefaults: z
      .object({
        defaultDatePreset: z.string().trim().min(1).max(32).optional(),
      })
      .optional(),
    printPreferences: z
      .object({
        defaultPaperSize: z.literal('A4').optional(),
        autoOpenPreview: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

export const telemetryPayloadSchema = z
  .object({
    kind: z.enum(['read_latency', 'outbox_sync', 'pdf_render', 'client_error']),
    name: z.string().trim().min(1).max(100),
    durationMs: z.number().finite().min(0).max(600_000).nullable().optional(),
    ok: z.boolean().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const notificationCreateSchema = z
  .object({
    category: z.enum(['quotation_expiry', 'sync', 'system', 'billing', 'supplier']).optional(),
    severity: z.enum(['info', 'warning', 'success', 'error']).optional(),
    title: z.string().trim().min(1).max(140),
    message: z.string().trim().min(1).max(500),
    entityType: z.string().trim().max(64).nullable().optional(),
    entityId: z.string().trim().max(64).nullable().optional(),
    dedupeKey: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

export class AppDataService {
  private ensureMongoAvailableForAppData(): boolean {
    if (!isMongoEnabled()) {
      return false;
    }
    if (!isMongoReady()) {
      if (env.NODE_ENV === 'production') {
        throw new ReadModelUnavailableError('MongoDB app-data store is unavailable.');
      }
      return false;
    }
    return true;
  }

  public async getUserPreferences(): Promise<{
    preferences: typeof DEFAULT_USER_PREFERENCES & { updatedAt: string | null };
    source: 'mongodb' | 'default';
  }> {
    if (!this.ensureMongoAvailableForAppData()) {
      return {
        preferences: { ...DEFAULT_USER_PREFERENCES, updatedAt: null },
        source: 'default',
      };
    }

    const doc = await UserPreferenceModel.findOne({ preferenceKey: 'owner' }).lean();
    if (!doc) {
      return {
        preferences: { ...DEFAULT_USER_PREFERENCES, updatedAt: null },
        source: 'mongodb',
      };
    }

    return {
      preferences: {
        preferenceKey: doc.preferenceKey || 'owner',
        theme: { ...DEFAULT_USER_PREFERENCES.theme, ...(doc.theme || {}) },
        dashboardDefaults: {
          ...DEFAULT_USER_PREFERENCES.dashboardDefaults,
          ...(doc.dashboardDefaults || {}),
        },
        printPreferences: {
          ...DEFAULT_USER_PREFERENCES.printPreferences,
          ...(doc.printPreferences || {}),
        },
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      },
      source: 'mongodb',
    };
  }

  public async updateUserPreferences(
    input: z.infer<typeof userPreferencesUpdateSchema>
  ): Promise<{
    preferences: typeof DEFAULT_USER_PREFERENCES & { updatedAt: string };
    source: 'mongodb' | 'default';
  }> {
    const parsed = userPreferencesUpdateSchema.parse(input);
    const now = new Date();

    if (!this.ensureMongoAvailableForAppData()) {
      return {
        preferences: {
          preferenceKey: 'owner',
          theme: { ...DEFAULT_USER_PREFERENCES.theme, ...(parsed.theme || {}) },
          dashboardDefaults: {
            ...DEFAULT_USER_PREFERENCES.dashboardDefaults,
            ...(parsed.dashboardDefaults || {}),
          },
          printPreferences: {
            ...DEFAULT_USER_PREFERENCES.printPreferences,
            ...(parsed.printPreferences || {}),
          },
          updatedAt: now.toISOString(),
        },
        source: 'default',
      };
    }

    const existing = await UserPreferenceModel.findOne({ preferenceKey: 'owner' }).lean();
    const mergedTheme = {
      ...DEFAULT_USER_PREFERENCES.theme,
      ...(existing?.theme || {}),
      ...(parsed.theme || {}),
    };
    const mergedDashboard = {
      ...DEFAULT_USER_PREFERENCES.dashboardDefaults,
      ...(existing?.dashboardDefaults || {}),
      ...(parsed.dashboardDefaults || {}),
    };
    const mergedPrint = {
      ...DEFAULT_USER_PREFERENCES.printPreferences,
      ...(existing?.printPreferences || {}),
      ...(parsed.printPreferences || {}),
    };

    await UserPreferenceModel.updateOne(
      { preferenceKey: 'owner' },
      {
        $set: {
          preferenceKey: 'owner',
          theme: mergedTheme,
          dashboardDefaults: mergedDashboard,
          printPreferences: mergedPrint,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    return {
      preferences: {
        preferenceKey: 'owner',
        theme: mergedTheme,
        dashboardDefaults: mergedDashboard,
        printPreferences: mergedPrint,
        updatedAt: now.toISOString(),
      },
      source: 'mongodb',
    };
  }

  public async listNotifications(options: {
    limit?: number;
    unreadOnly?: boolean;
  } = {}): Promise<{
    notifications: Array<{
      id: string;
      category: NotificationDoc['category'];
      severity: NotificationDoc['severity'];
      title: string;
      message: string;
      entityType: string | null;
      entityId: string | null;
      isRead: boolean;
      readAt: string | null;
      createdAt: string;
    }>;
    unreadCount: number;
    source: 'mongodb' | 'default';
  }> {
    if (!this.ensureMongoAvailableForAppData()) {
      return { notifications: [], unreadCount: 0, source: 'default' };
    }

    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 20)), 50);
    const filter: Record<string, unknown> = { ownerKey: 'owner' };
    if (options.unreadOnly) {
      filter.isRead = false;
    }

    const [docs, unreadCount] = await Promise.all([
      NotificationModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      NotificationModel.countDocuments({ ownerKey: 'owner', isRead: false }),
    ]);

    return {
      notifications: docs.map((d) => ({
        id: String((d as any)._id),
        category: d.category,
        severity: d.severity,
        title: d.title,
        message: d.message,
        entityType: d.entityType ?? null,
        entityId: d.entityId ?? null,
        isRead: Boolean(d.isRead),
        readAt: d.readAt ? new Date(d.readAt).toISOString() : null,
        createdAt: new Date(d.createdAt).toISOString(),
      })),
      unreadCount,
      source: 'mongodb',
    };
  }

  public async createNotification(
    input: z.infer<typeof notificationCreateSchema>
  ): Promise<{ created: boolean; source: 'mongodb' | 'default' }> {
    const parsed = notificationCreateSchema.parse(input);
    if (!this.ensureMongoAvailableForAppData()) {
      return { created: false, source: 'default' };
    }

    const now = new Date();
    const doc = {
      ownerKey: 'owner',
      category: parsed.category ?? 'system',
      severity: parsed.severity ?? 'info',
      title: parsed.title,
      message: parsed.message,
      entityType: parsed.entityType ?? null,
      entityId: parsed.entityId ?? null,
      isRead: false,
      readAt: null,
      dedupeKey: parsed.dedupeKey ?? null,
      createdAt: now,
    };

    if (parsed.dedupeKey) {
      await NotificationModel.updateOne(
        { dedupeKey: parsed.dedupeKey },
        { $setOnInsert: doc },
        { upsert: true }
      );
      return { created: true, source: 'mongodb' };
    }

    await NotificationModel.create(doc);
    return { created: true, source: 'mongodb' };
  }

  public async markNotificationsRead(notificationId?: string): Promise<{
    updatedCount: number;
    source: 'mongodb' | 'default';
  }> {
    if (!this.ensureMongoAvailableForAppData()) {
      return { updatedCount: 0, source: 'default' };
    }

    const now = new Date();
    const filter: Record<string, unknown> = { ownerKey: 'owner', isRead: false };
    if (notificationId && notificationId !== 'all') {
      filter._id = notificationId;
    }

    const res = await NotificationModel.updateMany(filter, {
      $set: { isRead: true, readAt: now },
    });

    return {
      updatedCount: Number(res.modifiedCount || 0),
      source: 'mongodb',
    };
  }

  public async recordSearchAnalytics(entry: {
    module: SearchAnalyticsDoc['module'];
    query: string;
    resultCount: number;
    source: 'mongodb' | 'postgresql';
    durationMs: number;
  }): Promise<void> {
    if (!isMongoEnabled() || !isMongoReady()) return;
    const normalizedQuery = entry.query.trim().toLowerCase().slice(0, 100);
    if (!normalizedQuery) return;
    await SearchAnalyticsModel.create({
      module: entry.module,
      normalizedQuery,
      resultCount: Math.max(0, Math.trunc(entry.resultCount)),
      source: entry.source,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      createdAt: new Date(),
    }).catch(() => {});
  }

  public async recordAppActivity(entry: {
    eventType: string;
    module: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!isMongoEnabled() || !isMongoReady()) return;
    await AppActivityEventModel.create({
      actor: 'owner',
      eventType: entry.eventType.slice(0, 64),
      module: entry.module.slice(0, 64),
      metadata: entry.metadata ?? {},
      createdAt: new Date(),
    }).catch(() => {});
  }

  public async recordTelemetry(
    input: z.infer<typeof telemetryPayloadSchema>
  ): Promise<{ recorded: boolean }> {
    const parsed = telemetryPayloadSchema.parse(input);
    if (!isMongoEnabled() || !isMongoReady()) {
      return { recorded: false };
    }

    await AppTelemetryModel.create({
      kind: parsed.kind,
      name: parsed.name,
      durationMs: parsed.durationMs ?? null,
      ok: parsed.ok ?? true,
      meta: parsed.meta ?? {},
      createdAt: new Date(),
    });

    return { recorded: true };
  }
}

export const appDataService = new AppDataService();
