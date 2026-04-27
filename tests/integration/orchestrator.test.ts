import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_ACCESS_TOKEN: "shpat_test123",
  SHOPIFY_LOCATION_ID: "gid://shopify/Location/123",
  FULFILLMEN_API_KEY: "test-key",
  TRIGGER_SYNC_SECRET: "test-secret",
  FULFILLMEN_BASE_URL: "https://wms.test.com/api-json",
  FULFILLMEN_STORAGE: "WH001",
  CRON_ENABLED: "false",
};

const syncRuns: Record<string, unknown>[] = [];
const syncEntries: Record<string, unknown>[] = [];

function resetData() {
  syncRuns.length = 0;
  syncEntries.length = 0;
}

const mockFindFirst = vi.fn(async () => null);

vi.mock("~/db.server.js", () => ({
  prisma: {
    syncRun: {
      findFirst: (...args: Parameters<typeof mockFindFirst>) => mockFindFirst(...args),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const run = {
          id: `run-${syncRuns.length + 1}`,
          ...data,
          startedAt: new Date(),
        };
        syncRuns.push(run);
        return run;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const run = syncRuns.find((r) => r.id === where.id);
          if (run) Object.assign(run, data);
          return run;
        },
      ),
    },
    syncEntry: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        syncEntries.push(...(data as Record<string, unknown>[]));
        return { count: data.length };
      }),
    },
  },
}));

vi.mock("~/sync/fulfillmen-client.js", () => ({
  fetchAllInventory: vi.fn(async () => {
    return new Map([
      ["SKU-A", 10],
      ["SKU-B", 20],
      ["SKU-C", 30],
    ]);
  }),
}));

vi.mock("~/sync/shopify-inventory.js", () => ({
  fetchAllShopifyVariants: vi.fn(async () => {
    return new Map([
      [
        "SKU-A",
        [
          {
            variantId: "gid://shopify/ProductVariant/1",
            inventoryItemId: "gid://shopify/InventoryItem/1",
            sku: "SKU-A",
            currentQuantity: 8,
          },
        ],
      ],
      [
        "SKU-B",
        [
          {
            variantId: "gid://shopify/ProductVariant/2",
            inventoryItemId: "gid://shopify/InventoryItem/2",
            sku: "SKU-B",
            currentQuantity: 20,
          },
        ],
      ],
    ]);
  }),
  batchUpdateInventory: vi.fn(
    async (updates: Array<{ inventoryItemId: string }>) => ({
      succeeded: updates.length,
      failed: [],
    }),
  ),
}));

describe("orchestrator", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetData();
    mockFindFirst.mockResolvedValue(null);
    Object.assign(process.env, VALID_ENV);

    const { loadConfig } = await import("~/config/app-config.js");
    await loadConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a full sync cycle: UPDATED, SKIPPED, UNMATCHED", async () => {
    const { runSync } = await import("~/sync/orchestrator.js");
    const syncRunId = await runSync("test");

    expect(syncRunId).toBeTruthy();
    expect(syncRuns.length).toBe(1);
    expect(syncRuns[0].status).toBe("COMPLETED");

    const updated = syncEntries.filter((e) => e.status === "UPDATED");
    const skipped = syncEntries.filter((e) => e.status === "SKIPPED");
    const unmatched = syncEntries.filter((e) => e.status === "UNMATCHED");

    expect(updated.length).toBe(1);
    expect(updated[0].sku).toBe("SKU-A");
    expect(updated[0].shopifyPrevQty).toBe(8);
    expect(updated[0].shopifyNewQty).toBe(10);

    expect(skipped.length).toBe(1);
    expect(skipped[0].sku).toBe("SKU-B");

    expect(unmatched.length).toBe(1);
    expect(unmatched[0].sku).toBe("SKU-C");
  });

  it("returns null when sync is already running", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "existing-run",
      status: "RUNNING",
      startedAt: new Date(),
    } as never);

    const { runSync } = await import("~/sync/orchestrator.js");
    const syncRunId = await runSync("test");
    expect(syncRunId).toBeNull();
  });
});
