import mongoose, { Schema, type Model } from 'mongoose';

export interface UserPreferenceDoc {
  preferenceKey: string;
  theme: {
    version: number;
    preset: string;
    textSize: string;
    contrastOverride: string;
    reduceMotion: string;
    increaseSpacing: boolean;
    strongFocus: boolean;
  };
  dashboardDefaults: {
    defaultDatePreset: string;
  };
  printPreferences: {
    defaultPaperSize: 'A4';
    autoOpenPreview: boolean;
  };
  updatedAt: Date;
}

const userPreferenceSchema = new Schema<UserPreferenceDoc>(
  {
    preferenceKey: { type: String, required: true, default: 'owner' },
    theme: {
      version: { type: Number, required: true, default: 3 },
      preset: { type: String, required: true, default: 'flat' },
      textSize: { type: String, required: true, default: '100' },
      contrastOverride: { type: String, required: true, default: 'enhanced' },
      reduceMotion: { type: String, required: true, default: 'system' },
      increaseSpacing: { type: Boolean, required: true, default: false },
      strongFocus: { type: Boolean, required: true, default: false },
    },
    dashboardDefaults: {
      defaultDatePreset: { type: String, required: true, default: 'all_time' },
    },
    printPreferences: {
      defaultPaperSize: { type: String, enum: ['A4'], default: 'A4' },
      autoOpenPreview: { type: Boolean, default: true },
    },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'user_preferences',
    autoIndex: false,
    versionKey: false,
  }
);

userPreferenceSchema.index(
  { preferenceKey: 1 },
  { unique: true, name: 'idx_user_preferences_key_unique' }
);

export interface NotificationDoc {
  ownerKey: string;
  category: 'quotation_expiry' | 'sync' | 'system' | 'billing' | 'supplier';
  severity: 'info' | 'warning' | 'success' | 'error';
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: Date | null;
  dedupeKey: string | null;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    ownerKey: { type: String, required: true, default: 'owner' },
    category: {
      type: String,
      required: true,
      enum: ['quotation_expiry', 'sync', 'system', 'billing', 'supplier'],
      default: 'system',
    },
    severity: {
      type: String,
      required: true,
      enum: ['info', 'warning', 'success', 'error'],
      default: 'info',
    },
    title: { type: String, required: true, maxlength: 140 },
    message: { type: String, required: true, maxlength: 500 },
    entityType: { type: String, default: null },
    entityId: { type: String, default: null },
    isRead: { type: Boolean, required: true, default: false },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'notifications',
    autoIndex: false,
    versionKey: false,
  }
);

notificationSchema.index(
  { ownerKey: 1, isRead: 1, createdAt: -1 },
  { name: 'idx_notifications_owner_unread_recent' }
);
notificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, sparse: true, name: 'idx_notifications_dedupe_unique' }
);

export interface AppActivityEventDoc {
  actor: string;
  eventType: string;
  module: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const appActivityEventSchema = new Schema<AppActivityEventDoc>(
  {
    actor: { type: String, required: true, default: 'owner' },
    eventType: { type: String, required: true, maxlength: 64 },
    module: { type: String, required: true, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'app_activity_events',
    autoIndex: false,
    versionKey: false,
  }
);

appActivityEventSchema.index({ createdAt: -1 }, { name: 'idx_app_activity_created_desc' });
appActivityEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'idx_app_activity_ttl_90d' }
);

export interface SearchAnalyticsDoc {
  module: 'products' | 'customers' | 'quotations' | 'bills' | 'offline_bills' | 'suppliers';
  normalizedQuery: string;
  resultCount: number;
  source: 'mongodb' | 'postgresql';
  durationMs: number;
  createdAt: Date;
}

const searchAnalyticsSchema = new Schema<SearchAnalyticsDoc>(
  {
    module: {
      type: String,
      required: true,
      enum: ['products', 'customers', 'quotations', 'bills', 'offline_bills', 'suppliers'],
    },
    normalizedQuery: { type: String, required: true, maxlength: 100 },
    resultCount: { type: Number, required: true, default: 0 },
    source: { type: String, enum: ['mongodb', 'postgresql'], required: true, default: 'mongodb' },
    durationMs: { type: Number, required: true, default: 0 },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'search_analytics',
    autoIndex: false,
    versionKey: false,
  }
);

searchAnalyticsSchema.index({ module: 1, createdAt: -1 }, { name: 'idx_search_analytics_module_recent' });
searchAnalyticsSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'idx_search_analytics_ttl_30d' }
);

export interface AppTelemetryDoc {
  kind: 'read_latency' | 'outbox_sync' | 'pdf_render' | 'client_error';
  name: string;
  durationMs: number | null;
  ok: boolean;
  meta: Record<string, unknown>;
  createdAt: Date;
}

const appTelemetrySchema = new Schema<AppTelemetryDoc>(
  {
    kind: {
      type: String,
      required: true,
      enum: ['read_latency', 'outbox_sync', 'pdf_render', 'client_error'],
    },
    name: { type: String, required: true, maxlength: 100 },
    durationMs: { type: Number, default: null },
    ok: { type: Boolean, required: true, default: true },
    meta: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  {
    collection: 'app_telemetry',
    autoIndex: false,
    versionKey: false,
  }
);

appTelemetrySchema.index({ kind: 1, createdAt: -1 }, { name: 'idx_app_telemetry_kind_recent' });
appTelemetrySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 14 * 24 * 60 * 60, name: 'idx_app_telemetry_ttl_14d' }
);

function getOrCreateModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) || mongoose.model<T>(name, schema);
}

export const UserPreferenceModel = getOrCreateModel<UserPreferenceDoc>(
  'UserPreference',
  userPreferenceSchema
);
export const NotificationModel = getOrCreateModel<NotificationDoc>(
  'Notification',
  notificationSchema
);
export const AppActivityEventModel = getOrCreateModel<AppActivityEventDoc>(
  'AppActivityEvent',
  appActivityEventSchema
);
export const SearchAnalyticsModel = getOrCreateModel<SearchAnalyticsDoc>(
  'SearchAnalytics',
  searchAnalyticsSchema
);
export const AppTelemetryModel = getOrCreateModel<AppTelemetryDoc>(
  'AppTelemetry',
  appTelemetrySchema
);

export const APP_DATA_MODELS = [
  UserPreferenceModel,
  NotificationModel,
  AppActivityEventModel,
  SearchAnalyticsModel,
  AppTelemetryModel,
] as const;
