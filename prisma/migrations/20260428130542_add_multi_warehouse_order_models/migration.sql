-- CreateEnum
CREATE TYPE "WarehouseProvider" AS ENUM ('FULFILLMEN', 'SHIPBOB');

-- CreateEnum
CREATE TYPE "WarehouseRegion" AS ENUM ('US', 'EU', 'AU', 'CN');

-- CreateEnum
CREATE TYPE "OrderProcessingStatus" AS ENUM ('PENDING', 'ASSIGNING', 'ASSIGNED', 'FULFILLMENT_SENT', 'FULFILLED', 'CANCELLED', 'REASSIGNING', 'REASSIGNMENT_FAILED');

-- CreateEnum
CREATE TYPE "FulfillmentRequestStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SHIPPED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "WarehouseProvider" NOT NULL,
    "region" "WarehouseRegion" NOT NULL,
    "shopifyLocationId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderNumber" TEXT,
    "processingStatus" "OrderProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "assignedWarehouseId" TEXT,
    "destinationCountryCode" TEXT,
    "customerEmail" TEXT,
    "totalLineItems" INTEGER NOT NULL DEFAULT 0,
    "assignmentReason" TEXT,
    "assignedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "requiresManualIntervention" BOOLEAN NOT NULL DEFAULT false,
    "manualInterventionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "shopifyLineItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "externalRequestId" TEXT,
    "status" "FulfillmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingUpdate" (
    "id" TEXT NOT NULL,
    "fulfillmentRequestId" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "trackingUrl" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_region_key" ON "Warehouse"("region");

-- CreateIndex
CREATE INDEX "StockLevel_sku_idx" ON "StockLevel"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_warehouseId_sku_key" ON "StockLevel"("warehouseId", "sku");

-- CreateIndex
CREATE INDEX "Order_processingStatus_idx" ON "Order"("processingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopifyOrderId_key" ON "Order"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");

-- CreateIndex
CREATE INDEX "FulfillmentRequest_orderId_idx" ON "FulfillmentRequest"("orderId");

-- CreateIndex
CREATE INDEX "FulfillmentRequest_status_idx" ON "FulfillmentRequest"("status");

-- CreateIndex
CREATE INDEX "TrackingUpdate_fulfillmentRequestId_idx" ON "TrackingUpdate"("fulfillmentRequestId");

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_assignedWarehouseId_fkey" FOREIGN KEY ("assignedWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentRequest" ADD CONSTRAINT "FulfillmentRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentRequest" ADD CONSTRAINT "FulfillmentRequest_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingUpdate" ADD CONSTRAINT "TrackingUpdate_fulfillmentRequestId_fkey" FOREIGN KEY ("fulfillmentRequestId") REFERENCES "FulfillmentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
