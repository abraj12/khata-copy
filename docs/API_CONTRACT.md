# Khata - Canonical API Contract

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Base Path:** `/api/v1`  
**Protocol:** HTTPS with credentials (`include` mode)  

---

## 1. Global Request & Response Conventions

### 1.1 Canonical Response Envelopes

All API endpoints return JSON conforming to standard canonical envelopes:

#### Success Response Envelope
```json
{
  "success": true,
  "data": { ... } // or array [ ... ]
}
```

#### Error Response Envelope
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Specific error description",
    "details": null
  }
}
```

### 1.2 Financial Serialization Rule
> [!IMPORTANT]
> All monetary values (`amount`, `total_amount`, `remaining_amount`, `default_price`, `unit_price`, `balance`) are formatted as strict **2-decimal-place strings** (e.g., `"1250.00"`, `"45.50"`), never floating-point numbers. Quantities are also formatted as numeric strings.

### 1.3 Security Headers & Idempotency
- **CSRF Token:** All mutating requests (`POST`, `PUT`, `DELETE`, `PATCH`) must include the `X-CSRF-Token` header matching the `csrf-token` cookie.
- **Idempotency Key:** Clients generating credit or payment transactions should supply an `Idempotency-Key: <UUIDv4>` header to protect against network retry duplication.

---

## 2. Health & Diagnostic Endpoints

### 2.1 Liveness Probe
- **Method & Route:** `GET /api/v1/health/live`
- **Authentication:** Public
- **Response (200 OK):**
```json
{
  "status": "live",
  "timestamp": "2026-11-01T04:00:00.000Z"
}
```

### 2.2 Deep Readiness Probe
- **Method & Route:** `GET /api/v1/health/ready`
- **Authentication:** Public
- **Checks Performed:** PostgreSQL connectivity, `schema_migrations` table existence, migration files verified (`001` through `005`), 9 core tables verified. In production, database credentials, server traces, and raw connection strings are strictly masked.
- **Response (200 OK):**
```json
{
  "status": "ready",
  "database": {
    "isReady": true,
    "latencyMs": 105,
    "checks": {
      "connection": true,
      "schemaMigrationsTable": true,
      "migrationsApplied": {
        "expected": [
          "001_auth_tables.sql",
          "002_khata_transactions.sql",
          "003_idempotency_and_hardening.sql",
          "004_integer_quantity_and_money_constraints.sql",
          "005_search_indexes_and_identity_constraints.sql",
          "006_quantity_two_decimal_places.sql"
        ],
        "found": [
          "001_auth_tables.sql",
          "002_khata_transactions.sql",
          "003_idempotency_and_hardening.sql",
          "004_integer_quantity_and_money_constraints.sql",
          "005_search_indexes_and_identity_constraints.sql",
          "006_quantity_two_decimal_places.sql"
        ],
        "missing": []
      },
      "coreTables": {
        "expected": [
          "session",
          "login_attempts",
          "products",
          "customers",
          "udhar_transactions",
          "udhar_items",
          "payments",
          "payment_allocations",
          "idempotency_keys"
        ],
        "found": [
          "session",
          "login_attempts",
          "products",
          "customers",
          "udhar_transactions",
          "udhar_items",
          "payments",
          "payment_allocations",
          "idempotency_keys"
        ],
        "missing": []
      }
    }
  },
  "timestamp": "2026-11-01T04:00:00.000Z"
}
```

---

## 3. Authentication Endpoints

### 3.1 Owner Login
- **Method & Route:** `POST /api/v1/auth/login`
- **Headers:** `Content-Type: application/json`, `X-CSRF-Token: <token>`
- **Request Body:**
```json
{
  "username": "owner",
  "password": "SecretPassword123!"
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "username": "owner",
    "role": "OWNER"
  }
}
```
- **Cookies Set:**
  - `sid`: Host-only, HTTP-only, Secure, SameSite=Lax.
  - `csrf-token`: Host-only, Secure, SameSite=Lax.

### 3.2 Owner Logout
- **Method & Route:** `POST /api/v1/auth/logout`
- **Authentication:** Session cookie required
- **Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully"
  }
}
```

### 3.3 Current Session Check
- **Method & Route:** `GET /api/v1/auth/me`
- **Authentication:** Session cookie required
- **Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "username": "owner",
    "authenticated": true
  }
}
```

---

## 4. Products Module Endpoints

### 4.1 List Products (Searchable & Bounded Pagination)
- **Method & Route:** `GET /api/v1/products`
- **Query Params:**
  - `search` (optional string): Case-insensitive partial name match with wildcard escaping (`%`, `_`).
  - `limit` (optional integer): Page size, default `25`, maximum `50`.
  - `offset` (optional integer): Pagination offset, default `0`.
- **Response (200 OK):**
```json
{
  "success": true,
  "products": [
    {
      "id": 1,
      "name": "Fevicol SH 1kg",
      "buying_price": "400.00",
      "created_at": "2026-11-01T00:00:00.000Z",
      "updated_at": "2026-11-01T00:00:00.000Z",
      "archived_at": null
    }
  ],
  "pagination": {
    "limit": 25,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null
  },
  "data": [
    {
      "id": 1,
      "name": "Fevicol SH 1kg",
      "buying_price": "400.00"
    }
  ]
}
```

### 4.2 Create Product
- **Method & Route:** `POST /api/v1/products`
- **Request Body:**
```json
{
  "name": "Fevicol SH 1kg",
  "buying_price": 400.00
}
```
- **Validation:** Buying price must be non-negative with $\le 2$ decimal places. Rejects exponential notation.
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Fevicol SH 1kg",
    "buying_price": "400.00"
  }
}
```

### 4.3 Update Product
- **Method & Route:** `PATCH /api/v1/products/:id`
- **Request Body:** Fields to update (`name`, `buying_price`).
- **Response (200 OK):** Updated product object.

### 4.4 Archive Product
- **Method & Route:** `DELETE /api/v1/products/:id`
- **Response (200 OK):** `{ "success": true, "message": "Product archived." }`

---

## 5. Khata Module Endpoints

### 5.1 List Customers (Searchable & Bounded Pagination)
- **Method & Route:** `GET /api/v1/khata/customers`
- **Query Params:**
  - `search` (optional string): Matches normalized name or phone digits.
  - `limit` (optional integer): Page size, default `25`, maximum `50`.
  - `offset` (optional integer): Pagination offset, default `0`.
- **Response (200 OK):**
```json
{
  "success": true,
  "customers": [
    {
      "id": 5,
      "name": "Ramesh Patel",
      "phone": "9876543210",
      "totalUdhar": "3400.00",
      "totalReceived": "1500.00",
      "outstanding": "1900.00",
      "created_at": "2026-11-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 25,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null
  },
  "data": [ ... ]
}
```

### 5.2 Global Ledger Summary
- **Method & Route:** `GET /api/v1/khata/summary`
- **Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "totalCustomers": 12,
    "totalOutstanding": "22000.00",
    "totalReceived": "32000.00"
  }
}
```

### 5.3 Customer Ledger Detail & History
- **Method & Route:** `GET /api/v1/khata/customers/:customerId/history`
- **Response (200 OK):** Customer details, transactions array with snapshots, payments array with allocations.

---

## 6. Khata Transactions & Payment Allocation

### 6.1 Create Udhar Transaction (Atomic Multi-Line)
- **Method & Route:** `POST /api/v1/khata/transactions`
- **Headers:** `Idempotency-Key: <key>`
- **Request Body:**
```json
{
  "customer": {
    "id": 5,
    "name": "Ramesh Patel",
    "phone": "9876543210"
  },
  "items": [
    {
      "productId": 1,
      "quantity": 3,
      "sellingPrice": 550.00
    },
    {
      "productId": 2,
      "quantity": 5,
      "sellingPrice": 350.00
    }
  ],
  "initialPayment": 1000.00,
  "note": "Hardware construction materials",
  "idempotencyKey": "tx_uuid..."
}
```
- **Validation Rules:**
  - `customer.phone`: Optional Indian mobile format (10 digits starting with 6-9, optional `+91` prefix, dashes, spaces). Invalid non-empty phone rejected with HTTP 400 (`INVALID_PHONE_FORMAT`).
  - `customer resolution`: If customer ID is not provided, matching proceeds via normalized phone, then single exact normalized name with safe phone attachment under `FOR UPDATE` row lock. Ambiguous name matches or phone collisions reject with HTTP 409 (`AMBIGUOUS_CUSTOMER_MATCH` or `CUSTOMER_NAME_CONFLICT`).
  - `quantity`: Strict positive numeric $(0, 1000000.00]$ accepting up to 2 decimal places (e.g. `1`, `1.5`, `2.25`, `0.01`). Rejects $>2$ decimal places (`1.234`), zero, negative values, and exponents. Stored canonically as `NUMERIC(12, 2)`.
  - `sellingPrice`: Strict decimal $\ge 0$ with $\le 2$ decimal places. Never auto-populated from buying price.
  - `initialPayment`: Optional non-negative decimal not exceeding transaction total.
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "transactionId": 14,
    "customerId": 5,
    "totalAmount": "3400.00",
    "initialPayment": "1000.00",
    "outstanding": "2400.00"
  }
}
```

### 6.2 Record Customer Payment (FIFO Allocation)
- **Method & Route:** `POST /api/v1/khata/customers/:customerId/payments`
- **Headers:** `Idempotency-Key: <key>`
- **Request Body:**
```json
{
  "amount": 500.00,
  "note": "Cash partial payment",
  "idempotencyKey": "pay_uuid..."
}
```
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "paymentId": 8,
    "amount": "500.00",
    "allocations": [
      {
        "transactionId": 14,
        "amount": "500.00"
      }
    ]
  }
}
```

### 6.3 Customer Transaction History
- **Method & Route:** `GET /api/v1/khata/customers/:customerId/history`
- **Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "customer": {
      "id": "cst_01hxyz...",
      "name": "Ramesh Kumar",
      "balance": "0.00"
    },
    "transactions": [
      {
        "type": "PAYMENT",
        "id": "pay_01hxyz...",
        "date": "2026-11-01T04:15:00.000Z",
        "amount": "415.50",
        "paymentMode": "UPI"
      },
      {
        "type": "UDHAR",
        "id": "udh_01hxyz...",
        "date": "2026-11-01",
        "totalAmount": "415.50",
        "remainingAmount": "0.00",
        "status": "PAID",
        "items": [ ... ]
      }
    ]
  }
}
```
