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
};

function mockFetch(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => ({
    json: async () => handler(url),
  }));
}

describe("fulfillmen-client", () => {
  beforeEach(async () => {
    vi.resetModules();
    Object.assign(process.env, VALID_ENV);
    const { loadConfig } = await import("~/config/app-config.js");
    await loadConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches single page of inventory", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      SKU: `SKU-${i}`,
      TotalNumber: String(10 + i),
    }));

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [{ ShortName: "WH001" }] };
        }
        return { Code: "100", count: "5", data: items };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(result.size).toBe(5);
    expect(result.get("SKU-0")).toBe(10);
    expect(result.get("SKU-4")).toBe(14);
  });

  it("paginates through multiple pages", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => ({
      SKU: `SKU-${i}`,
      TotalNumber: 10,
    }));
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      SKU: `SKU-${20 + i}`,
      TotalNumber: 20,
    }));

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [{ ShortName: "WH001" }] };
        }
        if (url.includes("page=1")) {
          return { Code: "100", count: "25", data: page1 };
        }
        return { Code: "100", count: "25", data: page2 };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(result.size).toBe(25);
  });

  it("handles TotalNumber as string and number", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [{ ShortName: "WH001" }] };
        }
        return {
          Code: 100,
          count: "2",
          data: [
            { SKU: "A", TotalNumber: "42" },
            { SKU: "B", TotalNumber: 99 },
          ],
        };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(result.get("A")).toBe(42);
    expect(result.get("B")).toBe(99);
  });

  it("skips NaN TotalNumber items", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [{ ShortName: "WH001" }] };
        }
        return {
          Code: 100,
          count: "2",
          data: [
            { SKU: "A", TotalNumber: "not-a-number" },
            { SKU: "B", TotalNumber: 5 },
          ],
        };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(result.has("A")).toBe(false);
    expect(result.get("B")).toBe(5);
  });

  it("throws on auth failure (Code 103) from inventory endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [{ ShortName: "WH001" }] };
        }
        return { Code: "103", data: [] };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    await expect(fetchAllInventory()).rejects.toThrow("auth failed");
  });

  it("falls back to env var when GetStorageList fails", async () => {
    let inventoryCalled = false;

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          throw new Error("Network error");
        }
        inventoryCalled = true;
        return { Code: "100", count: "1", data: [{ SKU: "A", TotalNumber: 5 }] };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(inventoryCalled).toBe(true);
    expect(result.get("A")).toBe(5);
  });

  it("throws when no warehouse codes available", async () => {
    vi.resetModules();
    Object.assign(process.env, { ...VALID_ENV, FULFILLMEN_STORAGE: "" });
    const { loadConfig } = await import("~/config/app-config.js");
    await loadConfig();

    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return { Code: "100", data: [] };
        }
        return { Code: "100", data: [] };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    await expect(fetchAllInventory()).rejects.toThrow(
      "No warehouse codes available",
    );
  });

  it("aggregates quantities across warehouses", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => {
        if (url.includes("GetStorageList")) {
          return {
            Code: 100,
            data: [{ ShortName: "WH001" }, { ShortName: "WH002" }],
          };
        }
        if (url.includes("WH001") && url.includes("getinventorylist")) {
          return {
            Code: 100,
            count: "1",
            data: [{ SKU: "A", TotalNumber: 10 }],
          };
        }
        if (url.includes("WH002") && url.includes("getinventorylist")) {
          return {
            Code: 100,
            count: "1",
            data: [{ SKU: "A", TotalNumber: 5 }],
          };
        }
        return { Code: "100", data: [] };
      }),
    );

    const { fetchAllInventory } = await import(
      "~/sync/fulfillmen-client.js"
    );
    const result = await fetchAllInventory();
    expect(result.get("A")).toBe(15);
  });
});
