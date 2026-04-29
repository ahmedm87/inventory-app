import { getShopifyClient } from "~/shopify.server.js";

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level, timestamp: new Date().toISOString(), component: "shopify-fulfillment", message, ...extra }),
  );
}

const FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            status
            assignedLocation {
              location {
                id
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createShopifyFulfillment(params: {
  shopifyOrderId: string;
  trackingNumber: string;
  carrier: string;
  locationId: string;
}): Promise<void> {
  const client = getShopifyClient();

  // Get fulfillment orders for this order
  const foResponse = await client.request(FULFILLMENT_ORDERS_QUERY, {
    variables: { orderId: params.shopifyOrderId },
  });

  const foData = foResponse.data as {
    order: {
      fulfillmentOrders: {
        edges: Array<{
          node: {
            id: string;
            status: string;
            assignedLocation: { location: { id: string } };
          };
        }>;
      };
    };
  };

  const fulfillmentOrders = foData.order.fulfillmentOrders.edges
    .map((e) => e.node)
    .filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");

  if (fulfillmentOrders.length === 0) {
    log("info", "No open fulfillment orders found, order may already be fulfilled", {
      shopifyOrderId: params.shopifyOrderId,
    });
    return;
  }

  for (const fo of fulfillmentOrders) {
    try {
      const response = await client.request(FULFILLMENT_CREATE_MUTATION, {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [
              { fulfillmentOrderId: fo.id },
            ],
            trackingInfo: {
              number: params.trackingNumber,
              company: params.carrier,
            },
            notifyCustomer: true,
          },
        },
      });

      const data = response.data as {
        fulfillmentCreateV2: {
          fulfillment: { id: string; status: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      if (data.fulfillmentCreateV2.userErrors.length > 0) {
        const errors = data.fulfillmentCreateV2.userErrors;
        const alreadyFulfilled = errors.some((e) =>
          e.message.toLowerCase().includes("already been fulfilled"),
        );
        if (alreadyFulfilled) {
          log("info", "Order already fulfilled in Shopify", {
            shopifyOrderId: params.shopifyOrderId,
          });
          return;
        }
        log("error", "Shopify fulfillment creation error", {
          shopifyOrderId: params.shopifyOrderId,
          errors,
        });
        throw new Error(
          `Shopify fulfillment errors: ${errors.map((e) => e.message).join("; ")}`,
        );
      }

      log("info", "Created Shopify fulfillment", {
        shopifyOrderId: params.shopifyOrderId,
        fulfillmentId: data.fulfillmentCreateV2.fulfillment?.id,
        trackingNumber: params.trackingNumber,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("already been fulfilled")) {
        return;
      }
      throw err;
    }
  }
}
