# Phase 1 Implementation Plan: Shopify Inventory Sync (Fulfillmen WMS)

**Status:** APPROVED (Ralplan consensus: Planner + Architect + Critic, re-validated 2026-04-27)
**Date:** 2026-04-27
**Spec:** `.omc/specs/deep-interview-shopify-inventory-sync.md`

---

## RALPLAN-DR Summary

### Principles

1. **Correctness over speed** -- Inventory data integrity is paramount. Every mutation must be auditable.
2. **Fail-safe** -- A failed sync must never corrupt inventory. If Fulfillmen API errors, sync aborts; Shopify quantities remain unchanged. Zero warehouse results = abort with error, not silent skip.
3. **Single source of truth for config** -- Environment variables are the runtime authority. DB stores config for audit/display only.
4. **Observability from day one** -- Every sync run, every SKU decision, every API call is logged as structured JSON.
5. **Phase 2 ready** -- Data model and module boundaries accommodate ShipBob without refactoring Phase 1 code.

### Decision Drivers

1. Shopify app template conventions (Remix, Prisma, @shopify/shopify-api)
2. Single-container PaaS deployment (Railway/Fly.io) with managed Postgres
3. Fulfillmen WMS REST API characteristics (paginated, key-auth, warehouse-scoped)
4. Hourly sync cadence with tolerance for up to ~5 min execution time
5. One-directional data flow: warehouse -> Shopify only

### Viable Options Considered

| Decision | Option A (Chosen) | Option B | Why A |
|---|---|---|---|
| Scheduling | In-process node-cron in server.ts | External cron service (Railway cron) | Simpler single-artifact; Railway cron noted as alternative |
| Concurrency guard | DB-based SyncRun status + in-memory fast-path | Pure in-memory lock | Survives restarts; stale recovery on boot |
| Shopify inventory update | GraphQL `inventorySetQuantities` | REST inventory_levels/set | GraphQL allows batching, Shopify-recommended |
| Config management | Env vars as authority, DB for audit | DB as primary config | Env vars are immutable at runtime |
| Warehouse enumeration | `GetStorageList.aspx` with env var fallback | Hardcoded warehouse code | Dynamic discovery with safe fallback |

---

## Project Structure

```
inventory-app/
  prisma/
    schema.prisma
    migrations/
  app/
    root.tsx
    entry.server.tsx
    shopify.server.ts
    routes/
      app._index.tsx
      api.trigger-sync.ts
    sync/
      orchestrator.ts
      fulfillmen-client.ts
      shopify-inventory.ts
      sku-matcher.ts
      sync-logger.ts
    config/
      app-config.ts
    lib/
      cron.ts
      stale-recovery.ts
  server.ts
  Dockerfile
  docker-compose.yml
  .env.example
  package.json
  tsconfig.json
  tests/
    unit/
      sku-matcher.test.ts
      fulfillmen-client.test.ts
      app-config.test.ts
    integration/
      orchestrator.test.ts
```

---

## Data Model (Prisma Schema)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model AppConfig {
  id        String   @id @default(cuid())
  key       String   @unique
  value     String
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}

model SyncRun {
  id              String        @id @default(cuid())
  status          SyncRunStatus @default(RUNNING)
  source          String        @default("fulfillmen")
  triggeredBy     String        @default("cron")
  startedAt       DateTime      @default(now())
  completedAt     DateTime?
  totalProcessed  Int           @default(0)
  totalUpdated    Int           @default(0)
  totalSkipped    Int           @default(0)
  totalUnmatched  Int           @default(0)
  totalErrors     Int           @default(0)
  errorMessage    String?
  entries         SyncEntry[]

  @@index([status])
  @@index([startedAt])
}

enum SyncRunStatus {
  RUNNING
  COMPLETED
  FAILED
}

model SyncEntry {
  id              String          @id @default(cuid())
  syncRunId       String
  syncRun         SyncRun         @relation(fields: [syncRunId], references: [id])
  sku             String
  warehouseQty    Int
  shopifyPrevQty  Int?
  shopifyNewQty   Int?
  status          SyncEntryStatus
  warehouseSource String?
  message         String?
  createdAt       DateTime        @default(now())

  @@index([syncRunId])
  @@index([sku])
}

enum SyncEntryStatus {
  UPDATED
  SKIPPED
  UNMATCHED
  DUPLICATE
  ERROR
}
```

---

## Implementation Tasks

### Task 1: Project Scaffolding [S]
**Deps:** None
**Files:** `package.json`, `tsconfig.json`, `server.ts`, `.env.example`

- Initialize Node.js project with Remix + Shopify SDK dependencies
- Dependencies: `@shopify/shopify-api`, `@remix-run/node`, `@remix-run/react`, `@remix-run/express`, `@prisma/client`, `prisma`, `node-cron`, `express`
- Dev: `vitest`, `typescript`, `@types/node`
- `server.ts` is the Node entry point (Express + Remix handler)
- **Critical:** `server.ts` must call `loadConfig()`, `initStaleRecovery()`, `initCron()` at top-level module scope, NOT inside a route handler or lazily-loaded module. Remix lazy-loads route modules; cron in a route module would only init on first HTTP request. Scale-to-zero PaaS environments may never receive that first request.

### Task 2: App Configuration [S]
**Deps:** Task 1
**Files:** `app/config/app-config.ts`

- `loadConfig()`: reads env vars, validates required ones exist, freezes config object, optionally upserts to AppConfig DB (fire-and-forget audit)
- `getConfig()`: returns frozen config. Throws if `loadConfig()` not yet called.
- **Rule:** Env vars always win at boot. Re-applied on every container start. DB is never read in hot paths.
- **Validation:** `SHOPIFY_LOCATION_ID` must start with `gid://shopify/Location/` -- reject with clear error if not GID format
- Config shape:

```typescript
interface AppConfig {
  fulfillmenApiKey: string;
  fulfillmenBaseUrl: string;       // default: "https://wms.fulfillmen.com/api-json"
  fulfillmenStorage: string;       // fallback warehouse code(s), comma-separated
  shopifyStoreDomain: string;
  shopifyAccessToken: string;
  shopifyLocationId: string;       // GID format: gid://shopify/Location/{id}
  cronSchedule: string;            // default: "0 * * * *"
  cronEnabled: boolean;            // default: true
  syncStaleTimeoutMinutes: number; // default: 30
  triggerSyncSecret: string;
  databaseUrl: string;
  nodeEnv: string;
  port: number;                    // default: 3000
}
```

### Task 3: Prisma Schema & Migrations [S]
**Deps:** Task 1
**Files:** `prisma/schema.prisma`

- Define schema as above
- Run `npx prisma migrate dev --name init`
- Export singleton Prisma client

### Task 4: Stale Recovery [S]
**Deps:** Task 3
**Files:** `app/lib/stale-recovery.ts`

- `initStaleRecovery()` called from `server.ts` at boot, BEFORE cron init
- Find all SyncRun where status=RUNNING AND startedAt < (now - staleTimeoutMinutes)
- Mark each as FAILED with errorMessage "Marked as stale on server restart"
- Log count of recovered stale runs

### Task 5: Fulfillmen API Client [M]
**Deps:** Task 2
**Files:** `app/sync/fulfillmen-client.ts`

**Warehouse enumeration:**
- Call `GET {baseUrl}/GetStorageList.aspx?Key={apiKey}` to discover warehouse codes
- If call fails (network error, Code != 100) OR returns empty list: fall back to `config.fulfillmenStorage` env var (comma-separated codes)
- If fallback is also empty: throw error -- sync must abort with FAILED status ("No warehouse codes available")
- Log whether using dynamic discovery or env fallback

**Inventory fetching (per warehouse):**
- `GET {baseUrl}/getinventorylist.aspx?Key={apiKey}&Storage={code}&page={page}`
- Do NOT pass SKU param (bulk fetch all)
- Code 100 = success. Code 101 = failure (throw). Code 103 = auth failed (throw with distinct message)
- `TotalNumber` may be string -- always `parseInt(value, 10)`. Skip NaN items with error log.

**Pagination:**
- Start page=1. After each page: if `data.length < 20`, last page -- stop
- Cross-check: if |totalFetched - parseInt(count)| / parseInt(count) > 0.05, log warning
- Sequential fetches with 200ms delay between pages

**Aggregation:**
- Same SKU across multiple warehouses: sum quantities
- Return `Map<string, number>` (SKU -> total quantity)

### Task 6: Shopify Inventory Client [M]
**Deps:** Task 2
**Files:** `app/sync/shopify-inventory.ts`, `app/shopify.server.ts`

**Shopify API setup (`shopify.server.ts`):**
- Configure for custom app auth (static access token, not OAuth)
- Export `getShopifyGraphQLClient()` returning authenticated client

**Fetch all variants with inventory:**
- GraphQL query must include: `variants.inventoryItem.id`, `inventoryItem.tracked`, `inventoryLevels(locationIds: [$locationId])`
- Filter to tracked items only (skip untracked)
- Return `Map<string, ShopifyVariantInventory[]>` (array handles duplicate SKUs)
- Log warning for any SKU with >1 variant

```graphql
query GetProductVariants($locationId: ID!, $cursor: String) {
  productVariants(first: 50, after: $cursor) {
    edges {
      node {
        id
        sku
        inventoryItem {
          id
          tracked
          inventoryLevels(locationIds: [$locationId]) {
            edges {
              node {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Inventory update mutation:**
- `inventorySetQuantities` with `reason: "correction"`, `name: "available"`
- Batch up to 100 items per mutation call
- Check `extensions.cost.throttleStatus.currentlyAvailable` -- back off if < 100
- Exponential backoff on 429 responses

```graphql
mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { createdAt }
    userErrors { field message }
  }
}
```

### Task 7: SKU Matcher [S]
**Deps:** Task 5, Task 6
**Files:** `app/sync/sku-matcher.ts`

- Input: `Map<string, number>` (Fulfillmen) + `Map<string, ShopifyVariantInventory[]>` (Shopify)
- Exact string match on SKU
- Output per SKU: `matched` (1 variant), `duplicate` (>1 variant), `unmatched` (0)
- **Duplicate handling:** Set ALL matching variants to the same Fulfillmen quantity. Log warning with variant count.
- Zero is a valid quantity (item genuinely out of stock). Set Shopify qty to 0.

### Task 8: Sync Orchestrator [L]
**Deps:** Tasks 4, 5, 6, 7
**Files:** `app/sync/orchestrator.ts`, `app/sync/sync-logger.ts`

**Concurrency guard (DB-based, in-memory fast-path):**
1. Check in-memory `isSyncing`. If true, return early.
2. Query DB: `SyncRun WHERE status=RUNNING LIMIT 1`
   - Found + startedAt < 30min ago: real sync running, return early
   - Found + startedAt >= 30min ago: mark FAILED (stale), continue
3. Create SyncRun(status=RUNNING) in DB
4. **Only after successful DB write:** set `isSyncing = true`

**Full sync algorithm:**
```
STEP 1: Concurrency check (as above)
STEP 2: Create SyncRun(status=RUNNING, triggeredBy, source="fulfillmen")
STEP 3: Enumerate warehouses (GetStorageList.aspx with env fallback)
         If no warehouses available: abort FAILED "No warehouse codes"
STEP 4: Fetch Fulfillmen inventory per warehouse, paginate, aggregate by SKU
STEP 5: Fetch Shopify variants with inventoryItem.id + inventoryLevels
         Filter to tracked items. Build Map<SKU, variant[]>
STEP 6: Match SKUs (sku-matcher)
STEP 7: For each matched/duplicate SKU:
         - Record shopifyPrevQty from current Shopify level
         - If warehouseQty === currentQty: SKIPPED
         - Else: add to updateBatch, shopifyNewQty = warehouseQty
STEP 8: Batch call inventorySetQuantities (100 per mutation)
         On userErrors: mark affected entries as ERROR
STEP 9: Record unmatched SKUs as UNMATCHED entries
STEP 10: Finalize SyncRun(COMPLETED, stats)
          Set isSyncing=false
STEP 11: On any uncaught exception: SyncRun(FAILED, errorMessage)
          Set isSyncing=false
```

**Partial update policy:** If sync fails mid-batch (some SKUs updated, others not), mark FAILED. Already-updated SKUs remain at new quantities. Next sync will reconcile all SKUs.

### Task 9: Cron Setup [S]
**Deps:** Task 8
**Files:** `app/lib/cron.ts`, `server.ts` (modification)

- `initCron()`: if `config.cronEnabled`, schedule `runSync('cron')` with node-cron
- Called from `server.ts` at top level, after `loadConfig()` and `initStaleRecovery()`

### Task 10: HTTP Trigger Endpoint [S]
**Deps:** Task 8
**Files:** `app/routes/api.trigger-sync.ts`

- `POST /api/trigger-sync`
- Auth: `Authorization: Bearer {TRIGGER_SYNC_SECRET}` header. 401 on mismatch.
- Calls `runSync('api')`, returns `{ success, syncRunId, status }`
- Enables Railway cron services or external schedulers as alternatives

### Task 11: Minimal UI Route [S]
**Deps:** Task 3
**Files:** `app/routes/app._index.tsx`

- Read-only status page showing last 10 SyncRun records
- Table: status, triggeredBy, startedAt, completedAt, totalUpdated, totalErrors
- No interactive elements in Phase 1

### Task 12: Unit Tests [M]
**Deps:** Tasks 2, 5, 6, 7
**Files:** `tests/unit/*.test.ts`, `vitest.config.ts`

- **sku-matcher.test.ts:** exact match, no match, duplicate SKU, empty inputs, zero qty
- **fulfillmen-client.test.ts:** single/multi-page pagination, TotalNumber string/number/NaN, auth error, GetStorageList failure -> fallback, empty warehouse list -> abort, count cross-check
- **app-config.test.ts:** all required vars present, missing var throws, frozen config, getConfig before loadConfig throws, SHOPIFY_LOCATION_ID GID validation

### Task 13: Integration Test [M]
**Deps:** Task 8
**Files:** `tests/integration/orchestrator.test.ts`

Run full orchestrator against seeded Postgres with mocked external APIs. Assert:
- SyncRun transitions RUNNING -> COMPLETED
- SyncEntry rows match: SKU-A UPDATED (prevQty=8, newQty=10), SKU-B SKIPPED (qty match), SKU-C UNMATCHED
- Stale recovery: seed RUNNING run from 2hr ago, run initStaleRecovery, assert FAILED
- Concurrency guard: seed RUNNING run from 1min ago, call runSync, assert returns early

### Task 14: Docker & Deployment [S]
**Deps:** Task 1
**Files:** `Dockerfile`, `docker-compose.yml`

Multi-stage build: node:20-alpine. Build Remix + Prisma generate. Production stage: copy artifacts, `CMD prisma migrate deploy && node build/server.js`.

docker-compose.yml: app (port 3000) + postgres:16-alpine (port 5432).

**Railway note:** Supports native cron job services. Alternative: set `CRON_ENABLED=false` on web service, create Railway cron that POSTs to `/api/trigger-sync`.

---

## Environment Configuration

```bash
# === Required ===
DATABASE_URL="postgresql://inventory:inventory@localhost:5432/inventory"
SHOPIFY_STORE_DOMAIN="my-store.myshopify.com"
SHOPIFY_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxx"
SHOPIFY_LOCATION_ID="gid://shopify/Location/123456789"
FULFILLMEN_API_KEY="your-api-key"
TRIGGER_SYNC_SECRET="a-long-random-secret"

# === Optional (have defaults) ===
FULFILLMEN_BASE_URL="https://wms.fulfillmen.com/api-json"
FULFILLMEN_STORAGE="WH001"           # Fallback if GetStorageList fails; comma-separated for multiple
CRON_SCHEDULE="0 * * * *"
CRON_ENABLED="true"
SYNC_STALE_TIMEOUT_MINUTES="30"
NODE_ENV="production"
PORT="3000"
```

---

## Task Dependency Graph

```
Task 1 (Scaffold)
  |-- Task 2 (Config) + Task 3 (Prisma) + Task 14 (Docker) [parallel]
  |    |-- Task 4 (Stale Recovery) + Task 5 (Fulfillmen) + Task 6 (Shopify) [parallel]
  |    |    |-- Task 7 (SKU Matcher)
  |    |         |-- Task 8 (Orchestrator)
  |    |              |-- Task 9 (Cron) + Task 10 (Trigger) [parallel]
  |    |              |-- Task 12 (Unit Tests) + Task 13 (Integration Test) [parallel]
  |-- Task 11 (UI) [depends on Task 3 only]
```

---

## ADR-001: In-process Cron with HTTP Trigger Fallback

**Decision:** node-cron in server.ts as primary scheduler, POST /api/trigger-sync as mandatory fallback.
**Why:** Single-artifact deployment. HTTP trigger enables Railway cron services or external schedulers.
**Tradeoff:** Cron tied to single process. DB concurrency guard prevents duplicate syncs if scaled.

## ADR-002: DB-Based Concurrency Guard

**Decision:** SyncRun(status=RUNNING) as authority, in-memory flag as fast-path only. Set in-memory flag only after successful DB write.
**Why:** Survives container restarts. Stale recovery on boot handles crashed syncs.

## ADR-003: Env Vars as Runtime Config Authority

**Decision:** Env vars are sole runtime authority. AppConfig DB is write-only audit trail. Config changes require redeployment.
**Why:** Immutable runtime config prevents accidental mutation. Standard 12-factor pattern.
