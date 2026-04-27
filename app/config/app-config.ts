export interface AppConfig {
  fulfillmenApiKey: string;
  fulfillmenBaseUrl: string;
  fulfillmenStorage: string;
  shopifyStoreDomain: string;
  shopifyAccessToken: string;
  shopifyLocationId: string;
  cronSchedule: string;
  cronEnabled: boolean;
  syncStaleTimeoutMinutes: number;
  triggerSyncSecret: string;
  databaseUrl: string;
  nodeEnv: string;
  port: number;
}

declare global {
  var __appConfig__: AppConfig | undefined;
}

export async function loadConfig(): Promise<void> {
  const required = [
    "DATABASE_URL",
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ACCESS_TOKEN",
    "SHOPIFY_LOCATION_ID",
    "FULFILLMEN_API_KEY",
    "TRIGGER_SYNC_SECRET",
  ] as const;

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const locationId = process.env.SHOPIFY_LOCATION_ID!;
  if (!locationId.startsWith("gid://shopify/Location/")) {
    throw new Error(
      `SHOPIFY_LOCATION_ID must be in GID format (gid://shopify/Location/{id}), got: ${locationId}`,
    );
  }

  global.__appConfig__ = Object.freeze({
    fulfillmenApiKey: process.env.FULFILLMEN_API_KEY!,
    fulfillmenBaseUrl:
      process.env.FULFILLMEN_BASE_URL || "https://wms.fulfillmen.com/api-json",
    fulfillmenStorage: process.env.FULFILLMEN_STORAGE || "",
    shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN!,
    shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN!,
    shopifyLocationId: locationId,
    cronSchedule: process.env.CRON_SCHEDULE || "0 * * * *",
    cronEnabled: process.env.CRON_ENABLED !== "false",
    syncStaleTimeoutMinutes: parseInt(
      process.env.SYNC_STALE_TIMEOUT_MINUTES || "30",
      10,
    ),
    triggerSyncSecret: process.env.TRIGGER_SYNC_SECRET!,
    databaseUrl: process.env.DATABASE_URL!,
    nodeEnv: process.env.NODE_ENV || "production",
    port: parseInt(process.env.PORT || "3000", 10),
  });
}

export function getConfig(): AppConfig {
  if (!global.__appConfig__) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return global.__appConfig__;
}
