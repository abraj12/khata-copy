# Cloudflare R2 Object Storage Setup Guide

**Application:** Khata (ALGIONS)  
**Production Website:** `https://khata.algions.in`  
**Production API:** `https://api-khata.algions.in`  
**Features Enabled:**
1. **Product Images:** Optional primary photograph for catalog items.
2. **Offline Bills:** Photographic storage for physical customer bills (document storage only, zero financial/ledger impact).

---

## 1. Overview & Architecture

Khata uses **Cloudflare R2** (S3-compatible, private bucket, zero egress fees) for all binary image storage:
- **Private Bucket:** Direct public access is disabled; all uploads and views use server-generated, short-lived **presigned URLs** (HMAC-SHA256 signed).
- **Direct Browser Uploads:** Files upload directly from the browser/TWA app to Cloudflare R2 via HTTP `PUT` presigned URLs, bypassing Render backend memory and bandwidth constraints.
- **Magic Bytes Validation:** When finalizing an upload, the backend downloads the first 16 bytes directly from R2 to verify genuine JPEG, PNG, or WebP file signatures before attaching records. Spoofed executables or malicious files are deleted immediately.
- **Graceful Fallback:** If R2 environment variables are not configured, Khata operates normally without images. Image upload endpoints return HTTP 503 `STORAGE_NOT_CONFIGURED` without crashing.

---

## 2. Step-by-Step Setup Instructions

### Step 1: Log in to Cloudflare & Enable R2
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. In the left navigation sidebar, select **R2 Object Storage**.
3. If this is your first time using R2, click **Enable R2** (Cloudflare provides 10 GB/month of storage and zero egress fees at no cost).

---

### Step 2: Create the R2 Bucket
1. On the R2 Overview page, click **Create bucket**.
2. **Bucket Name:** Enter `khata-documents` (or your preferred name).
3. **Location:** Select **Automatic** (or closest region).
4. Click **Create Bucket**.

---

### Step 3: Configure Bucket CORS (Crucial for Direct Uploads)
Because the browser uploads files directly to R2 using presigned PUT URLs, CORS must be configured on the bucket:
1. In the Cloudflare Dashboard, open your bucket (`khata-documents`).
2. Navigate to the **Settings** tab.
3. Scroll down to **CORS Policy** and click **Add CORS policy** (or Edit).
4. Paste the following JSON policy:

```json
[
  {
    "AllowedOrigins": [
      "https://khata.algions.in",
      "http://localhost:5173",
      "http://localhost:3000"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "HEAD"
    ],
    "AllowedHeaders": [
      "Content-Type",
      "Content-Length",
      "Authorization"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```
5. Click **Save**.

---

### Step 4: Generate R2 API Tokens
1. In Cloudflare, go back to the main **R2 Overview** page.
2. In the right-hand panel, click **Manage R2 API Tokens**.
3. Click **Create API token**.
4. Configure the token:
   - **Token Name:** `khata-production-token`
   - **Permissions:** **Object Read & Write**
   - **Specify bucket(s):** Select **Apply to specific buckets only** and pick `khata-documents`.
   - **TTL:** Leave blank or set to your preferred expiration.
5. Click **Create API Token**.
6. **IMPORTANT:** Copy and save the following values immediately (they will not be shown again):
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (displayed under *Account ID* on the R2 overview page).

---

### Step 5: Configure Environment Variables on Render

In your Render Dashboard for the backend service (`api-khata.algions.in`), add the following environment variables under **Environment**:

| Variable Name | Value | Description |
|---|---|---|
| `R2_ACCOUNT_ID` | `your_cloudflare_account_id` | Cloudflare 32-character account ID |
| `R2_ACCESS_KEY_ID` | `your_r2_access_key_id` | Access key generated in Step 4 |
| `R2_SECRET_ACCESS_KEY` | `your_r2_secret_access_key` | Secret key generated in Step 4 |
| `R2_BUCKET_NAME` | `khata-documents` | Name of your R2 bucket |

*(Optional)* `R2_ENDPOINT` is automatically inferred from `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. You only need to set `R2_ENDPOINT` if using a custom gateway or reverse proxy.

---

### Step 6: Apply Database Migration 009

Run the forward migration on the production Neon database:

```bash
npm run migrate --workspace=backend
```

Or execute `backend/migrations/009_product_images_and_offline_bills.sql` directly in the Neon SQL Editor console:
- Adds image metadata columns to `products`.
- Creates `offline_bill_records` table with phone & date indexes.

---

### Step 7: Verify Functionality

1. **Product Images:**
   - Open `https://khata.algions.in` and log in.
   - Go to **Products** master.
   - Click **Add Product** and snap a camera photo or choose a local image.
   - Click **Save Product**; verify the thumbnail appears in the product catalogue.
   - Click the thumbnail to verify high-resolution lightbox view.
   - Open **New Udhar** in Khata ledger; verify product search options render thumbnails.
2. **Offline Bill Documents:**
   - In Khata ledger view, click the **Offline Bill** button beside **New Udhar**.
   - In the modal, fill in Customer Name, Customer Mobile, and photograph a physical receipt.
   - Click **Upload & Store Offline Bill**.
   - Switch to **Previous Bills** tab; verify search by customer name/phone, high-res view, and download.
   - Check the customer ledger to verify zero balance or transaction changes (complete financial isolation).
