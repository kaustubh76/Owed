import type { Instant } from "@owed/domain";
import { normalizeInstant } from "@owed/domain";
import type { LabelledMessage } from "./corpus.js";

/**
 * Forty messages the extractor has never been run against.
 *
 * The corpus next door stopped being evidence the moment the extractor was changed in
 * response to it. Three rounds of fixing what it found took the score from 95.7/87.1 to
 * 100/99, and a number reached that way measures a fit, not an ability.
 *
 * So this set is written afterwards, deliberately in voices the first corpus does not
 * use — clipped courier SMS, a formal letter, a pharmacy, a garage, a ticket agency, a
 * telecoms provider — run **once**, and reported whatever it says. Nothing in the
 * extractor may be changed because of it. If something here fails, the honest move is to
 * write it down, because the first corpus already shows what happens otherwise.
 */
const RECEIVED: Instant = normalizeInstant("2026-10-05T09:00:00-07:00");
const OFFSET = "-07:00";

const on = (dayOffset: number, hour: number, minute = 0): Instant =>
  normalizeInstant(
    `2026-10-${String(5 + dayOffset).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${OFFSET}`,
  );

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number): Instant =>
  normalizeInstant(new Date(Date.parse(RECEIVED) + days * DAY_MS).toISOString());

function held(
  id: string,
  subject: string,
  body: string,
  expected: LabelledMessage["expected"],
  note: string,
): LabelledMessage {
  return {
    set: "authored",
    input: {
      id,
      merchant: "Held-out Merchant",
      received_at: RECEIVED,
      utc_offset: OFFSET,
      subject,
      body,
    },
    expected,
    note,
  };
}

export function heldOutMessages(): LabelledMessage[] {
  return [
    // --- clipped, the way a courier texts ------------------------------
    held(
      "h_01",
      "Delivery",
      "Yr parcel arrives between 2 and 6pm tomorrow. No need to be in.",
      [{ kind: "delivery_window", window: { start: on(1, 14), end: on(1, 18) } }],
      "SMS abbreviations around a normal window",
    ),
    held(
      "h_02",
      "DPD",
      "Out for delivery. Est. arrival by 4:20pm today.",
      [{ kind: "eta", deadline: on(0, 16, 20) }],
      "abbreviated 'Est.'",
    ),
    held(
      "h_03",
      "Delivery",
      "Driver 20 mins away. With you by 11:45am.",
      [{ kind: "eta", deadline: on(0, 11, 45) }],
      "a duration and a deadline, no verb",
    ),
    held(
      "h_04",
      "Slot",
      "Tues 9-11am. Reply CHANGE to move it.",
      [{ kind: "delivery_window", window: { start: on(1, 9), end: on(1, 11) } }],
      "abbreviated weekday, no cue noun",
    ),

    // --- a formal letter ----------------------------------------------
    held(
      "h_05",
      "Your recent order",
      "Dear Ms Okafor,\n\nThank you for your order. We write to confirm that delivery will take place on Thursday 8 October between the hours of 2pm and 6pm.\n\nYours sincerely,\nCustomer Services",
      [{ kind: "delivery_window", window: { start: on(3, 14), end: on(3, 18) } }],
      "'between the hours of'",
    ),
    held(
      "h_06",
      "Refund notification",
      "Dear Customer,\n\nFollowing your cancellation we confirm that a refund of $128.00 will be remitted to the original payment method no later than 14 days from today.\n\nRegards",
      [{ kind: "refund_sla", deadline: inDays(14) }],
      "'remitted', 'no later than N days'",
    ),
    held(
      "h_07",
      "Guarantee of service",
      "We undertake to complete the works on Friday between 8am and 1pm. Should we fail to attend within this period, the call-out fee will be waived.",
      [
        { kind: "appointment_slot", window: { start: on(4, 8), end: on(4, 13) } },
        { kind: "guarantee", window: { start: on(4, 8), end: on(4, 13) } },
      ],
      "formal guarantee, remedy phrased as a waiver",
    ),

    // --- a pharmacy ---------------------------------------------------
    held(
      "h_08",
      "Prescription ready",
      "Your prescription is ready to collect. The pharmacy is open 8am to 7pm today.",
      [],
      "opening hours, nothing promised",
    ),
    held(
      "h_09",
      "Repeat prescription",
      "Your repeat order will be delivered tomorrow between 10am and 2pm.",
      [{ kind: "delivery_window", window: { start: on(1, 10), end: on(1, 14) } }],
      "pharmacy delivery",
    ),
    held(
      "h_10",
      "Consultation",
      "Your pharmacist consultation is booked for Wednesday between 3 and 4pm.",
      [{ kind: "appointment_slot", window: { start: on(2, 15), end: on(2, 16) } }],
      "consultation as an appointment",
    ),

    // --- a garage -----------------------------------------------------
    held(
      "h_11",
      "MOT booking",
      "Your MOT is booked in for Wednesday between 8am and 10am. Please drop the car off in good time.",
      [{ kind: "appointment_slot", window: { start: on(2, 8), end: on(2, 10) } }],
      "'booked in for' with no engineer noun",
    ),
    held(
      "h_12",
      "Work completed",
      "The repair is done and comes with a 12 month parts and labour guarantee.",
      [{ kind: "warranty", window: { start: RECEIVED, end: inDays(360) } }],
      "'guarantee' meaning warranty",
    ),
    held(
      "h_13",
      "Your car",
      "Ready for collection any time after 3pm. We close at 6.",
      [],
      "collection availability, not a promise with a deadline",
    ),

    // --- tickets ------------------------------------------------------
    held(
      "h_14",
      "Refund for cancelled show",
      "The performance was cancelled. Refunds are issued automatically and take up to 21 days.",
      [{ kind: "refund_sla", deadline: inDays(21) }],
      "'take up to N days'",
    ),
    held(
      "h_15",
      "Your tickets",
      "Doors open at 7pm and the show starts at 7:30pm.",
      [],
      "event times, not promises to this household",
    ),
    held(
      "h_16",
      "Delivery of tickets",
      "Physical tickets will be posted and should arrive by 9 October.",
      [{ kind: "eta", deadline: on(4, 0) }],
      "a deadline that is a date with no clock",
    ),

    // --- telecoms -----------------------------------------------------
    held(
      "h_17",
      "Engineer appointment",
      "An Openreach engineer will attend between 1pm and 5pm on 7 October. Someone over 18 must be present.",
      [{ kind: "appointment_slot", window: { start: on(2, 13), end: on(2, 17) } }],
      "'attend' rather than visit",
    ),
    held(
      "h_18",
      "Your new router",
      "Your router is on its way and should be with you by Wednesday.",
      [{ kind: "eta", deadline: on(2, 0) }],
      "a day-level deadline",
    ),
    held(
      "h_19",
      "Service credit",
      "We're sorry about the outage. A credit of $15.00 will appear on your next bill within 30 days.",
      [{ kind: "refund_sla", deadline: inDays(30) }],
      "a credit rather than a refund",
    ),
    held(
      "h_20",
      "Broadband speed",
      "Your line is estimated at 67Mbps. Speeds vary between 7am and 11pm.",
      [],
      "a number range that is bandwidth, and hours that promise nothing",
    ),

    // --- furniture and white goods ------------------------------------
    held(
      "h_21",
      "Delivery booked",
      "Your sofa will be delivered on Saturday. Our two-man team will call between 7am and 11am to confirm a slot.",
      [{ kind: "delivery_window", window: { start: on(5, 7), end: on(5, 11) } }],
      "a call window, not the delivery itself — a genuinely ambiguous label",
    ),
    held(
      "h_22",
      "Warranty activated",
      "Your appliance now carries 5 years of cover, and 10 years on the motor.",
      [{ kind: "warranty", window: { start: RECEIVED, end: inDays(1825) } }],
      "two warranty terms, the longer one about a component",
    ),
    held(
      "h_23",
      "Price promise",
      "Seen it cheaper? Tell us up to 28 days after purchase and we'll refund the difference.",
      [{ kind: "price_match", window: { start: RECEIVED, end: inDays(28) } }],
      "'up to N days after'",
    ),
    held(
      "h_24",
      "Assembly",
      "Our fitters will assemble everything. They'll be with you between 9 and 12 on Monday.",
      [{ kind: "appointment_slot", window: { start: on(7, 9), end: on(7, 12) } }],
      "a bare range with no meridiem on either end",
    ),

    // --- groceries and food -------------------------------------------
    held(
      "h_25",
      "Your grocery order",
      "Your slot is confirmed for tomorrow, 6pm to 7pm. Substitutions are allowed unless you opt out.",
      [{ kind: "delivery_window", window: { start: on(1, 18), end: on(1, 19) } }],
      "'slot is confirmed for'",
    ),
    held(
      "h_26",
      "Takeaway",
      "Order accepted. Estimated 35-45 minutes.",
      [],
      "a duration in minutes, which is not one of the units",
    ),
    held(
      "h_27",
      "Late order",
      "Sorry, we're running behind. Your food will be with you by 8:40pm or the delivery fee is on us.",
      [{ kind: "guarantee", deadline: on(0, 20, 40) }],
      "remedy with no word 'guarantee' anywhere",
    ),
    held(
      "h_28",
      "Freshness",
      "All our bread is baked within 12 hours of delivery.",
      [],
      "a duration about the merchant's process",
    ),

    // --- financial and admin ------------------------------------------
    held(
      "h_29",
      "Chargeback",
      "We've raised a dispute with the merchant. They have 45 days to respond.",
      [],
      "a deadline binding somebody else",
    ),
    held(
      "h_30",
      "Statement ready",
      "Your October statement is available. Payment is due within 21 days.",
      [],
      "a deadline binding the household, not the merchant",
    ),
    held(
      "h_31",
      "Compensation",
      "We accept the delay was ours. $50.00 will be paid to you within 7 working days.",
      [{ kind: "refund_sla", deadline: inDays(7) }],
      "compensation phrased as a payment",
    ),

    // --- messages designed to look like promises and not be -----------
    held(
      "h_32",
      "Flash sale",
      "24 hours only! Everything reduced until midnight tomorrow.",
      [],
      "a sale deadline, not a promise to the household",
    ),
    held(
      "h_33",
      "Recruitment",
      "We're hiring drivers. Shifts run 6am to 2pm and 2pm to 10pm.",
      [],
      "shift patterns",
    ),
    held(
      "h_34",
      "Your review",
      "Thanks! Reviews are published within 2 working days.",
      [],
      "a process time, not a commitment about an order",
    ),
    held(
      "h_35",
      "Recall notice",
      "If you bought this product between 1 March and 30 June, please stop using it.",
      [],
      "a date range about the past",
    ),
    held(
      "h_36",
      "Loyalty points",
      "You earned 340 points. They expire 12 months from today.",
      [],
      "an expiry, not something owed",
    ),
    held(
      "h_37",
      "Delivery attempted",
      "We called at 11:20am but couldn't get an answer. Card left.",
      [],
      "a past attempt with a precise time",
    ),
    held(
      "h_38",
      "Two-factor",
      "Your code is 4821 and is valid for 10 minutes.",
      [],
      "a code that looks like a time and a duration in minutes",
    ),
    held(
      "h_39",
      "Christmas cut-off",
      "Order by 18 December for delivery before the 24th.",
      [],
      "a conditional offer, not yet a promise about an order",
    ),
    held(
      "h_40",
      "Survey reminder",
      "You have 7 days left to tell us how we did.",
      [],
      "a deadline binding the household",
    ),
  ];
}
