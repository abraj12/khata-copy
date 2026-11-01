# Khata — System Architecture & Data Flow

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Target Audience:** Software Engineers, DevOps, System Architects  

---

## 1. High-Level Architecture Overview

Khata follows a decoupled client-server architecture designed for high availability, zero floating-point arithmetic corruption, and seamless cross-platform execution across Web and Android.

The Android app and the website are two interfaces for the **same shopkeeper and the same account**. Both interfaces communicate with the same backend API and PostgreSQL database.

```mermaid
flowchart TD
    subgraph Clients["Client Layer"]
        PWA["Web Browser (PWA)\nhttps://khata.algions.in\n(Vercel CDN Edge)"]
        TWA["Android TWA Shell\nin.algions.khata\n(androidbrowserhelper)"]
    end

    subgraph Hosting["Edge / Cloud Infrastructure"]
        Vercel["Vercel CDN / Edge\nStatic Assets, SPA Routing, sw.js, manifest.json"]
        Render["Render Web Service\nNode 22 / Express Backend\nhttps://api-khata.algions.in"]
    end

    subgraph Database["PostgreSQL Layer (Neon Serverless)"]
        Pooler["Neon PgBouncer Connection Pooler\n(Runtime Queries, Port 5432)"]
        Direct["Neon Direct PostgreSQL Endpoint\n(DDL Migrations, Port 5432)"]
        DB[(PostgreSQL 16 DB\n9 Relational Tables)]
    end

    TWA -->|Opens Live Remote URL| Vercel
    PWA -->|HTTPS / W3C Fetch| Vercel
    Vercel -->|REST API with Credentials| Render

    Render -->|Pooled TCP / SSL| Pooler
    Render -->|Direct DDL Migrations| Direct
    Pooler --> DB
    Direct --> DB
```

---

## 2. Technology Stack

| Layer | Technologies & Rationale |
|---|---|
| **Frontend Web** | React 19, TypeScript 5, Vite 6, Tailwind CSS 3, Lucide React.<br>Progressive Web App (PWA) with Network-First Service Worker (`sw.js`).<br>Custom `SearchablePicker` with debounced search, monotonic request IDs, and focus trap.<br>Self-hosted `@fontsource/montserrat` for 100% offline typography. |
| **Android Shell** | Trusted Web Activity (TWA) via `androidbrowserhelper:2.5.0` and `androidx.browser:1.8.0`.<br>Package ID: `in.algions.khata`. Renders live remote site `https://khata.algions.in` in full screen with no browser URL bar. |
| **Backend API** | Node.js 22 LTS, Express 4, TypeScript 5, `pg` (PostgreSQL client).<br>Monorepo structure managed with native npm workspaces. |
| **Financial Engine** | `decimal.js` for arbitrary-precision decimal arithmetic (financial rounding half-up, strict 2-decimal-place scale for money and fractional quantities up to 2 decimal places). |
| **Database** | PostgreSQL 16 on Neon Serverless. Enforces foreign key constraints, unconstrained `NUMERIC` with `TRUNC` scale checks, composite payment allocation foreign keys, unique indexes, and ACID transactions. |
| **Security & Auth** | Argon2id for password hashing, host-only `httpOnly` secure session cookies, double-submit CSRF cookie protection, `express-rate-limit`. |

---

## 3. Financial Transaction & Payment Allocation Flow

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Shopkeeper
    participant Client as Frontend (Web/TWA)
    participant Server as Backend (Express)
    participant DB as Neon PostgreSQL

    Owner->>Client: Submit Payment ₹1,500.00
    Client->>Server: POST /api/v1/khata/customers/:customerId/payments { amount: "1500.00", idempotencyKey }
    Note over Server,DB: Begin ACID Transaction (BEGIN)
    Server->>DB: Lock customer row FOR UPDATE
    Server->>DB: Check total outstanding balance
    alt Payment exceeds total due
        Server-->>Client: 400 PAYMENT_EXCEEDS_BALANCE
    else Valid payment
        Server->>DB: INSERT INTO payments (customer_id, amount) RETURNING id
        Server->>DB: SELECT oldest unpaid udhar_transactions FOR UPDATE (FIFO)
        loop For each outstanding transaction
            Server->>DB: INSERT INTO payment_allocations (payment_id, transaction_id, customer_id, amount)
        end
        Server->>DB: INSERT INTO idempotency_keys
        Server->>DB: COMMIT
        Server-->>Client: 201 Created { paymentId, newOutstanding, allocations }
    end
```

---

## 4. Service Worker & Caching Strategy

The Progressive Web App service worker (`frontend/public/sw.js`) guarantees that:
1. **HTML Documents & Navigation:** Always use **Network-First** with cache fallback. Any new deployment to Vercel is immediately fetched on reload or app open.
2. **Versioned Static Assets:** Immutable bundles (`/assets/*.[hash].js|css`) use **Cache-First** for instant performance.
3. **API Requests (`/api/*`):** **STRICTLY EXCLUDED** from Service Worker caching. Financial data, customer ledger entries, authentication sessions, and CSRF tokens are never written to client cache storage.
