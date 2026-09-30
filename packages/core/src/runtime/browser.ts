import type { AttributeValue } from "@opentelemetry/api";
import { WEB_AI } from "../semantic-conventions/attributes.js";

const NOT_A_BRAND = /[^a-z]/gi;
const CHROMIUM_BRAND = /^chromium$/i;

interface NavigatorUADataBrand {
  brand: string;
  version: string;
}

interface NavigatorUAData {
  brands: NavigatorUADataBrand[];
  getHighEntropyValues: (
    hints: string[]
  ) => Promise<{ fullVersionList?: NavigatorUADataBrand[] }>;
  mobile: boolean;
  platform: string;
}

interface ExtendedNavigator extends Navigator {
  deviceMemory?: number;
  userAgentData?: NavigatorUAData;
}

/**
 * Resource attributes. Values may be promises: OpenTelemetry resolves those
 * before export, which lets callers build a provider synchronously instead of
 * awaiting user-agent data before instrumentation is installed.
 */
export type BrowserResourceAttributes = Record<
  string,
  AttributeValue | Promise<AttributeValue | undefined> | undefined
>;

const isRealBrand = (brand: NavigatorUADataBrand) =>
  brand.brand.replace(NOT_A_BRAND, "").toLowerCase() !== "notabrand";

const pickBrand = (brands: NavigatorUADataBrand[] = []) => {
  const real = brands.filter(isRealBrand);
  return real.find((b) => !CHROMIUM_BRAND.test(b.brand)) ?? real[0];
};

/** Resolves the most precise brand available, never rejecting. */
async function resolveBrand(
  uaData: NavigatorUAData
): Promise<NavigatorUADataBrand | undefined> {
  const fallback = pickBrand(uaData.brands);
  try {
    const { fullVersionList } = await uaData.getHighEntropyValues([
      "fullVersionList",
    ]);
    return pickBrand(fullVersionList) ?? fallback;
  } catch {
    // Keep the low-entropy major version.
    return fallback;
  }
}

/** Browser/runtime resource attributes for the current page load. */
export function browserResourceAttributes(): BrowserResourceAttributes {
  const nav = navigator as ExtendedNavigator;
  const attributes: BrowserResourceAttributes = {
    "browser.language": navigator.language,
    "user_agent.original": navigator.userAgent,
  };

  const { deviceMemory } = nav;
  if (deviceMemory !== undefined && Number.isFinite(deviceMemory)) {
    attributes[WEB_AI.DEVICE_MEMORY_GIB] = deviceMemory;
  }

  const uaData = nav.userAgentData;
  if (!uaData) {
    return attributes;
  }

  attributes["browser.brands"] = uaData.brands.map(
    (b) => `${b.brand} ${b.version}`
  );
  attributes["browser.mobile"] = uaData.mobile;
  attributes["browser.platform"] = uaData.platform;

  const brand = resolveBrand(uaData);
  attributes[WEB_AI.BROWSER_NAME] = brand.then((b) => b?.brand);
  attributes[WEB_AI.BROWSER_VERSION] = brand.then((b) => b?.version);

  return attributes;
}
