# Khata ERP — MongoDB Read-Optimized Architecture & Outbox Synchronization

- **Release:** `#030`
- **Owner / Maintainer:** ALGIONS AI LABS PRIVATE LIMITED
- **Primary System of Record:** Neon PostgreSQL (`postgresql`, migrations `001`–`031`)
- **Read-Optimized Projection & App-Data Store:** MongoDB (`mongoose`, controlled indexes + partial unique filters + TTL collections)

---

## 1. Architectural Responsibilities & Boundaries

| Tier | Technology | Authoritative Responsibilities | Explicit Non-Responsibilities |
|---|---|---|---|
| **Transactional Ledger & Financial Source of Truth** | PostgreSQL (Neon) | All ACID financial writes: Products (`name`, `buying_price`, `hsn_code`, `barcode`, R2 keys, `created_at`), Customers, Udhar & Payments, GST Invoices, Normal Bills, Quotations, Suppliers & Purchase Bills/Payments/Reversals, Operating Expenses, Sessions, `app_outbox_events` | High-frequency read search scans or UI app telemetry/notification storage |
| **Read-Optimized Projections** | MongoDB (`READ_MODEL_MODELS`) | Zero-PG-query reads for Dashboard Overview (filtered & all-time), Product Search & Barcode Lookup, Khata Summary & Customer Directory, Recent Activity | Authoritative financial mutation; inventory/stock quantity tracking |
| **Application & Operational Store** | MongoDB (`APP_DATA_MODELS`) | User accessibility/theme preferences (`/api/v1/preferences`), persistent notifications (`/api/v1/notifications`), TTL-managed redacted search analytics, activity events, and telemetry (`/api/v1/telemetry`) | Replicating sensitive credentials, raw customer phone/name PII in search analytics, or financial ledger source records |
| **Binary Document & Media Store** | Cloudflare R2 | Canonical A4 PDFKit outputs, product photos (`5 MB` max), offline bills (`10 MB` max), supplier purchase bills (`10 MB` max) | Public unauthenticated bucket access |

### Single-Vendor Khata Domain Invariant

Products remain an owner purchase-price & tax reference catalogue (`name`, `buyingPrice`, `hsnCode`, `barcode`, `imageObjectKey`, `imageUrl`, `isArchived`, `createdAtPg`). **`product_search` never stores or tracks `quantity`, `stock`, or `stock_qty`.**

---

## 2. MongoDB Collections & Index Registry

### 2.1 Read-Model Collections (`backend/src/modules/readModels/models.ts`)

1. **`product_search` (`ProductSearchModel`)**
   - Purpose: Pre-tokenized catalogue lookup (`searchTokens`, `normalizedName`, `normalizedHsnCode`), exact barcode lookup, original `createdAtPg` preservation, keyset pagination, and image-proxy object key lookup without waking PostgreSQL.
   - Indexes:
     - `idx_product_search_id_unique` — `{ productId: 1 }` (`unique: true`)
     - `idx_product_search_active_name` — `{ isArchived: 1, normalizedName: 1, productId: 1 }`
     - `idx_product_search_barcode` — `{ barcode: 1 }` (`sparse: true`)
     - `idx_product_search_active_barcode` — `{ isArchived: 1, barcode: 1 }` (`sparse: true`)
     - `idx_product_search_hsn` — `{ hsnCode: 1 }` (`sparse: true`)
     - `idx_product_search_active_norm_hsn` — `{ isArchived: 1, normalizedHsnCode: 1, productId: 1 }`
     - `idx_product_search_tokens` — `{ searchTokens: 1 }`
     - `idx_product_search_active_tokens` — `{ isArchived: 1, searchTokens: 1 }`

2. **`customer_summaries` (`CustomerSummaryModel`)**
   - Purpose: Pre-aggregated Khata balances (`totalUdhar`, `totalReceived`, `outstanding`, `outstandingPaise`) and indexed token/prefix directory search (`buildCustomerSearchTokens()`) with keyset cursor pagination (`{ outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }`).
   - Indexes:
     - `idx_customer_summaries_id_unique` — `{ customerId: 1 }` (`unique: true`)
     - `idx_customer_summaries_active_outstanding` — `{ isArchived: 1, outstandingPaise: -1, lastActivityAt: -1, customerId: 1 }`
     - `idx_customer_summaries_active_name` — `{ isArchived: 1, normalizedName: 1, customerId: 1 }`
     - `idx_customer_summaries_phone` — `{ normalizedPhone: 1 }` (`sparse: true`)
     - `idx_customer_summaries_active_phone` — `{ isArchived: 1, normalizedPhone: 1 }` (`sparse: true`)
     - `idx_customer_summaries_tokens` — `{ searchTokens: 1 }`
     - `idx_customer_summaries_active_tokens` — `{ isArchived: 1, searchTokens: 1 }`

3. **`daily_analytics` (`DailyAnalyticsModel`)**
   - Purpose: Pre-aggregated per-business-day (`YYYY-MM-DD`, `Asia/Kolkata`) financial buckets across Normal Bills, GST Invoices, Operating Expenses (active vs voided), Khata credit/payments, Quotations, Supplier bills/payments/reversals, and per-product sales (`productSales`).
   - Indexes:
     - `idx_daily_analytics_business_date_unique` — `{ businessDate: 1 }` (`unique: true`)
     - `idx_daily_analytics_month_date` — `{ yearMonth: 1, businessDate: 1 }`

4. **`dashboard_snapshots` (`DashboardSnapshotModel`)**
   - Purpose: Global point-in-time totals (`globals`), `allTimeOverview`, `lastOutboxEventId`, `lastSyncedAt`, separated `lastProjectionSyncAt` (item-level sync timestamp) and `lastDashboardRefreshAt` (coalesced global snapshot timestamp) powering `buildSyncStatus()`.
   - Indexes:
     - `idx_dashboard_snapshots_key_unique` — `{ snapshotKey: 1 }` (`unique: true`)

5. **`recent_activity` (`RecentActivityModel`)** — **180-day TTL**
   - Purpose: Unified cross-module activity feed (`normal_bill`, `gst_invoice`, `khata_credit`, `khata_payment`, `supplier_bill`, `supplier_payment`, `supplier_payment_reversal`, `supplier_allocation_reversal`, `supplier_bill_cancellation`, `expense`, `expense_void`, `quotation`) with bounded 180-day MongoDB retention.
   - Indexes:
     - `idx_recent_activity_key_unique` — `{ activityKey: 1 }` (`unique: true`)
     - `idx_recent_activity_date_desc` — `{ date: -1, occurredAt: -1 }`
     - `idx_recent_activity_occurred_desc` — `{ occurredAt: -1 }`
     - `idx_recent_activity_ttl_180d` — `{ occurredAt: 1 }` (`expireAfterSeconds: 15552000`)

### 2.2 App-Data & TTL Collections (`backend/src/modules/appData/models.ts`)

1. **`user_preferences` (`UserPreferenceModel`)**
   - Stores owner theme/accessibility configuration (`version`, `preset`, `textSize`, `contrastOverride`, `reduceMotion`, `increaseSpacing`, `strongFocus`), `dashboardDefaults`, and `printPreferences`.
   - Index: `idx_user_preferences_key_unique` (`{ preferenceKey: 1 }`, unique).

2. **`notifications` (`NotificationModel`)**
   - Stores actionable system/operational alerts with `isRead` / `readAt` tracking and optional idempotent deduplication (`dedupeKey` omitted when absent).
   - Indexes:
     - `idx_notifications_owner_unread_recent` (`{ ownerKey: 1, isRead: 1, createdAt: -1 }`)
     - `idx_notifications_dedupe_unique` (`{ dedupeKey: 1 }`, `unique: true`, `partialFilterExpression: { dedupeKey: { $type: 'string' } }`)

3. **`app_activity_events` (`AppActivityEventModel`)** — **90-day TTL**
   - Indexes: `idx_app_activity_created_desc`, `idx_app_activity_ttl_90d` (`expireAfterSeconds: 7776000`).

4. **`search_analytics` (`SearchAnalyticsModel`)** — **30-day TTL (PII-Redacted)**
   - For `module: 'customers'`, `AppDataService.classifyCustomerSearchQuery()` replaces raw names/phone numbers with aggregate buckets (`'customer_phone_search'`, `'customer_name_search'`, or `'customer_other_search'`).
   - Indexes: `idx_search_analytics_module_recent`, `idx_search_analytics_ttl_30d` (`expireAfterSeconds: 2592000`).

5. **`app_telemetry` (`AppTelemetryModel`)** — **14-day TTL**
   - Indexes: `idx_app_telemetry_kind_recent`, `idx_app_telemetry_ttl_14d` (`expireAfterSeconds: 1209600`).

### 2.3 Index & Connection Governance

- All Mongoose schemas specify `autoIndex: false` and `mongoose.connect` disables `autoIndex` / `autoCreate`.
- On connection, `ensureMongoIndexes()` in `backend/src/config/mongodb.ts`:
  1. Runs `migrateNotificationDedupeIndex()` to safely detect and drop any legacy `sparse: true` `idx_notifications_dedupe_unique` index lacking `{ dedupeKey: { $type: 'string' } }`, and `$unset` legacy `dedupeKey: null` fields without touching valid string keys.
  2. Explicitly invokes `model.createIndexes()` across `READ_MODEL_MODELS` and `APP_DATA_MODELS` (never destructively wiping custom indexes via blind `syncIndexes()`).
- Diagnostic logs scrub credentials via `redactMongoUri()`.

---

## 3. Event-Driven Outbox, Resilience & Synchronization Lifecycle

### 3.1 Transactional Outbox (`027_outbox_events.sql` + `028_outbox_dead_letter.sql`)

```
PostgreSQL Transaction (BEGIN)
  ├── Financial / Domain INSERT / UPDATE / ARCHIVE
  ├── enqueueOutboxEvent(client, { aggregateType, aggregateId, eventType, ... }) -> app_outbox_events ('pending')
PostgreSQL COMMIT
  └── notifyOutboxCommitted()  ──▶  In-process EventEmitter ('outbox:committed')
                                      └──▶ ReadModelOutboxWorker.triggerDrain() -> drainNow()
                                             ├── Claim due rows with FOR UPDATE SKIP LOCKED + active lease heartbeat (renewBatchLease)
                                             ├── Apply projection batches (upsertProjectionWithTimestampGuard / $max sync timestamp)
                                             ├── Update app_outbox_events: 'processed' | 'failed' (exponential backoff) | 'dead_letter' (dead_letter_at)
                                             └── Coalesce global dashboard_snapshots refresh (READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS)
```

### 3.2 Zero Idle Polling, Failure Propagation & Dead-Letter Recovery

- **Zero Idle Polling:** `ReadModelOutboxWorker` (`backend/src/modules/readModels/readModelOutbox.worker.ts`) uses an in-process `EventEmitter` listener on committed writes and **never runs an idle `setInterval` poller**. *(Tradeoff: Render free-tier web instances run as a single Node process; horizontal multi-instance scaling would require an external pub/sub or low-frequency wake mechanism across workers.)*
- **Lease Renewal & Exhaustion Protection:** Long-running batches renew their lock via `renewBatchLease()` every `leaseHeartbeatIntervalMs`. When PostgreSQL or MongoDB throws during batch failure recording, `markEventsFailedWithBackoff()` propagates errors to `handleDrainFailure()`, activating bounded exponential-backoff retries (`scheduleOneShotRetry()`) and marking `outboxDegraded: true`.
- **`O(log N)` `LIMIT 1` Backlog Wakeup Probes (Release #030):** `inspectRetryableBacklogDelay()` executes a 3-branch `UNION ALL` (`LIMIT 1` on `pending`, retryable `failed`, and `processing`) over partial outbox indexes (`031_outbox_worker_search_indexes.sql`), eliminating full-table scans over `100k+` `'processed'` events, while `refreshDeadLetterIndicator()` runs only at startup and exhaustion transitions.
- **Dead-Letter Transition & Owner Recovery:** Exhausted events (`attempt_count >= max_attempts`) deterministically transition to `status = 'dead_letter'` with `dead_letter_at = NOW()` (`028_outbox_dead_letter.sql`, backfilling legacy exhausted rows in `029`), surfaced alongside `searchCapabilities` via `GET /api/v1/read-model-sync/status` and retryable on demand via `POST /api/v1/read-model-sync/outbox/:id/retry` (`backend/src/modules/readModels/readModelSync.routes.ts`).
- **Coalesced Snapshot Refreshes:** Burst domain writes update `product_search`, `customer_summaries`, `daily_analytics`, and `recent_activity` immediately via deduplicated outbox aggregation and batched `bulkWrite` syncs while throttling full PostgreSQL global `dashboard_snapshots` queries via `READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS` (`15000 ms` default) with a single trailing flush (`flushDashboardRefresh()`).
- **Durable R2 Orphan Cleanup Isolation:** Failed Cloudflare R2 object deletions enqueue retries in dedicated table `storage_cleanup_jobs` (`030_storage_cleanup_jobs.sql`, `StorageCleanupWorker`) rather than polluting financial `app_outbox_events`.

### 3.3 Separation of Schema Migrations vs Read-Model Rebuilds

- **Schema Migrations Only:** `backend/scripts/migrate.ts` (`npm run migrate`) executes strictly ordered SQL migrations (`001`–`031`) without triggering full MongoDB rebuilds.
- **Explicit Rebuild CLI:** `backend/scripts/rebuild-read-models.ts` (`npm run rebuild:read-models -- --confirm`) requires `--confirm` / `--yes` and fails closed otherwise, invoking `ReadModelSyncService.rebuildAllReadModels({ confirm: true })` in bounded batches.

---

## 4. Zero-PG-Query Read Routes, Keyset Cursors & Fail-Closed Semantics

When `MONGODB_ENABLED=true`:
- `GET /api/v1/dashboard/overview` -> `readModelsQueryService.getDashboardOverviewFromMongo(...)`
- `GET /api/v1/products`, `GET /api/v1/products/barcode/:barcode`, `GET /api/v1/products/:id/image` (metadata) -> `readModelsQueryService` (bounded lexicographic interval prefix matching with `$elemMatch` for tokens `> 12` chars, conditional exact-count skipping `total: null` / `totalIsExact: false` on broad queries, keyset `cursor` over `{ normalizedName, productId }`, and original `created_at`)
- `GET /api/v1/khata`, `GET /api/v1/khata/summary`, `GET /api/v1/khata/customers` -> `readModelsQueryService` (bounded prefix interval matching with `$elemMatch` for phone variants `> 15` chars and keyset `cursor` over `{ outstandingPaise, lastActivityAt, customerId }`)
- `GET / PUT /api/v1/preferences`, `GET / POST / PATCH /api/v1/notifications*`, `POST /api/v1/telemetry` -> `appDataService` (MongoDB only; invalid ObjectIds return HTTP `400 INVALID_NOTIFICATION_ID`)
- **PostgreSQL Queries Executed on All Above Read Paths:** `0`

### Fail-Closed & Cursor Error Contracts

- If `MONGODB_ENABLED=true` and MongoDB disconnects (`!isMongoReady()`), `ReadModelsQueryService.assertMongoReady()` throws `ReadModelUnavailableError`, returning HTTP `503` (`code: "READ_MODEL_UNAVAILABLE"`) without silent Neon fallback scans.
- Malformed, tampered, or cross-query `cursor` tokens (`buildProductCursorQueryContext` / `buildCustomerCursorQueryContext` checked by `decodeProductCursor` / `decodeCustomerCursor`) throw `InvalidPaginationCursorError`, returning HTTP `400` (`code: "INVALID_PAGINATION_CURSOR"`).
- `/api/v1/health/live` executes `0` PostgreSQL or MongoDB queries; `/api/v1/health/ready` runs explicit readiness probes.

---

## 5. Strict Environment Configuration (`backend/src/config/mongoEnv.ts`, `render.yaml`)

- `parseStrictEnvBoolean()` rejects ambiguous boolean strings (`"falsee"`, `"yes"`).
- In `NODE_ENV=production`, `validateAndParseMongoEnv()` requires `MONGODB_ENABLED=true` and a valid non-placeholder `MONGODB_URI`, alongside bounded `MONGODB_READ_STALE_THRESHOLD_MS` (`5000`–`3600000`, default `300000`) and `READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS` (`1000`–`300000`, default `15000`).
- `render.yaml` explicitly declares `MONGODB_ENABLED: "true"`, `MONGODB_URI` (`sync: false`), `MONGODB_DATABASE: khata`, `MONGODB_READ_STALE_THRESHOLD_MS: "300000"`, and `READ_MODEL_DASHBOARD_REFRESH_MIN_INTERVAL_MS: "15000"`.
