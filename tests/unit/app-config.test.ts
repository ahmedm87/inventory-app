import { describe, it, expect, beforeEach, vi } from "vitest";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
  SHOPIFY_ACCESS_TOKEN: "shpat_test123",
  SHOPIFY_LOCATION_ID: "gid://shopify/Location/123",
  FULFILLMEN_API_KEY: "test-key",
  TRIGGER_SYNC_SECRET: "test-secret",
};

describe("app-config", () => {
  beforeEach(() => {
    vi.resetModules();
    global.__appConfig__ = undefined;
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("SHOPIFY_") ||
        key.startsWith("FULFILLMEN_") ||
        key === "DATABASE_URL" ||
        key === "TRIGGER_SYNC_SECRET" ||
        key === "CRON_SCHEDULE" ||
        key === "CRON_ENABLED" ||
        key === "SYNC_STALE_TIMEOUT_MINUTES" ||
        key === "PORT"
      ) {
        delete process.env[key];
      }
    }
  });

  async function loadModule() {
    return import("~/config/app-config.js");
  }

  it("loads config with all required vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig, getConfig } = await loadModule();
    await loadConfig();
    const config = getConfig();
    expect(config.fulfillmenApiKey).toBe("test-key");
    expect(config.shopifyStoreDomain).toBe("test.myshopify.com");
    expect(config.shopifyLocationId).toBe("gid://shopify/Location/123");
  });

  it("throws when required var is missing", async () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    const { loadConfig } = await loadModule();
    await expect(loadConfig()).rejects.toThrow(
      "Missing required environment variable: SHOPIFY_ACCESS_TOKEN",
    );
  });

  it("throws when SHOPIFY_LOCATION_ID is not GID format", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      SHOPIFY_LOCATION_ID: "12345",
    });
    const { loadConfig } = await loadModule();
    await expect(loadConfig()).rejects.toThrow("GID format");
  });

  it("returns frozen config", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig, getConfig } = await loadModule();
    await loadConfig();
    const config = getConfig();
    expect(() => {
      (config as unknown as Record<string, unknown>).port = 9999;
    }).toThrow();
  });

  it("throws if getConfig called before loadConfig", async () => {
    const { getConfig } = await loadModule();
    expect(() => getConfig()).toThrow("Config not loaded");
  });

  it("uses defaults for optional vars", async () => {
    Object.assign(process.env, VALID_ENV);
    const { loadConfig, getConfig } = await loadModule();
    await loadConfig();
    const config = getConfig();
    expect(config.fulfillmenBaseUrl).toBe(
      "https://wms.fulfillmen.com/api-json",
    );
    expect(config.cronSchedule).toBe("0 * * * *");
    expect(config.cronEnabled).toBe(true);
    expect(config.syncStaleTimeoutMinutes).toBe(30);
    expect(config.port).toBe(3000);
  });

  it("parses CRON_ENABLED=false correctly", async () => {
    Object.assign(process.env, { ...VALID_ENV, CRON_ENABLED: "false" });
    const { loadConfig, getConfig } = await loadModule();
    await loadConfig();
    expect(getConfig().cronEnabled).toBe(false);
  });

  it("parses PORT and SYNC_STALE_TIMEOUT_MINUTES as integers", async () => {
    Object.assign(process.env, {
      ...VALID_ENV,
      PORT: "8080",
      SYNC_STALE_TIMEOUT_MINUTES: "60",
    });
    const { loadConfig, getConfig } = await loadModule();
    await loadConfig();
    const config = getConfig();
    expect(config.port).toBe(8080);
    expect(config.syncStaleTimeoutMinutes).toBe(60);
  });
});
