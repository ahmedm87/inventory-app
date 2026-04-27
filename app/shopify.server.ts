import { createAdminApiClient } from "@shopify/admin-api-client";
import { getConfig } from "~/config/app-config.js";

let client: ReturnType<typeof createAdminApiClient> | null = null;

export function getShopifyClient() {
  if (!client) {
    const config = getConfig();
    client = createAdminApiClient({
      storeDomain: config.shopifyStoreDomain,
      accessToken: config.shopifyAccessToken,
      apiVersion: "2025-07",
    });
  }
  return client;
}
