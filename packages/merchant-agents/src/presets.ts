import { COOPERATIVE, type MerchantConfig, STINGY, STONEWALLING } from "./behaviour.js";

/**
 * The four merchants in the seeded week.
 *
 * Calder & Co. is configured per breach kind because that is what is actually true of
 * merchants: its price promise is mechanical and settles on request, while its refund
 * timing is contested. One agent, two postures.
 */
export const STORYBOARD_MERCHANTS: readonly MerchantConfig[] = [
  {
    merchant: "Northwind Parcel",
    behaviour: STINGY,
    escalation_route: "Northwind Parcel delivery claims",
  },
  {
    merchant: "Meridian Rides",
    behaviour: COOPERATIVE,
    escalation_route: "Meridian Rides support",
  },
  {
    merchant: "Alder Home Services",
    behaviour: COOPERATIVE,
    escalation_route: "Alder Home Services bookings",
  },
  {
    merchant: "Calder & Co.",
    behaviour: COOPERATIVE,
    by_breach_kind: { late_refund: STONEWALLING },
    escalation_route: "Calder & Co. customer relations",
  },
];

export function storyboardMerchant(name: string): MerchantConfig | undefined {
  return STORYBOARD_MERCHANTS.find((config) => config.merchant === name);
}
