// ─── Flat config interface (backwards compatible) ───

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

// ─── Namespaced config interfaces ───

export interface CoreConfig {
  shopifyStoreDomain: string;
  shopifyAccessToken: string;
  triggerSyncSecret: string;
  databaseUrl: string;
  nodeEnv: string;
  port: number;
  cronSchedule: string;
  cronEnabled: boolean;
  syncStaleTimeoutMinutes: number;
}

export interface FulfillmenConfig {
  apiKey: string;
  baseUrl: string;
  storage: string;
  shopifyLocationId: string;
}

export interface ShipBobConfig {
  accessToken: string;
  baseUrl: string;
  usWarehouseId: string;
  euWarehouseId: string;
  auWarehouseId: string;
  shopifyLocationIdUs: string;
  shopifyLocationIdEu: string;
  shopifyLocationIdAu: string;
}

export interface OrderConfig {
  pollSchedule: string;
  pollEnabled: boolean;
  trackingSyncSchedule: string;
  trackingSyncEnabled: boolean;
  countryWarehouseMapping: string;
}

export interface NamespacedConfig {
  core: CoreConfig;
  fulfillmen: FulfillmenConfig;
  shipbob: ShipBobConfig | null;
  order: OrderConfig | null;
}

declare global {
  var __appConfig__: AppConfig | undefined;
  var __namespacedConfig__: NamespacedConfig | undefined;
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

function validateGid(value: string, label: string): void {
  if (!value.startsWith("gid://shopify/Location/")) {
    throw new Error(
      `${label} must be in GID format (gid://shopify/Location/{id}), got: ${value}`,
    );
  }
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
  validateGid(locationId, "SHOPIFY_LOCATION_ID");

  // Build namespaced config
  const core: CoreConfig = {
    shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN!,
    shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN!,
    triggerSyncSecret: process.env.TRIGGER_SYNC_SECRET!,
    databaseUrl: process.env.DATABASE_URL!,
    nodeEnv: process.env.NODE_ENV || "production",
    port: parseInt(process.env.PORT || "3000", 10),
    cronSchedule: process.env.CRON_SCHEDULE || "0 * * * *",
    cronEnabled: process.env.CRON_ENABLED !== "false",
    syncStaleTimeoutMinutes: parseInt(
      process.env.SYNC_STALE_TIMEOUT_MINUTES || "30",
      10,
    ),
  };

  const cnLocationId =
    process.env.SHOPIFY_LOCATION_ID_CN || locationId;

  const fulfillmen: FulfillmenConfig = {
    apiKey: process.env.FULFILLMEN_API_KEY!,
    baseUrl:
      process.env.FULFILLMEN_BASE_URL || "https://wms.fulfillmen.com/api-json",
    storage: process.env.FULFILLMEN_STORAGE || "",
    shopifyLocationId: cnLocationId,
  };

  // ShipBob config is optional — null when credentials absent
  let shipbob: ShipBobConfig | null = null;
  if (process.env.SHIPBOB_ACCESS_TOKEN) {
    const shipbobRequired = [
      "SHIPBOB_US_WAREHOUSE_ID",
      "SHIPBOB_EU_WAREHOUSE_ID",
      "SHIPBOB_AU_WAREHOUSE_ID",
      "SHOPIFY_LOCATION_ID_US",
      "SHOPIFY_LOCATION_ID_EU",
      "SHOPIFY_LOCATION_ID_AU",
    ] as const;

    for (const key of shipbobRequired) {
      if (!process.env[key]) {
        throw new Error(
          `Missing required environment variable: ${key} (required when SHIPBOB_ACCESS_TOKEN is set)`,
        );
      }
    }

    validateGid(process.env.SHOPIFY_LOCATION_ID_US!, "SHOPIFY_LOCATION_ID_US");
    validateGid(process.env.SHOPIFY_LOCATION_ID_EU!, "SHOPIFY_LOCATION_ID_EU");
    validateGid(process.env.SHOPIFY_LOCATION_ID_AU!, "SHOPIFY_LOCATION_ID_AU");

    shipbob = {
      accessToken: process.env.SHIPBOB_ACCESS_TOKEN,
      baseUrl: process.env.SHIPBOB_BASE_URL || "https://api.shipbob.com/1.0",
      usWarehouseId: process.env.SHIPBOB_US_WAREHOUSE_ID!,
      euWarehouseId: process.env.SHIPBOB_EU_WAREHOUSE_ID!,
      auWarehouseId: process.env.SHIPBOB_AU_WAREHOUSE_ID!,
      shopifyLocationIdUs: process.env.SHOPIFY_LOCATION_ID_US!,
      shopifyLocationIdEu: process.env.SHOPIFY_LOCATION_ID_EU!,
      shopifyLocationIdAu: process.env.SHOPIFY_LOCATION_ID_AU!,
    };
  }

  // Order config is optional — null when not configured
  let order: OrderConfig | null = null;
  if (process.env.COUNTRY_WAREHOUSE_MAPPING) {
    order = {
      pollSchedule: process.env.ORDER_POLL_SCHEDULE || "*/10 * * * *",
      pollEnabled: process.env.ORDER_POLL_ENABLED !== "false",
      trackingSyncSchedule:
        process.env.TRACKING_SYNC_SCHEDULE || "*/30 * * * *",
      trackingSyncEnabled: process.env.TRACKING_SYNC_ENABLED !== "false",
      countryWarehouseMapping: process.env.COUNTRY_WAREHOUSE_MAPPING,
    };
  }

  const namespaced: NamespacedConfig = { core, fulfillmen, shipbob, order };
  global.__namespacedConfig__ = deepFreeze(namespaced);

  // Build flat config (backwards compatible)
  global.__appConfig__ = Object.freeze({
    fulfillmenApiKey: fulfillmen.apiKey,
    fulfillmenBaseUrl: fulfillmen.baseUrl,
    fulfillmenStorage: fulfillmen.storage,
    shopifyStoreDomain: core.shopifyStoreDomain,
    shopifyAccessToken: core.shopifyAccessToken,
    shopifyLocationId: fulfillmen.shopifyLocationId,
    cronSchedule: core.cronSchedule,
    cronEnabled: core.cronEnabled,
    syncStaleTimeoutMinutes: core.syncStaleTimeoutMinutes,
    triggerSyncSecret: core.triggerSyncSecret,
    databaseUrl: core.databaseUrl,
    nodeEnv: core.nodeEnv,
    port: core.port,
  });

  const mode = shipbob && order ? "full" : shipbob ? "inventory-multi-warehouse" : "inventory-only";
  console.log(
    JSON.stringify({
      level: "info",
      timestamp: new Date().toISOString(),
      message: `Config loaded in ${mode} mode`,
      shipbob: !!shipbob,
      orderFeatures: !!order,
    }),
  );
}

export function getConfig(): AppConfig {
  if (!global.__appConfig__) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return global.__appConfig__;
}

export function getNamespacedConfig(): NamespacedConfig {
  if (!global.__namespacedConfig__) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return global.__namespacedConfig__;
}
