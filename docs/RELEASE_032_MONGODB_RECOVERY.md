# Khata ERP — Release #032 MongoDB Recovery & Supervision Specification

## 1. Overview & Architectural Role

In Khata ERP, MongoDB Atlas serves as the mandatory high-performance read-model store, search projection engine, and application metadata repository. PostgreSQL serves as the authoritative source of truth for all transactional, financial, and double-entry accounting records.

MongoDB is strictly mandatory. When MongoDB experiences transient disconnects or network partitioning, the backend fails closed for all read-model dependent endpoints (returning HTTP 503 `MANDATORY_SERVICE_UNAVAILABLE` or `READ_MODEL_UNAVAILABLE`) rather than routing unpredictable table-scanning queries to PostgreSQL.

The `MongoConnectionSupervisor` manages the full lifecycle of MongoDB connectivity, index verification, background outbox worker coordination, and automated self-healing recovery.

---

## 2. Supervisor Architecture & Self-Healing Reconnection Loop

### Reconnection State Machine

```
              +--------------------------+
              |       INITIALIZING       |
              +--------------------------+
                           |
                           v
              +--------------------------+
              |        CONNECTING        | <----------+
              +--------------------------+            |
                |                      |              |
     Success    |                      | Failure      |
                v                      v              |
   +----------------------+   +------------------+    |
   |      CONNECTED       |   |   DISCONNECTED   |    |
   +----------------------+   +------------------+    |
                |                      |              |
                v                      v              |
   +----------------------+   +------------------+    |
   |   ENSURING INDEXES   |   | SCHEDULE RETRY   | ---+
   +----------------------+   +------------------+
                |
     Success    |
                v
   +----------------------+
   |        READY         | ---> (Socket error / heartbeat drop)
   +----------------------+                 |
                |                           v
                |                 +-------------------+
                +---------------> | MARK UNAVAILABLE  |
                                  +-------------------+
                                            |
                                            v
                                  +-------------------+
                                  | NOTIFY LISTENERS  | ---> Triggers Reconnect
                                  +-------------------+
```

### Exponential Backoff with Uniform Jitter

When a connection attempt fails, the supervisor schedules a retry using bounded exponential backoff with full jitter to eliminate thundering herd spikes against MongoDB Atlas clusters:

$$\text{delay} = \min\left(\text{maxDelayMs}, \text{round}\left(\min\left(\text{maxDelayMs}, \text{baseDelayMs} \times 2^{\text{attempt}-1}\right) \times (0.8 + 0.4 \times \text{random}())\right)\right)$$

Defaults:
- `baseDelayMs`: 1,000 ms (1 second)
- `maxDelayMs`: 60,000 ms (60 seconds)

### Promise Lifecycle & Deadlock Prevention

In Release 032, the active reconnection promise (`activeReconnectPromise`) is cleared inside the `finally` block of `performConnectionAttempt()` *prior* to evaluating whether another reconnection should be scheduled:

```typescript
try {
  await attemptPromise;
} finally {
  if (this.activeReconnectPromise === attemptPromise) {
    this.activeReconnectPromise = null;
  }

  // Schedule retry strictly AFTER clearing active promise
  if (!this.stopped && isMongoEnabled() && !isMongoReady() && !this.reconnectTimer) {
    this.scheduleReconnect();
  }
}
```

This prevents the deadlock condition where early promise checks blocked repeated retries after socket reconnect failures.

---

## 3. Unready Listener Registry

To guarantee immediate reaction to degraded sockets, socket drops, or failed readiness pings, `mongodb.ts` provides a pub/sub listener registry:

- `registerMongoUnreadyListener(listener: (err?: Error) => void): () => void`
- `markMongoUnavailable(error?: Error): void`

When `markMongoUnavailable` is called:
1. `mongoConnectionReady` and `mongoInitializationReady` are immediately set to `false`.
2. `mongoAvailabilityState` transitions to `'disconnected'`.
3. All registered listeners (including `MongoConnectionSupervisor` and `readModelOutboxWorker`) are notified synchronously.
4. Outbox workers pause batch drains immediately to avoid applying operations to dropped sockets.
5. `MongoConnectionSupervisor` immediately schedules a reconnection attempt.

---

## 4. Health Probe Verification & Error Sanitization

The `/api/v1/health/ready` probe verifies both PostgreSQL and MongoDB readiness:

```typescript
const mongoReadiness = await checkMongoReadiness();
```

- **Ping Mechanism:** `checkMongoReadiness()` executes an explicit lightweight `admin().ping()`.
- **Sanitized Diagnostics:** If the ping fails, the error message is recorded without exposing sensitive connection URIs, user credentials, cluster topology, or replica set internals.
- **Fail-Closed Reporting:** Returns HTTP 503 `status: "unready"` with minimal service state strings.
