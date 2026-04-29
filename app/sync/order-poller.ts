import { prisma } from "~/db.server.js";
import { getShopifyClient } from "~/shopify.server.js";
import { syncLog } from "~/sync/sync-logger.js";
import type { Order } from "@prisma/client";

const ORDERS_QUERY = `
  query GetUnfulfilledOrders($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $query) {
      edges {
        node {
          id
          name
          createdAt
          shippingAddress {
            countryCode
          }
          email
          lineItems(first: 100) {
            edges {
              node {
                id
                sku
                quantity
                title
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  shippingAddress: { countryCode: string } | null;
  email: string | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        sku: string | null;
        quantity: number;
        title: string;
      };
    }>;
  };
}

const DEFAULT_LOOKBACK_HOURS = 24;

export async function pollNewOrders(): Promise<Order[]> {
  const client = getShopifyClient();

  // Get last poll timestamp
  const lastPollRecord = await prisma.appConfig.findUnique({
    where: { key: "lastOrderPollAt" },
  });

  const since = lastPollRecord
    ? new Date(lastPollRecord.value)
    : new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000);

  const queryStr = `fulfillment_status:unfulfilled created_at:>'${since.toISOString()}'`;
  const newOrders: Order[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = await client.request(ORDERS_QUERY, {
      variables: { query: queryStr, cursor },
    });

    const data = response.data as {
      orders: {
        edges: Array<{ node: ShopifyOrderNode }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };

    for (const edge of data.orders.edges) {
      const node = edge.node;

      const lineItems = node.lineItems.edges
        .filter((li) => li.node.sku)
        .map((li) => ({
          sku: li.node.sku!,
          quantity: li.node.quantity,
          productTitle: li.node.title,
          shopifyLineItemId: li.node.id,
        }));

      if (lineItems.length === 0) continue;

      try {
        const order = await prisma.order.create({
          data: {
            shopifyOrderId: node.id,
            shopifyOrderNumber: node.name,
            processingStatus: "PENDING",
            destinationCountryCode:
              node.shippingAddress?.countryCode ?? null,
            customerEmail: node.email ?? null,
            totalLineItems: lineItems.length,
            lineItems: {
              create: lineItems,
            },
          },
        });
        newOrders.push(order);
      } catch (err) {
        // Unique constraint violation — order already exists
        if (
          err instanceof Error &&
          err.message.includes("Unique constraint")
        ) {
          syncLog("info", "Order already exists, skipping", {
            shopifyOrderId: node.id,
          });
          continue;
        }
        throw err;
      }
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }

  // Update last poll timestamp
  await prisma.appConfig.upsert({
    where: { key: "lastOrderPollAt" },
    update: { value: new Date().toISOString() },
    create: { key: "lastOrderPollAt", value: new Date().toISOString() },
  });

  syncLog("info", `Polled ${newOrders.length} new orders from Shopify`);
  return newOrders;
}
