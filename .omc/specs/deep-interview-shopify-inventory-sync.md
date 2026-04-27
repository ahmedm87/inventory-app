# Deep Interview Spec: Shopify Inventory Sync App (Fulfillmen + ShipBob)

## Metadata
- Interview ID: di-shopify-inventory-2026-04-27
- Rounds: 10
- Final Ambiguity Score: 12.2%
- Type: greenfield
- Generated: 2026-04-27
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.40 | 0.368 |
| Constraint Clarity | 0.88 | 0.30 | 0.264 |
| Success Criteria | 0.82 | 0.30 | 0.246 |
| **Total Clarity** | | | **0.878** |
| **Ambiguity** | | | **0.122** |

## Goal
Build a Shopify custom app (single-store) that automatically syncs inventory levels from third-party warehouse providers into Shopify. The app pulls stock quantities from warehouse APIs on an hourly schedule and updates a single combined Shopify location. **Phase 1** integrates Fulfillmen WMS (backup warehouse) with their REST API. **Phase 2** adds ShipBob (main warehouse) integration with per-warehouse inventory management in an embedded Shopify Admin UI, replacing the existing ShipBob app.

## Phases

### Phase 1: Fulfillmen WMS Integration
- Connect to Fulfillmen WMS REST API (`/api-json/` endpoints)
- Authenticate via API key (`Key` query parameter)
- Hourly cron job pulls inventory from `GET /api-json/getinventorylist.aspx`
- Match Fulfillmen SKUs to Shopify variant SKUs (exact string match)
- Update inventory quantities on a single combined Shopify location
- Log all sync operations (success, mismatches, errors)
- Phase 1: Logs only for monitoring (no push alerts — dashboard and alerts deferred to Phase 2)

### Phase 2: ShipBob Integration + Embedded UI
- Integrate ShipBob API for inventory data
- Replace the existing ShipBob Shopify app
- Add embedded Shopify Admin UI for per-warehouse inventory management
- Support viewing/managing inventory per warehouse (Fulfillmen vs ShipBob)
- Combined totals still sync to single Shopify location

## Constraints
- **Tech stack:** Node.js with Remix (Shopify official app template)
- **App type:** Shopify custom app (single store, API access token auth — no OAuth/multi-tenant)
- **Sync frequency:** Hourly cron job
- **SKU matching:** Exact string match between warehouse SKUs and Shopify variant SKUs
- **Shopify location:** Single combined location (not per-warehouse locations)
- **Data flow:** One-directional — warehouses → Shopify only
- **Hosting:** Docker container on PaaS (Railway or Fly.io)
- **Database:** Prisma ORM with PostgreSQL (managed DB from hosting provider)

## Non-Goals
- Multi-tenant / App Store distribution (this is for one store only)
- Shopify → warehouse sync (pushing data back to warehouses)
- Order management or fulfillment routing
- Real-time sync (hourly is acceptable)
- Multiple Shopify locations (single combined location only)

## Acceptance Criteria
- [ ] Phase 1: Fulfillmen API key can be configured in the app
- [ ] Phase 1: Hourly cron fetches all inventory from Fulfillmen WMS via `getinventorylist.aspx`
- [ ] Phase 1: Paginates through all inventory pages (20 items/page)
- [ ] Phase 1: SKUs are matched exactly between Fulfillmen and Shopify variants
- [ ] Phase 1: Matched SKUs have their Shopify inventory levels updated via Shopify Admin API
- [ ] Phase 1: Unmatched SKUs (in Fulfillmen but not Shopify) are logged, not errored
- [ ] Phase 1: API failures are logged with structured error details
- [ ] Phase 1: Sync log records: timestamp, SKU, old quantity, new quantity, status
- [ ] Phase 1: App runs as a Shopify custom app with Node.js/Remix
- [ ] Phase 2: ShipBob API integrated for inventory data
- [ ] Phase 2: Embedded Shopify Admin UI shows per-warehouse inventory breakdown
- [ ] Phase 2: Combined inventory from both warehouses syncs to single Shopify location
- [ ] Phase 2: Existing ShipBob app functionality is replaced

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| Needs to be a full Shopify app | Challenged: does it need App Store distribution? | No — custom app for single store is sufficient |
| Bidirectional sync needed | Asked about data flow direction | One-way only: warehouses → Shopify |
| "Fulfillment" is a known 3PL | Asked what provider it is | Custom warehouse: Fulfillmen WMS with REST API |
| Real-time sync required | Asked about acceptable latency | Hourly periodic sync is sufficient |
| Per-warehouse Shopify locations | Asked about location strategy | Single combined location — simpler |
| SKU mapping table needed | Asked about SKU matching | Exact string match — SKUs are identical across systems |
| Complex error handling needed | Asked about failure scenarios | Log mismatches, alert on API failures, keep it simple |
| Push alerts needed for Phase 1 | Asked about monitoring preferences | Logs only for Phase 1 — dashboard and alerts deferred to Phase 2 |
| Hosting undecided | Asked about deployment target | Docker container on PaaS (Railway/Fly.io) with managed PostgreSQL |

## Technical Context

### Fulfillmen WMS API
- **Base pattern:** `https://wms.fulfillmen.com/api-json/`
- **Auth:** API key via `Key` query parameter
- **Inventory endpoint:** `GET /api-json/getinventorylist.aspx`
  - Params: `Key`, `Storage` (warehouse code), `SKU`, `page` (20 items/page)
  - Response: `{ success, Code, count, data: [{ SKU, TotalNumber, t_Weight, ... }] }`
  - Code 100 = success, 101 = failure, 103 = auth failed
- **Warehouse list:** `GET /api-json/GetStorageList.aspx`
- **Products:** `GET /api-json/GetGoodsList.aspx`
- **Webhooks:** Supported (type 2 = product update, type 3 = inbound status) — can supplement polling in future
- **Docs:** https://wms.fulfillmen.com/api-json/wms/Default.html#shuoming

### Shopify Admin API
- Custom app with API access token
- Inventory management via `inventoryLevels` and `inventoryItems` resources
- GraphQL Admin API recommended for batch inventory updates

### Tech Stack
- **Framework:** Node.js + Remix (Shopify app template)
- **Database:** Prisma ORM with PostgreSQL (managed DB from PaaS provider)
- **Shopify SDK:** @shopify/shopify-api + @shopify/shopify-app-remix
- **Scheduling:** In-process Node cron (node-cron) — suitable for single-container deployment
- **Hosting:** Docker container on Railway or Fly.io
- **Containerization:** Dockerfile for consistent deployment
- **Logging:** Structured logging for sync operations

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Shopify Store | external system | products, variants, inventory levels, locations | target for inventory sync |
| Shopify Location | core domain | name, id | receives combined inventory from all warehouses |
| Fulfillmen WMS | external system | API key, base URL, SKUs, stock quantities, warehouse codes | source of inventory data (Phase 1) |
| ShipBob | external system | API, stock levels, warehouse role (main) | source of inventory data (Phase 2) |
| Inventory Level | core domain | SKU, quantity, warehouse source, last synced | maps warehouse stock to Shopify |
| Custom App | core domain | Node.js/Remix, cron schedule, sync logic | orchestrates warehouse→Shopify sync |
| Sync Log | supporting | timestamp, SKU, old qty, new qty, status, errors | audit trail for sync operations |
| Webhook Notification | supporting | type, event, payload | supplement to polling (Fulfillmen supports) |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 5 | 5 | - | - | N/A |
| 2 | 5 | 0 | 0 | 5 | 100% |
| 3 | 5 | 0 | 0 | 5 | 100% |
| 4 | 6 | 1 | 0 | 5 | 83% |
| 5 | 7 | 2 | 0 | 5 | 71% |
| 6 | 7 | 0 | 0 | 7 | 100% |
| 7 | 8 | 1 | 0 | 7 | 87.5% |
| 8 | 8 | 0 | 0 | 8 | 100% |
| 9 | 8 | 0 | 0 | 8 | 100% |
| 10 | 8 | 0 | 0 | 8 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (10 rounds)</summary>

### Round 1
**Q:** When you say 'update inventory levels' — what is the direction of the data flow? Is the Shopify store the source of truth and you push levels TO the warehouses, or are the warehouses the source of truth and you pull actual stock counts FROM them into Shopify? Or is it bidirectional sync?
**A:** Warehouses → Shopify
**Ambiguity:** 72.5% (Goal: 0.50, Constraints: 0.15, Criteria: 0.10)

### Round 2
**Q:** For the first phase (Fulfillment integration), how would you verify it's working correctly? How quickly should inventory updates appear in Shopify?
**A:** Periodic sync (hourly)
**Ambiguity:** 61.5% (Goal: 0.55, Constraints: 0.15, Criteria: 0.40)

### Round 3
**Q:** What is the specific fulfillment provider you're calling 'Fulfillment'? Is it a named service with a documented API, or a custom/proprietary system?
**A:** Custom warehouse system
**Ambiguity:** 58.0% (Goal: 0.60, Constraints: 0.20, Criteria: 0.40)

### Round 4 [Contrarian Mode]
**Q:** You said this should be a 'Shopify app' — does it actually need to be a published/installable app, or would a simpler background service work?
**A:** Not sure — help me decide → Recommended: Custom app (single store)
**Ambiguity:** 51.5% (Goal: 0.65, Constraints: 0.35, Criteria: 0.40)

### Round 5
**Q:** Share the fulfillment API documentation.
**A:** Provided URL: https://wms.fulfillmen.com/api-json/wms/Default.html#shuoming
**API reviewed:** REST API with key auth, inventory endpoint found, webhooks supported.
**Ambiguity:** 37.0% (Goal: 0.75, Constraints: 0.60, Criteria: 0.50)

### Round 6 [Simplifier Mode]
**Q:** What tech stack should we use?
**A:** Node.js / Remix (Recommended)
**Ambiguity:** 32.5% (Goal: 0.75, Constraints: 0.75, Criteria: 0.50)

### Round 7
**Q:** When the hourly sync encounters a problem, what should happen? How do you match SKUs between systems?
**A:** SKUs match exactly. Log mismatches but skip them. Alert on API failures.
**Ambiguity:** 22.5% (Goal: 0.85, Constraints: 0.75, Criteria: 0.70)

### Round 8
**Q:** Shopify tracks inventory per 'location'. Should we use separate locations per warehouse, or a single combined location?
**A:** Single combined location
**Ambiguity:** 19.0% (Goal: 0.90, Constraints: 0.78, Criteria: 0.72)

### Round 9
**Q:** For monitoring and alerts: when the sync fails or encounters issues, how do you want to be notified? Do you want a dashboard in the Shopify Admin embedded UI in Phase 1?
**A:** Logs only for Phase 1 — no push alerts or dashboard until Phase 2.
**Ambiguity:** 16.0% (Goal: 0.90, Constraints: 0.78, Criteria: 0.82)

### Round 10
**Q:** Where do you plan to host this app? This affects how the hourly cron job runs and whether we need an external database.
**A:** Docker container on PaaS (Railway/Fly.io)
**Ambiguity:** 12.2% (Goal: 0.92, Constraints: 0.88, Criteria: 0.82)

</details>
