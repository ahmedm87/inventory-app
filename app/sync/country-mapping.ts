import { getNamespacedConfig } from "~/config/app-config.js";

let cachedMapping: Map<string, string> | null = null;

function log(level: string, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level, timestamp: new Date().toISOString(), component: "country-mapping", message, ...extra }),
  );
}

export function parseCountryMapping(mappingString: string): Map<string, string> {
  const map = new Map<string, string>();

  if (!mappingString || mappingString.trim() === "") {
    return map;
  }

  const entries = mappingString.split(";").map((e) => e.trim()).filter(Boolean);

  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      log("warn", "Skipping malformed country mapping entry", { entry });
      continue;
    }

    const countryCode = parts[0].trim().toUpperCase();
    const region = parts[1].trim().toUpperCase();
    map.set(countryCode, region);
  }

  return map;
}

export function getWarehouseForCountry(countryCode: string): string | null {
  const config = getNamespacedConfig();
  if (!config.order) {
    return null;
  }

  if (!cachedMapping) {
    cachedMapping = parseCountryMapping(config.order.countryWarehouseMapping);
  }

  return cachedMapping.get(countryCode.toUpperCase()) ?? null;
}

export function clearCountryMappingCache(): void {
  cachedMapping = null;
}
