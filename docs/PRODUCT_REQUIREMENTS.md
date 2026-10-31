# Khata - Product Requirements Document (PRD)

**Document Status:** Canonical & Implemented  
**Last Verified:** 2026-11-01  
**Target Audience:** Engineering, Product, Operations  

---

## 1. Product Overview & Core Scope

Khata is a streamlined, resilient digital ledger (*khata*) application engineered specifically for a single retail shopkeeper. The system replaces traditional paper ledger books (*bahi-khata*) with a secure, offline-capable progressive web application and Android APK.

### Core Value Proposition
- Instant recording of credit transactions (*udhar*) with itemized product breakdowns.
- Transparent debt tracking per customer with guaranteed FIFO (*First-In, First-Out*) payment settlement.
- Zero arithmetic rounding drift using exact 2-decimal-place financial math.
- Complete operational autonomy on mobile and desktop devices.

---

## 2. User Roles & Identity

### 2.1 Single Shopkeeper (Owner)
- The application is single-tenant by design.
- Access is strictly governed by owner credentials configured in the secure backend environment (`OWNER_USERNAME` / `OWNER_PASSWORD_HASH`).
- Session is maintained via host-only, HTTP-only, secure cookies with double-submit CSRF protection.
- Brute-force attacks are mitigated through IP and User-Agent rate limiting, exponential lockout penalties, and secure attempt pruning.

### 2.2 Customers
- Customers are counter-parties managed exclusively by the shopkeeper.
- Customers do not have accounts, credentials, or login capabilities.

---

## 3. Functional Requirements

### 3.1 Products Catalog Module
The products catalog acts as a rapid-entry lookup system for goods frequently sold on credit.

| Feature | Requirement | Validation & Business Rules |
|---|---|---|
| **Product Listing** | Display all active products with name, unit, and default unit price. | Searchable by name/keyword in real-time. |
| **Product Creation** | Add a new product with `name`, `unit` (e.g., kg, pcs, pkt, ltr), and `default_price`. | Name must be non-empty string ($\le 100$ chars); price must be numeric $> 0$. |
| **Product Modification** | Update existing product details (`name`, `unit`, `default_price`). | Historical udhar transactions retain their original captured prices. |
| **Product Deactivation** | Soft-delete product (`is_active = FALSE`). | Hard deletes are prohibited to preserve historical transaction integrity. |

### 3.2 Customers Module
The customers directory tracks individual balances and counter-party contact information.

| Feature | Requirement | Validation & Business Rules |
|---|---|---|
| **Customer Listing** | Display all customers, showing total outstanding balance, phone, and last activity. | Searchable by full or partial name and 10-digit mobile number. |
| **Customer Creation** | Add customer with `name`, `phone` (10 digits), optional `address`, and `notes`. | Phone must match standard Indian mobile format (10 numeric digits). |
| **Customer Editing** | Edit customer name, phone, address, and notes. | Phone uniqueness and format enforced. |
| **Customer Balance** | Dynamically computed balance representing the sum of all unpaid `remaining_amount` fields. | Balance is strictly derived from verified transaction records. |

### 3.3 Khata Ledger & Transaction Workflows

#### A. Record Credit Transaction (Add Udhar)
1. Shopkeeper selects an existing customer.
2. Shopkeeper adds one or more line items (either selected from the product catalog or entered as a custom line item).
3. Each line item specifies: `product_id` (optional for custom items), `item_name`, `quantity` ($> 0$), `unit_price` ($> 0$).
4. Line subtotal is computed as: $\text{Subtotal} = \text{round}(\text{quantity} \times \text{unit\_price}, 2)$.
5. Total transaction amount is the exact sum of line subtotals.
6. An atomic PostgreSQL transaction creates:
   - One record in `udhar_transactions` with `total_amount`, `remaining_amount = total_amount`, `transaction_date`, `status = 'UNPAID'`.
   - Associated records in `udhar_items` linking each line item to the transaction.

#### B. Settle Payment (Record Payment)
1. Shopkeeper selects customer and enters payment `amount`, `payment_mode` (`CASH`, `UPI`, `BANK_TRANSFER`, `CHEQUE`), and optional `notes` or `reference_number`.
2. **Strict Validation Rules:**
   - Amount must be strictly positive: $\text{amount} > 0.00$.
   - Amount cannot exceed the customer's total outstanding udhar balance ($\sum \text{remaining\_amount}$). Overpayments are prohibited.
3. **FIFO Allocation Logic:**
   - Active unpaid transactions (`remaining_amount > 0`) are queried ordered by `transaction_date ASC, created_at ASC, id ASC` with non-aggregated row locks (`FOR UPDATE`).
   - The payment is allocated sequentially to the oldest unpaid debts until the payment amount is exhausted.
   - For each allocated transaction:
     - `remaining_amount` is reduced by the allocated amount.
     - `status` updates to `PAID` if `remaining_amount == 0.00`, or `PARTIAL` if $0 < \text{remaining\_amount} < \text{total\_amount}$.
     - A row is written to `payment_allocations` recording the exact debt reduction.
   - A row is written to `payments` recording the full payment received.
   - All steps execute inside a single atomic database transaction.

#### C. Transaction History & Ledger Statement
- Displays unified chronological audit trail of all Udhar transactions and Payments for a selected customer.
- Each Udhar card shows date, items summary, original total, remaining balance, and status badge (`PAID`, `PARTIAL`, `UNPAID`).
- Each Payment card shows date, payment mode, amount received, and reference details.
- **Statement & Print:** Generates a clean, print-optimized account summary displaying transaction history, payments, and net outstanding balance for counter-party verification.

---

## 4. Explicit Non-Goals & Out-of-Scope Items

To ensure extreme reliability, security, and low operational overhead, the following features are explicitly out of scope:
- **No Inventory Stock Counts:** Khata does not decrement inventory quantities on sale. It is a financial ledger, not a warehouse management system.
- **No Customer-Facing App or Portal:** Customers cannot log in or submit payments online.
- **No Multi-Tenant or Multi-Store Partitioning:** The application is dedicated to one single shopkeeper instance.
- **No Double-Entry General Ledger or Tax Invoicing:** No GST return filing, depreciation schedules, or complex corporate accounting modules.
