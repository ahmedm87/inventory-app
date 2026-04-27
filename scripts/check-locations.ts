import { config as loadEnv } from "dotenv";
loadEnv();

import { createAdminApiClient } from "@shopify/admin-api-client";

const client = createAdminApiClient({
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN!,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN!,
  apiVersion: "2025-07",
});

const res = await client.request(`
  query {
    locations(first: 10) {
      edges {
        node {
          id
        }
      }
    }
  }
`);

const data = res.data as { locations: { edges: Array<{ node: { id: string } }> } };
console.log("Shopify locations:");
for (const edge of data.locations.edges) {
  console.log(" ", edge.node.id);
}

console.log("\nConfigured:", process.env.SHOPIFY_LOCATION_ID);
const match = data.locations.edges.some(e => e.node.id === process.env.SHOPIFY_LOCATION_ID);
console.log("Match:", match ? "YES" : "NO - location ID is wrong!");
