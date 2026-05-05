import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseCountryMapping } from "~/sync/country-mapping.js";
import {
  DEFAULT_COUNTRY_WAREHOUSE_MAPPING,
  FULFILLMEN_ONLY_COUNTRIES,
  hasFulfillmenBackupForCountry,
} from "~/sync/shipping-rules.js";

describe("country-mapping", () => {
  it("parses valid mapping string", () => {
    const map = parseCountryMapping("US:US;CA:US;GB:EU;DE:EU;AU:AU");
    expect(map.get("US")).toBe("US");
    expect(map.get("CA")).toBe("US");
    expect(map.get("GB")).toBe("EU");
    expect(map.get("DE")).toBe("EU");
    expect(map.get("AU")).toBe("AU");
    expect(map.size).toBe(5);
  });

  it("returns empty map for empty string", () => {
    expect(parseCountryMapping("").size).toBe(0);
    expect(parseCountryMapping("  ").size).toBe(0);
  });

  it("handles case-insensitive country codes", () => {
    const map = parseCountryMapping("us:US;gb:EU");
    expect(map.get("US")).toBe("US");
    expect(map.get("GB")).toBe("EU");
  });

  it("skips malformed entries", () => {
    const map = parseCountryMapping("US:US;INVALID;GB:EU;:;DE:");
    expect(map.size).toBe(2);
    expect(map.get("US")).toBe("US");
    expect(map.get("GB")).toBe("EU");
  });

  it("uses last-wins for duplicate country codes", () => {
    const map = parseCountryMapping("US:US;US:EU");
    expect(map.get("US")).toBe("EU");
  });

  it("returns null for unmapped country", () => {
    const map = parseCountryMapping("US:US");
    expect(map.get("BR")).toBeUndefined();
  });

  it("maps documented ShipBob countries by default", () => {
    const map = parseCountryMapping(DEFAULT_COUNTRY_WAREHOUSE_MAPPING);
    expect(map.get("US")).toBe("US");
    expect(map.get("AT")).toBe("EU");
    expect(map.get("HR")).toBe("EU");
    expect(map.get("CH")).toBe("EU");
    expect(map.get("GB")).toBeUndefined();
    expect(map.get("CA")).toBeUndefined();
    expect(map.size).toBe(27);
  });

  it("tracks Fulfillmen-only documented countries separately from ShipBob mapping", () => {
    expect(FULFILLMEN_ONLY_COUNTRIES).toContain("GB");
    expect(FULFILLMEN_ONLY_COUNTRIES).toContain("CA");
    expect(FULFILLMEN_ONLY_COUNTRIES).toContain("XK");
    expect(FULFILLMEN_ONLY_COUNTRIES).toContain("VA");
  });

  it("only allows Fulfillmen backup for ShipBob EU countries", () => {
    expect(hasFulfillmenBackupForCountry("DE")).toBe(true);
    expect(hasFulfillmenBackupForCountry("US")).toBe(false);
    expect(hasFulfillmenBackupForCountry("CA")).toBe(false);
  });
});
