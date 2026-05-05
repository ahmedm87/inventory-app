export const SHIPBOB_US_COUNTRIES = ["US"] as const;

export const SHIPBOB_EU_COUNTRIES = [
  "AT",
  "BE",
  "HR",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "HU",
  "IS",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "CH",
] as const;

export const FULFILLMEN_ONLY_COUNTRIES = [
  "GB",
  "CA",
  "HK",
  "IL",
  "NZ",
  "SG",
  "MO",
  "AD",
  "MY",
  "JP",
  "JE",
  "FO",
  "GG",
  "MK",
  "GE",
  "AX",
  "GR",
  "RS",
  "BA",
  "XK",
  "CY",
  "BG",
  "GI",
  "IM",
  "AL",
  "LI",
  "MT",
  "MC",
  "ME",
  "SM",
  "VA",
] as const;

export const DEFAULT_COUNTRY_WAREHOUSE_MAPPING = [
  ...SHIPBOB_US_COUNTRIES.map((countryCode) => `${countryCode}:US`),
  ...SHIPBOB_EU_COUNTRIES.map((countryCode) => `${countryCode}:EU`),
].join(";");

export function hasFulfillmenBackupForCountry(countryCode: string): boolean {
  return SHIPBOB_EU_COUNTRIES.includes(
    countryCode.toUpperCase() as (typeof SHIPBOB_EU_COUNTRIES)[number],
  );
}
