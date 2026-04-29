import { PrismaClient, WarehouseProvider, WarehouseRegion } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const shipbobConfigured = !!process.env.SHIPBOB_ACCESS_TOKEN;

  const cnLocationId =
    process.env.SHOPIFY_LOCATION_ID_CN ||
    process.env.SHOPIFY_LOCATION_ID ||
    "PLACEHOLDER";

  const warehouses = [
    {
      name: "ShipBob US",
      provider: WarehouseProvider.SHIPBOB,
      region: WarehouseRegion.US,
      shopifyLocationId: process.env.SHOPIFY_LOCATION_ID_US || "PLACEHOLDER",
      isActive: shipbobConfigured,
      isFallback: false,
    },
    {
      name: "ShipBob EU",
      provider: WarehouseProvider.SHIPBOB,
      region: WarehouseRegion.EU,
      shopifyLocationId: process.env.SHOPIFY_LOCATION_ID_EU || "PLACEHOLDER",
      isActive: shipbobConfigured,
      isFallback: false,
    },
    {
      name: "ShipBob AU",
      provider: WarehouseProvider.SHIPBOB,
      region: WarehouseRegion.AU,
      shopifyLocationId: process.env.SHOPIFY_LOCATION_ID_AU || "PLACEHOLDER",
      isActive: shipbobConfigured,
      isFallback: false,
    },
    {
      name: "Fulfillmen China",
      provider: WarehouseProvider.FULFILLMEN,
      region: WarehouseRegion.CN,
      shopifyLocationId: cnLocationId,
      isActive: true,
      isFallback: true,
    },
  ];

  for (const wh of warehouses) {
    await prisma.warehouse.upsert({
      where: { region: wh.region },
      update: {
        name: wh.name,
        shopifyLocationId: wh.shopifyLocationId,
        isActive: wh.isActive,
        isFallback: wh.isFallback,
      },
      create: wh,
    });
    console.log(`Upserted warehouse: ${wh.name} (${wh.region})`);
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
