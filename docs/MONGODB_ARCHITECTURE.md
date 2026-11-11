# Khata ERP — MongoDB Read-Optimized Architecture & Outbox Synchronization

- **Release:** `#027`
- **Owner / Maintainer:** ALGIONS AI LABS PRIVATE LIMITED
- **Primary System of Record:** Neon PostgreSQL (`postgresql`, migrations `001`–`027`)
- **Read-Optimized Projection & App-Data Store:** MongoDB (`mongoose`, controlled indexes + TTL collections)

---

## 1. Architectural Responsibilities & Boundaries

| Tier | Technology | Authoritative Responsibilities | Explicit Non-Responsibilities |
|---|---|---|---|
| **Transactional Ledger & Financial Source of Truth** | PostgreSQL (Neon) | All ACID financial writes: Products (`name`, `buying_price`, `hsn_code`, `barcode`, R2 keys), Customers, Udhar & Payments, GST Invoices, Normal Bills, Quotations, Suppliers & Purchase Bills/Payments/Reversals, Operating Expenses, Sessions, `app_outbox_events` | High-frequency read search scans or UI app telemetry/notification storage |
| **Read-Optimized Projections** | MongoDB (`READ_MODEL_MODELS`) | Zero-PG-query reads for Dashboard Overview (filtered & all-time), Product Search & Barcode Lookup, Khata Summary & Customer Directory, Recent Activity | Authoritative financial mutation; inventory/stock quantity tracking |
| **Application & Operational Store** | MongoDB (`APP_DATA_MODELS`) | User accessibility/theme preferences (`/api/v1/preferences`), persistent notifications (`/api/v1/notifications`), TTL-managed search analytics, activity events, and telemetry (`/api/v1/telemetry`) | Replicating sensitive credentials or financial ledger source records |
| **Binary Document & Media Store** | Cloudflare R2 | Canonical A4 PDFKit outputs, product photos (`5 MB` max), offline bills (`10 MB` max), supplier purchase bills (`10 MB` max) | Public unauthenticated bucket access |

### Single-Vendor Khata Domain Invariant

Products remain an owner purchase-price & tax reference catalogue (`name`, `buyingPrice`, `hsnCode`, `barcode`, `imageObjectKey`, `imageUrl`, `isArchived`). **`product_search` never stores or tracks `quantity`, `stock`, or `stock_qty`.**

---

## 2. MongoDB Collections & Index Registry

### 2.1 Read-Model Collections (`backend/src/modules/readModels/models.ts`)

1. **`product_search` (`ProductSearchModel`)**
   - Purpose: Pre-tokenized catalogue lookup, barcode lookup, and image-proxy object key lookup without waking PostgreSQL.
   - Indexes:
     - `idx_product_search_id_unique` — `{ productId: 1 }` (`unique: true`)
     - `idx_product_search_active_name` — `{ isArchived: 1, normalizedName: 1, productId: 1 }`
     - `idx_product_search_barcode` — `{ barcode: 1 }` (`sparse: true`)
     - `idx_product_search_hsn` — `{ hsnCode: 1 }` (`sparse: true`)
     - `idx_product_search_tokens` — `{ searchTokens: 1 }`

2. **`customer_summaries` (`CustomerSummaryModel`)**
   - Purpose: Pre-aggregated Khata balances (`totalUdhar`, `totalReceived`, `outstanding`, `outstandingPaise`) and directory search.
   - Indexes:
     - `idx_customer_summaries_id_unique` — `{ customerId: 1 }` (`unique: true`)
     - `idx_customer_summaries_active_outstanding` — `{ isArchived: 1, outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }`
     - `idx_customer_summaries_active_name` — `{ isArchived: 1, normalizedName: 1, customerId: 1 }`
     - `idx_customer_summaries_phone` — `{ normalizedPhone: 1 }` (`sparse: true`)
     - `idx_customer_summaries_tokens` — `{ searchTokens: 1 }`

3. **`daily_analytics` (`DailyAnalyticsModel`)**
   - Purpose: Pre-aggregated per-business-day (`YYYY-MM-DD`, `Asia/Kolkata`) financial buckets across Normal Bills, GST Invoices, Operating Expenses (active vs voided), Khata credit/payments, Quotations, Supplier bills/payments/reversals, and per-product sales (`productSales`).
   - Indexes:
     - `idx_daily_analytics_business_date_unique` — `{ businessDate: 1 }` (`unique: true`)
     - `idx_daily_analytics_month_date` — `{ yearMonth: 1, businessDate: 1 }`

4. **`dashboard_snapshots` (`DashboardSnapshotModel`)**
   - Purpose: Global point-in-time totals (`globals`), `allTimeOverview`, `lastOutboxEventId`, and `lastSyncedAt` powering dashboard staleness badges (`syncStatus`).
   - Indexes:
     - `idx_dashboard_snapshots_key_unique` — `{ snapshotKey: 1 }` (`unique: true`)

5. **`recent_activity` (`RecentActivityModel`)**
   - Purpose: Unified cross-module activity feed (`normal_bill`, `gst_invoice`, `khata_credit`, `khata_payment`, `supplier_bill`, `supplier_payment`, `supplier_payment_reversal`, `supplier_allocation_reversal`, `supplier_bill_cancellation`, `expense`, `expense_void`, `quotation`).
   - Indexes:
     - `idx_recent_activity_key_unique` — `{ activityKey: 1 }` (`unique: true`)
     - `idx_recent_activity_date_desc` — `{ date: -1, occurredAt: -1 }`
     - `idx_recent_activity_occurred_desc` — `{ occurredAt: -1 }`

### 2.2 App-Data & TTL Collections (`backend/src/modules/appData/models.ts`)

1. **`user_preferences` (`UserPreferenceModel`)**
   - Stores owner theme/accessibility configuration (`version`, `preset`, `textSize`, `contrastOverride`, `reduceMotion`, `increaseSpacing`, `strongFocus`), `dashboardDefaults`, and `printPreferences`.
   - Index: `idx_user_preferences_key_unique` (`{ preferenceKey: 1 }`, unique).

2. **`notifications` (`NotificationModel`)**
   - Stores actionable system/operational alerts with `isRead` / `readAt` tracking and optional idempotent deduplication (`dedupeKey`).
   - Indexes: `idx_notifications_owner_unread_recent` (`{ ownerKey: 1, isRead: 1, createdAt: -1 }`), `idx_notifications_dedupe_unique` (`{ dedupeKey: 1 }`, unique sparse).

3. **`app_activity_events` (`AppActivityEventModel`)** — **90-day TTL**
   - Indexes: `idx_app_activity_created_desc`, `idx_app_activity_ttl_90d` (`expireAfterSeconds: 7776000`).

4. **`search_analytics` (`SearchAnalyticsModel`)** — **30-day TTL**
   - Indexes: `idx_search_analytics_module_recent`, `idx_search_analytics_ttl_30d` (`expireAfterSeconds: 2592000`).

5. **`app_telemetry` (`AppTelemetryModel`)** — **14-day TTL**
   - Indexes: `idx_app_telemetry_kind_recent`, `idx_app_telemetry_ttl_14d` (`expireAfterSeconds: 1209600`).

### 2.3 Index & Connection Governance

- All Mongoose schemas specify `autoIndex: false` and `mongoose.connect` disables `autoIndex` / `autoCreate`.
- On connection, `ensureMongoIndexes()` in `backend/src/config/mongodb.ts` explicitly runs `model.createIndexes()` across `READ_MODEL_MODELS` and `APP_DATA_MODELS` (never destructively dropping indexes via blind `syncIndexes()`).
- Diagnostic logs scrub credentials via `redactMongoUri()`.

---

## 3. Event-Driven Outbox & Synchronization Lifecycle

### 3.1 Transactional Outbox (`backend/migrations/027_outbox_events.sql`)

```
PostgreSQL Transaction (BEGIN)
  ├── Financial / Domain INSERT / UPDATE / ARCHIVE
  ├── enqueueOutboxEvent(client, { aggregateType, aggregateId, eventType, ... }) -> app_outbox_events ('pending')
PostgreSQL COMMIT
  └── notifyOutboxCommitted()  ──▶  In-process 'outbox:committed' event
                                      └──▶ ReadModelOutboxWorker.triggerDrain() -> drainNow()
                                             ├── Claim due rows with FOR UPDATE SKIP LOCKED (30s lease default)
                                             ├── Recompute & upsert Mongo projections (monotonic sourceUpdatedAt guard)
                                             └── UPDATE app_outbox_events SET status = 'processed'
```

### 3.2 Zero Idle Database Polling Guarantee

- `ReadModelOutboxWorker` (`backend/src/modules/readModels/readModelOutbox.worker.ts`) **never runs a periodic `setInterval` polling loop** against an empty `app_outbox_events` table.
- When `drainNow()` drains all ready rows and no retryable failures remain (`!retryStatus.hasBacklog`), it clears any retry timer and returns completely idle (`hasRetryTimerScheduled() === false`), preserving Neon auto-suspend compute quotas during idle periods.
- Only when an outbox batch fails to write to MongoDB does the worker mark backlog staleness (`readModelsQueryService.markOutboxBacklogPending(true)`) and schedule a bounded one-shot backoff timer (`scheduleOneShotRetry`, bounded `500 ms` to `maxBackoffMs`, default `60,000 ms`).

### 3.3 Full Deterministic Rebuild (`npm run rebuild:read-models -- --confirm`)

- Script: `backend/scripts/rebuild-read-models.ts` -> `ReadModelSyncService.rebuildAllReadModels({ confirm: true })`.
- Safeguard: fails closed unless `--confirm` or `--yes` is supplied on CLI.
- Recomputes all active/archived `product_search` records, `customer_summaries`, distinct business-date `daily_analytics` partitions across all 10 source financial tables, `recent_activity` (`limit: 40`), and `dashboard_snapshots`.

---

## 4. Zero-PG-Query Read Routes & Fail-Closed Semantics

When `MONGODB_ENABLED=true`:
- `GET /api/v1/dashboard/overview` -> `readModelsQueryService.getDashboardOverviewFromMongo(...)`
- `GET /api/v1/products`, `GET /api/v1/products/barcode/:barcode`, `GET /api/v1/products/:id/image` (metadata) -> `readModelsQueryService`
- `GET /api/v1/khata`, `GET /api/v1/khata/summary`, `GET /api/v1/khata/customers` -> `readModelsQueryService`
- `GET / PUT /api/v1/preferences`, `GET / POST / PATCH /api/v1/notifications*`, `POST /api/v1/telemetry` -> `appDataService` (MongoDB only)
- **PostgreSQL Queries Executed on All Above Read Paths:** `0`

### Fail-Closed Outage Contract

- If `MONGODB_ENABLED=true` and MongoDB disconnects (`!isMongoReady()`), `ReadModelsQueryService.assertMongoReady()` throws `ReadModelUnavailableError`.
- Read routes respond with HTTP `503` and JSON `{ success: false, code: "READ_MODEL_UNAVAILABLE", message: ... }` rather than silently falling back to expensive Neon read aggregations during an outage.
- `/api/v1/health/live` executes `0` PostgreSQL or MongoDB queries; `/api/v1/health/ready` runs explicit `checkDatabaseReadiness()` + `checkMongoReadiness()`.

---

## 5. Strict Environment Configuration (`backend/src/config/mongoEnv.ts`)

- Boolean environment variables (`MONGODB_ENABLED` via `parseStrictEnvBoolean()` in `backend/src/config/mongoEnv.ts`, and `SESSION_COOKIE_SECURE` / `SESSION_COOKIE_HTTP_ONLY` via `booleanStringSchema` in `backend/src/config/env.ts`) reject ambiguous strings such as `"falsee"` or `"yes"` at boot instead of silently coercing via `z.coerce.boolean()`.
- In `NODE_ENV=production`, `validateAndParseMongoEnv()` requires `MONGODB_ENABLED=true` and a valid non-placeholder `MONGODB_URI`.
