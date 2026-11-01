# Khata - System Architecture & Data Flow

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Target Audience:** Software Engineers, DevOps, System Architects  

---

## 1. High-Level Architecture Overview

Khata follows a decoupled client-server architecture designed for high availability, zero floating-point arithmetic corruption, and secure cross-platform execution (Web and Android).

```mermaid
flowchart TD
    subgraph Clients["Client Layer"]
        PWA["Web Browser (PWA)\nhttps://khata.algions.in"]
        APK["Android Native Shell (Capacitor)\nin.algions.khata"]
    end

    subgraph Hosting["Edge / Cloud Infrastructure"]
        Vercel["Vercel CDN / Edge\nStatic Assets, SPA Routing, CSP"]
        Render["Render Web Service\nNode 22 / Express Backend\nhttps://khata-api-wkn9.onrender.com"]
    end

    subgraph Database["PostgreSQL Layer (Neon Serverless)"]
        Pooler["Neon PgBouncer Connection Pooler\n(Runtime Queries, Port 5432)"]
        Direct["Neon Direct PostgreSQL Endpoint\n(DDL Migrations, Port 5432)"]
        DB[(PostgreSQL 16 DB\n9 Relational Tables)]
    end

    PWA -->|HTTPS / W3C Fetch| Vercel
    PWA -->|REST API with Credentials| Render
    APK -->|Local Assets file://| APK
    APK -->|REST API with Credentials| Render

    Render -->|Pooled TCP / SSL| Pooler
    Render -->|Direct DDL Migrations| Direct
    Pooler --> DB
    Direct --> DB
```

---

## 2. Technology Stack

| Layer | Technologies & Rationale |
|---|---|
| **Frontend Web** | React 19, TypeScript 5, Vite 6, Tailwind CSS 3, Lucide React.<br>Bundled locally with `@fontsource/montserrat` for 100% offline rendering.<br>Custom `SearchablePicker` with debounced server-side search (`useRemoteSearch`), responsive bottom-sheet for mobile, and bounded pagination. |
| **Mobile Runtime** | Capacitor 7 Android platform shell. Embeds frontend build into native Android Webview with local asset caching. |
| **Backend API** | Node.js 22 LTS, Express 4, TypeScript 5, `tsx` runner, `pg` (PostgreSQL client).<br>Monorepo structure managed with native npm workspaces. |
| **Financial Engine** | `decimal.js` for arbitrary-precision decimal arithmetic (financial rounding half-up, strict 2-decimal-place strings). |
| **Database** | PostgreSQL 16 on Neon Serverless. Enforces foreign key constraints, check constraints, unique indexes, and ACID transactions. |
| **Security & Auth** | Argon2id for password hashing, host-only `httpOnly` secure session cookies, double-submit CSRF cookie protection, `express-rate-limit`. |

---

## 3. Core Data Flow & Transaction Sequences

### 3.1 Owner Authentication Flow

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Shopkeeper
    participant Client as Frontend (React)
    participant Server as Backend (Express)
    participant DB as Neon PostgreSQL

    Owner->>Client: Enters Username & Password
    Client->>Server: POST /api/v1/auth/login { username, password }
    Server->>DB: Check lockout attempts in `login_attempts`
    alt Account is Locked
        Server-->>Client: 429 Too Many Requests (Lockout active)
    else Account is Active
        Server->>Server: Argon2id verify against configured OWNER_PASSWORD_HASH
        alt Credentials Invalid
            Server->>DB: Insert failed attempt in `login_attempts`
            Server-->>Client: 401 Unauthorized
        else Credentials Valid
            Server->>DB: Create session in `session` table
            Server->>DB: Clear failed attempts in `login_attempts`
            Server-->>Client: 200 OK + Set-Cookie: sid (httpOnly) + Set-Cookie: csrf-token
        end
    end
```

### 3.2 Payment Settlement Flow (FIFO Allocation)

```mermaid
sequenceDiagram
    autonumber
    actor Owner as Shopkeeper
    participant Client as Frontend (React)
    participant Server as Backend (Express)
    participant DB as Neon PostgreSQL

    Owner->>Client: Submit Payment ₹1,500.00
    Client->>Server: POST /api/v1/khata/payments { customerId, amount, paymentMode }
    Note over Server,DB: Begin ACID Transaction (BEGIN)
    Server->>DB: Check customer exists & lock customer balance check
    Server->>DB: SELECT id, total_amount, remaining_amount FROM udhar_transactions<br/>WHERE customer_id = $1 AND remaining_amount > 0<br/>ORDER BY transaction_date ASC, created_at ASC, id ASC<br/>FOR UPDATE
    Note over Server: Calculate FIFO Allocation via Decimal.js
    loop For each unpaid Udhar transaction
        Server->>DB: UPDATE udhar_transactions SET remaining_amount = $1, status = $2 WHERE id = $3
        Server->>DB: INSERT INTO payment_allocations (payment_id, udhar_transaction_id, amount_allocated)
    end
    Server->>DB: INSERT INTO payments (customer_id, amount, payment_mode, notes)
    Note over Server,DB: Commit ACID Transaction (COMMIT)
    Server-->>Client: 201 Created { success: true, data: { payment, allocations } }
```

---

## 4. Repository Structure & Workspace Layout

The repository is structured as an npm workspaces monorepo:

```text
khata/
├── backend/                  # Express REST API workspace
│   ├── scripts/              # Migration runner (scripts/migrate.ts)
│   ├── src/
│   │   ├── config/           # Database pool, env parser, testDbGuard
│   │   ├── middleware/       # Auth guards, CSRF, rate-limit, error handler
│   │   ├── migrations/       # SQL migration files (001, 002, 003)
│   │   ├── modules/
│   │   │   ├── auth/         # Login, logout, session verification
│   │   │   ├── customers/    # Customer directory & balances
│   │   │   ├── khata/        # Udhar recording, FIFO payments, ledger statements
│   │   │   └── products/     # Product catalog CRUD
│   │   └── app.ts            # Express application bootstrap
│   └── tests/                # Vitest test suite (financial, auth, testDbGuard)
├── frontend/                 # Vite + React workspace
│   ├── android/              # Capacitor native Android shell
│   ├── public/               # Static assets & icons
│   └── src/
│       ├── components/       # Layout, Navbar, AccessibilityBar, Modal
│       ├── context/          # ThemeContext (9 Neumorphic presets)
│       ├── features/         # KhataLedgerView, ProductsView, CustomersView, LoginView
│       ├── services/         # Typed API clients with AbortController
│       └── index.css         # Custom Neumorphic CSS variables & accessibility scaling
├── docs/                     # Canonical project documentation
│   └── archive/              # Superseded historical audit records and prompts
├── package.json              # Monorepo root package.json with workspace scripts
└── package-lock.json         # Committed deterministic npm lockfile
```

---

## 5. Security & Isolation Boundaries

1. **Host-Only Sessions:** Session cookies omit `Domain` attribute to prevent subdomain leakage across unrelated services on `algions.in`.
2. **Strict CORS Policy:** Production backend origin reflects only the configured frontend domain (`https://khata.algions.in`), rejecting unauthorized cross-origin calls.
3. **Double-Submit CSRF:** Mutating requests (`POST`, `PUT`, `DELETE`) require `X-CSRF-Token` header matching the signed CSRF cookie.
4. **Destructive Test Guard:** `backend/src/config/testDbGuard.ts` strictly prevents test suites from executing against production Neon hostnames or unapproved cloud databases.
