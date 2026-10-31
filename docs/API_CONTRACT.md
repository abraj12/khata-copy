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
- **Checks Performed:** PostgreSQL connectivity, `schema_migrations` table existence, migration files verified (`001`, `002`, `003`), 9 core tables verified.
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
        "expected": ["001_auth_tables.sql", "002_khata_transactions.sql", "003_idempotency_and_hardening.sql"],
        "found": ["001_auth_tables.sql", "002_khata_transactions.sql", "003_idempotency_and_hardening.sql"],
        "missing": []
      },
      "coreTables": {
        "expected": ["session", "login_attempts", "products", "customers", "udhar_transactions", "udhar_items", "payments", "payment_allocations", "idempotency_keys"],
        "found": ["session", "login_attempts", "products", "customers", "udhar_transactions", "udhar_items", "payments", "payment_allocations", "idempotency_keys"],
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

### 4.1 List Products
- **Method & Route:** `GET /api/v1/products`
- **Query Params:** `search` (optional string)
- **Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "prd_01hxyz...",
      "name": "Basmati Rice 1kg",
      "unit": "kg",
      "default_price": "120.00",
      "is_active": true,
      "created_at": "2026-11-01T00:00:00.000Z"
    }
  ]
}
```

### 4.2 Create Product
- **Method & Route:** `POST /api/v1/products`
- **Request Body:**
```json
{
  "name": "Toor Dal 1kg",
  "unit": "kg",
  "default_price": 160.00
}
```
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "prd_01hxyz...",
    "name": "Toor Dal 1kg",
    "unit": "kg",
    "default_price": "160.00",
    "is_active": true
  }
}
```

### 4.3 Update Product
- **Method & Route:** `PUT /api/v1/products/:id`
- **Request Body:** Fields to update (`name`, `unit`, `default_price`).
- **Response (200 OK):** Updated product object.

### 4.4 Soft-Delete Product
- **Method & Route:** `DELETE /api/v1/products/:id`
- **Response (200 OK):** `{ "success": true, "data": { "id": "...", "is_active": false } }`

---

## 5. Customers Module Endpoints

### 5.1 List Customers
- **Method & Route:** `GET /api/v1/customers`
- **Query Params:** `search` (optional)
- **Response (200 OK):**
```json
{
  "success": true,
  "data": [
    {
      "id": "cst_01hxyz...",
      "name": "Ramesh Kumar",
      "phone": "9876543210",
      "address": "Shop #4, Main Market",
      "balance": "3450.00",
      "created_at": "2026-10-31T12:00:00.000Z"
    }
  ]
}
```

### 5.2 Create Customer
- **Method & Route:** `POST /api/v1/customers`
- **Request Body:**
```json
{
  "name": "Suresh Sharma",
  "phone": "9811223344",
  "address": "House 12, Civil Lines",
  "notes": "Regular dairy customer"
}
```
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "cst_01hxyz...",
    "name": "Suresh Sharma",
    "phone": "9811223344",
    "balance": "0.00"
  }
}
```

---

## 6. Khata Ledger Endpoints

### 6.1 Create Udhar (Credit Sale)
- **Method & Route:** `POST /api/v1/khata/udhar`
- **Headers:** `Idempotency-Key` (recommended)
- **Request Body:**
```json
{
  "customerId": "cst_01hxyz...",
  "transactionDate": "2026-11-01",
  "notes": "Weekly ration items",
  "items": [
    {
      "productId": "prd_01hxyz...",
      "itemName": "Basmati Rice 1kg",
      "quantity": 2,
      "unitPrice": 120.00
    },
    {
      "itemName": "Mustard Oil 1L",
      "quantity": 1,
      "unitPrice": 175.50
    }
  ]
}
```
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": "udh_01hxyz...",
    "customerId": "cst_01hxyz...",
    "transactionDate": "2026-11-01",
    "totalAmount": "415.50",
    "remainingAmount": "415.50",
    "status": "UNPAID",
    "items": [
      {
        "id": "itm_01...",
        "itemName": "Basmati Rice 1kg",
        "quantity": "2",
        "unitPrice": "120.00",
        "subtotal": "240.00"
      },
      {
        "id": "itm_02...",
        "itemName": "Mustard Oil 1L",
        "quantity": "1",
        "unitPrice": "175.50",
        "subtotal": "175.50"
      }
    ]
  }
}
```

### 6.2 Settle Payment (Record Payment with FIFO Allocation)
- **Method & Route:** `POST /api/v1/khata/payments`
- **Headers:** `Idempotency-Key` (recommended)
- **Request Body:**
```json
{
  "customerId": "cst_01hxyz...",
  "amount": 415.50,
  "paymentMode": "UPI",
  "notes": "Paid via GooglePay",
  "referenceNumber": "UPI/20261101/9981"
}
```
- **Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "pay_01hxyz...",
      "customerId": "cst_01hxyz...",
      "amount": "415.50",
      "paymentMode": "UPI",
      "paymentDate": "2026-11-01T04:15:00.000Z"
    },
    "allocations": [
      {
        "udharTransactionId": "udh_01hxyz...",
        "amountAllocated": "415.50",
        "remainingAmountAfter": "0.00",
        "statusAfter": "PAID"
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
