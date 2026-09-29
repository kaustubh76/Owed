import type { Instant, Interval, PromiseKind } from "@owed/domain";
import { addMs, interval, normalizeInstant } from "@owed/domain";
import type { ExtractionInput } from "@owed/extractor";
import { instantAt } from "@owed/extractor";

/**
 * One labelled message.
 *
 * `expected` is what a person reading the message would say was promised, written
 * before the extractor was run over it. Where a label carries a window or a deadline,
 * the timing is checked too; where it carries only a kind, only the kind is checked —
 * which is what H1 claims and all it claims.
 */
export interface LabelledMessage {
  /** `generated` is systematic coverage; `authored` is messy prose and negatives. */
  set: "generated" | "authored";
  input: ExtractionInput;
  expected: Array<{ kind: PromiseKind; window?: Interval; deadline?: Instant }>;
  note: string;
}

const OFFSET = "-07:00";
const RECEIVED: Instant = normalizeInstant("2026-10-05T09:00:00-07:00");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The civil day the corpus is written around: Monday 5 October 2026. */
const MONDAY = { year: 2026, month: 10, day: 5 };
const dayAfter = (n: number) => ({ year: 2026, month: 10, day: 5 + n });

const on = (dayOffset: number, hour: number, minute = 0): Instant =>
  instantAt(dayAfter(dayOffset), hour, minute, OFFSET);

const windowOn = (dayOffset: number, fromHour: number, toHour: number): Interval =>
  interval(on(dayOffset, fromHour), on(dayOffset, toHour));

const inDays = (days: number): Instant => addMs(RECEIVED, days * DAY_MS);
const coveringDays = (days: number): Interval => interval(RECEIVED, inDays(days));

function message(
  set: "generated" | "authored",
  id: string,
  subject: string,
  body: string,
  expected: LabelledMessage["expected"],
  note: string,
): LabelledMessage {
  return {
    set,
    input: {
      id,
      merchant: "Corpus Merchant",
      received_at: RECEIVED,
      utc_offset: OFFSET,
      subject,
      body,
    },
    expected,
    note,
  };
}

// --- the generated set: systematic coverage of seven kinds -----------------

/**
 * Sixty messages built from templates, so every promise kind meets several phrasings of
 * the same commitment. The templates define the labels, which is legitimate — a template
 * that says "between 1pm and 5pm tomorrow" *is* the ground truth for what it wrote.
 *
 * It is also the easy half. It is reported separately for exactly that reason.
 */
function generated(): LabelledMessage[] {
  const out: LabelledMessage[] = [];
  const g = (
    id: string,
    subject: string,
    body: string,
    expected: LabelledMessage["expected"],
    note: string,
  ) => out.push(message("generated", id, subject, body, expected, note));

  // delivery_window — 9
  g(
    "g_dw_1",
    "Your order is on its way",
    "Your parcel will be delivered tomorrow between 1pm and 5pm.",
    [{ kind: "delivery_window", window: windowOn(1, 13, 17) }],
    "plain window, relative day",
  );
  g(
    "g_dw_2",
    "Out for delivery",
    "Arriving Tuesday between 9 and 11am.",
    [{ kind: "delivery_window", window: windowOn(1, 9, 11) }],
    "bare start hour inherits am",
  );
  g(
    "g_dw_3",
    "Delivery booked",
    "We'll deliver on 8 October between 2pm and 6pm.",
    [{ kind: "delivery_window", window: windowOn(3, 14, 18) }],
    "day and month",
  );
  g(
    "g_dw_4",
    "Delivery update",
    "Your delivery window is 10am to 2pm today.",
    [{ kind: "delivery_window", window: windowOn(0, 10, 14) }],
    "'window' stated outright",
  );
  g(
    "g_dw_5",
    "Shipment scheduled",
    "The courier will drop off your package between 7am and 9am tomorrow.",
    [{ kind: "delivery_window", window: windowOn(1, 7, 9) }],
    "courier phrasing",
  );
  g(
    "g_dw_6",
    "Your parcel",
    "Expect your parcel Wednesday between noon and 4pm.",
    [{ kind: "delivery_window", window: windowOn(2, 12, 16) }],
    "noon as a clock time",
  );
  g(
    "g_dw_7",
    "Delivery confirmed",
    "Delivery is scheduled for October 9 between 8am and midday.",
    [{ kind: "delivery_window", window: windowOn(4, 8, 12) }],
    "American date order, midday",
  );
  g(
    "g_dw_8",
    "On the van",
    "Your order is out for delivery and will arrive between 3 and 7pm.",
    [{ kind: "delivery_window", window: windowOn(0, 15, 19) }],
    "no day named, so today",
  );
  g(
    "g_dw_9",
    "Delivery",
    "DELIVERY BETWEEN 2PM AND 6PM TOMORROW",
    [{ kind: "delivery_window", window: windowOn(1, 14, 18) }],
    "shouting",
  );

  // eta — 9
  g(
    "g_eta_1",
    "Your driver is on the way",
    "Estimated arrival by 6:15pm.",
    [{ kind: "eta", deadline: on(0, 18, 15) }],
    "minutes on the clock",
  );
  g(
    "g_eta_2",
    "On its way",
    "Your ride will arrive by 9pm.",
    [{ kind: "eta", deadline: on(0, 21) }],
    "ride",
  );
  g(
    "g_eta_3",
    "Order shipped",
    "Your parcel will be delivered by 8pm tomorrow.",
    [{ kind: "eta", deadline: on(1, 20) }],
    "single deadline, not a window",
  );
  g(
    "g_eta_4",
    "Nearly there",
    "The driver should reach you by 7:45pm.",
    [{ kind: "eta", deadline: on(0, 19, 45) }],
    "'reach you'",
  );
  g(
    "g_eta_5",
    "Delivery today",
    "Expected arrival before 5pm.",
    [{ kind: "eta", deadline: on(0, 17) }],
    "'before'",
  );
  g(
    "g_eta_6",
    "Your takeaway",
    "Estimated arrival no later than 8:30pm.",
    [{ kind: "eta", deadline: on(0, 20, 30) }],
    "'no later than'",
  );
  g(
    "g_eta_7",
    "On the way",
    "Out for delivery, arriving by midday.",
    [{ kind: "eta", deadline: on(0, 12) }],
    "midday deadline",
  );
  g(
    "g_eta_8",
    "Pickup",
    "Your pick-up is confirmed and the driver will arrive by 10:05am.",
    [{ kind: "eta", deadline: on(0, 10, 5) }],
    "am with minutes",
  );
  g(
    "g_eta_9",
    "Arriving Thursday",
    "Your parcel will arrive by 11am on Thursday.",
    [{ kind: "eta", deadline: on(3, 11) }],
    "named weekday",
  );

  // refund_sla — 9
  g(
    "g_ref_1",
    "Refund started",
    "Your refund will be credited within 7 days.",
    [{ kind: "refund_sla", deadline: inDays(7) }],
    "plain duration",
  );
  g(
    "g_ref_2",
    "Refund on its way",
    "You'll see the money back in 3-5 business days.",
    [{ kind: "refund_sla", deadline: inDays(5) }],
    "range takes the outer bound",
  );
  g(
    "g_ref_3",
    "Return accepted",
    "We'll refund you within 14 days of receiving the item.",
    [{ kind: "refund_sla", deadline: inDays(14) }],
    "fortnight",
  );
  g(
    "g_ref_4",
    "Refund",
    "Your refund will be processed within 10 working days.",
    [{ kind: "refund_sla", deadline: inDays(10) }],
    "working days",
  );
  g(
    "g_ref_5",
    "Returns",
    "You can return anything within 30 days for a full refund.",
    [{ kind: "refund_sla", deadline: inDays(30) }],
    "return window as a refund promise",
  );
  g(
    "g_ref_6",
    "Money back",
    "Reimbursement will reach your account in 21 days.",
    [{ kind: "refund_sla", deadline: inDays(21) }],
    "'reimbursement'",
  );
  g(
    "g_ref_7",
    "Cancelled order",
    "A credit will be applied within 5 days.",
    [{ kind: "refund_sla", deadline: inDays(5) }],
    "'credit'",
  );
  g(
    "g_ref_8",
    "Refund confirmed",
    "The refund is due back within 2 weeks.",
    [{ kind: "refund_sla", deadline: inDays(14) }],
    "weeks",
  );
  g(
    "g_ref_9",
    "Refund",
    "Your money back within 28 days, no questions asked.",
    [{ kind: "refund_sla", deadline: inDays(28) }],
    "'money back'",
  );

  // appointment_slot — 9
  g(
    "g_app_1",
    "Engineer visit",
    "Our technician will call between 2 and 4pm on Thursday.",
    [{ kind: "appointment_slot", window: windowOn(3, 14, 16) }],
    "technician",
  );
  g(
    "g_app_2",
    "Installation booked",
    "Your installation is booked for Friday between 8am and midday.",
    [{ kind: "appointment_slot", window: windowOn(4, 8, 12) }],
    "installer",
  );
  g(
    "g_app_3",
    "Appointment confirmed",
    "Your appointment is tomorrow between 9am and 11am.",
    [{ kind: "appointment_slot", window: windowOn(1, 9, 11) }],
    "the word itself",
  );
  g(
    "g_app_4",
    "Survey",
    "The surveyor will visit on 7 October between 1pm and 3pm.",
    [{ kind: "appointment_slot", window: windowOn(2, 13, 15) }],
    "survey visit",
  );
  g(
    "g_app_5",
    "Boiler service",
    "Our engineer will arrive between 10am and 2pm on Wednesday.",
    [{ kind: "appointment_slot", window: windowOn(2, 10, 14) }],
    "engineer",
  );
  g(
    "g_app_6",
    "Plumber booked",
    "The plumber is due between 4 and 6pm today.",
    [{ kind: "appointment_slot", window: windowOn(0, 16, 18) }],
    "plumber, bare start hour",
  );
  g(
    "g_app_7",
    "Service call",
    "Your service call is scheduled between 7am and 10am tomorrow.",
    [{ kind: "appointment_slot", window: windowOn(1, 7, 10) }],
    "service call",
  );
  g(
    "g_app_8",
    "Fitting",
    "The fitter will come between 11am and 1pm on Friday.",
    [{ kind: "appointment_slot", window: windowOn(4, 11, 13) }],
    "crosses midday",
  );
  g(
    "g_app_9",
    "Electrician",
    "Your electrician will visit between 8 and 10am on 9 October.",
    [{ kind: "appointment_slot", window: windowOn(4, 8, 10) }],
    "electrician with a date",
  );

  // guarantee — 8
  g(
    "g_gua_1",
    "On-time guarantee",
    "Guaranteed to arrive by 8pm or your delivery is free.",
    [{ kind: "guarantee", deadline: on(0, 20) }],
    "classic on-time guarantee",
  );
  g(
    "g_gua_2",
    "Promise",
    "We guarantee delivery by 6pm or it's free.",
    [{ kind: "guarantee", deadline: on(0, 18) }],
    "'or it's free'",
  );
  g(
    "g_gua_3",
    "Guaranteed",
    "Guaranteed before 9pm or we'll refund the delivery fee.",
    [{ kind: "guarantee", deadline: on(0, 21) }],
    "'or we'll refund'",
  );
  g(
    "g_gua_4",
    "Delivery promise",
    "Delivered between 1 and 5pm, guaranteed or your money back.",
    [
      { kind: "delivery_window", window: windowOn(0, 13, 17) },
      { kind: "guarantee", window: windowOn(0, 13, 17) },
    ],
    "guarantee with no clock of its own",
  );
  g(
    "g_gua_5",
    "Guaranteed slot",
    "Your appointment is guaranteed between 9am and 11am tomorrow or the visit is free.",
    [
      { kind: "appointment_slot", window: windowOn(1, 9, 11) },
      { kind: "guarantee", window: windowOn(1, 9, 11) },
    ],
    "guarantee over an appointment",
  );
  g(
    "g_gua_6",
    "Next day promise",
    "We guarantee your parcel by midday tomorrow or your money back.",
    [{ kind: "guarantee", deadline: on(1, 12) }],
    "midday tomorrow",
  );
  g(
    "g_gua_7",
    "Late and it's free",
    "Guaranteed by 7:30pm or the order is free.",
    [{ kind: "guarantee", deadline: on(0, 19, 30) }],
    "'the order is free'",
  );
  g(
    "g_gua_8",
    "Our promise",
    "Arriving by 4pm. Guaranteed or we'll credit you.",
    [
      { kind: "eta", deadline: on(0, 16) },
      { kind: "guarantee", deadline: on(0, 16) },
    ],
    "guarantee borrows the eta",
  );

  // price_match — 8
  g(
    "g_pm_1",
    "Price promise",
    "If the price drops within 14 days we'll refund the difference.",
    [{ kind: "price_match", window: coveringDays(14) }],
    "price drop",
  );
  g(
    "g_pm_2",
    "Price match",
    "Price match guarantee for 30 days from purchase.",
    [{ kind: "price_match", window: coveringDays(30) }],
    "'price match guarantee'",
  );
  g(
    "g_pm_3",
    "Price protection",
    "Price protection applies within 21 days.",
    [{ kind: "price_match", window: coveringDays(21) }],
    "'price protection'",
  );
  g(
    "g_pm_4",
    "Bought it cheaper?",
    "Found it cheaper elsewhere within 7 days? We'll match the price.",
    [{ kind: "price_match", window: coveringDays(7) }],
    "'cheaper elsewhere'",
  );
  g(
    "g_pm_5",
    "Our price promise",
    "Our price promise covers you for 60 days.",
    [{ kind: "price_match", window: coveringDays(60) }],
    "'price promise'",
  );
  g(
    "g_pm_6",
    "If it gets cheaper",
    "If the price goes down in 10 days we'll credit you the difference.",
    [{ kind: "price_match", window: coveringDays(10) }],
    "'price goes down'",
  );
  g(
    "g_pm_7",
    "Price match",
    "We'll match the price if it falls within 2 weeks.",
    [{ kind: "price_match", window: coveringDays(14) }],
    "weeks",
  );
  g(
    "g_pm_8",
    "Price drop refund",
    "Price drop refunds available within 45 days.",
    [{ kind: "price_match", window: coveringDays(45) }],
    "both refund and price words",
  );

  // warranty — 8
  g(
    "g_war_1",
    "Your purchase",
    "Covered by a 2 year warranty.",
    [{ kind: "warranty", window: coveringDays(730) }],
    "years",
  );
  g(
    "g_war_2",
    "Warranty",
    "This item comes with a 12 month warranty.",
    [{ kind: "warranty", window: coveringDays(360) }],
    "months",
  );
  g(
    "g_war_3",
    "Cover",
    "Your warranty runs for 3 years from today.",
    [{ kind: "warranty", window: coveringDays(1095) }],
    "'runs for'",
  );
  g(
    "g_war_4",
    "Registered",
    "Warranty registered: 24 months of cover.",
    [{ kind: "warranty", window: coveringDays(720) }],
    "24 months",
  );
  g(
    "g_war_5",
    "Protected",
    "Your appliance is under warranty for 5 years.",
    [{ kind: "warranty", window: coveringDays(1825) }],
    "5 years",
  );
  g(
    "g_war_6",
    "Warranty card",
    "Manufacturer warranty: 18 months.",
    [{ kind: "warranty", window: coveringDays(540) }],
    "colon form",
  );
  g(
    "g_war_7",
    "Extended cover",
    "Your extended warranty adds 36 months of protection.",
    [{ kind: "warranty", window: coveringDays(1080) }],
    "extended warranty",
  );
  g(
    "g_war_8",
    "Guarantee card",
    "Warranty cover lasts 1 year.",
    [{ kind: "warranty", window: coveringDays(365) }],
    "singular year",
  );

  return out;
}

// --- the authored set: prose, and messages that promise nothing ------------

/**
 * Sixty messages written the way merchants actually write, including twenty-five that
 * promise nothing at all.
 *
 * The negatives are the half that matters. An extractor with no negatives to trip over
 * can reach perfect recall by treating every number as a commitment, and precision is
 * the only thing that catches it. These include the traps a rule-based reader is most
 * likely to fall into: opening hours, sale countdowns, order numbers, quantities,
 * delivery attempts already made, and guarantees with nothing behind them.
 */
function authored(): LabelledMessage[] {
  const out: LabelledMessage[] = [];
  const a = (
    id: string,
    subject: string,
    body: string,
    expected: LabelledMessage["expected"],
    note: string,
  ) => out.push(message("authored", id, subject, body, expected, note));

  // --- prose that does promise something --------------------------------
  a(
    "a_01",
    "Your Thursday delivery",
    "Hi Sam,\n\nGood news — your order #8841-2 has left our depot. The driver expects to be with you on Thursday between 2pm and 6pm. You don't need to be in; we'll leave it in the porch if you're out.\n\nThanks for shopping with us.",
    [{ kind: "delivery_window", window: windowOn(3, 14, 18) }],
    "order number near the window",
  );
  a(
    "a_02",
    "Sorry about the wait",
    "We're really sorry your order was delayed. It's now on the van and should reach you by 7pm this evening. If it doesn't, reply to this email and we'll sort it out.",
    [{ kind: "eta", deadline: on(0, 19) }],
    "apology wrapper",
  );
  a(
    "a_03",
    "Refund confirmation",
    "We've received your return and started the refund. Depending on your bank it can take up to 10 working days to appear on your statement.",
    [{ kind: "refund_sla", deadline: inDays(10) }],
    "'up to' hedging",
  );
  a(
    "a_04",
    "Engineer booking",
    "Your boiler service is booked in. Our engineer Dave will be with you on Wednesday between 10am and 2pm. He'll call ahead about 20 minutes before he arrives.",
    [{ kind: "appointment_slot", window: windowOn(2, 10, 14) }],
    "a second, irrelevant duration in the same message",
  );
  a(
    "a_05",
    "Order 44921 confirmed",
    "Thanks for your order. It's covered by a 2 year warranty, and if the price drops within 30 days we'll refund you the difference.",
    [
      { kind: "warranty", window: coveringDays(730) },
      { kind: "price_match", window: coveringDays(30) },
    ],
    "two promises, different kinds",
  );
  a(
    "a_06",
    "Out for delivery",
    "Your parcel is out for delivery today. Estimated arrival between 11am and 3pm. Track it any time from your account.",
    [{ kind: "delivery_window", window: windowOn(0, 11, 15) }],
    "window under an 'estimated arrival' heading",
  );
  a(
    "a_07",
    "We missed you",
    "We tried to deliver today but nobody was home. We'll try again tomorrow between 9am and 1pm.",
    [{ kind: "delivery_window", window: windowOn(1, 9, 13) }],
    "a failed attempt and a fresh promise",
  );
  a(
    "a_08",
    "Your appointment",
    "This is a reminder that your fitting is on Friday 9 October, between 8am and midday. Please clear the area beforehand.",
    [{ kind: "appointment_slot", window: windowOn(4, 8, 12) }],
    "date and window separated by a comma",
  );
  a(
    "a_09",
    "Refund processed",
    "Your refund of $42.50 has been approved and will be back with you within 5 working days.",
    [{ kind: "refund_sla", deadline: inDays(5) }],
    "an amount to pick up",
  );
  a(
    "a_10",
    "Delivery guarantee",
    "Your order is guaranteed to arrive by 8pm tomorrow. If it's late, the delivery is free.",
    [{ kind: "guarantee", deadline: on(1, 20) }],
    "remedy in a separate sentence",
  );
  a(
    "a_11",
    "Booking confirmed",
    "Thanks for booking. The surveyor will visit between 1 and 3pm on 7 October. Allow about an hour.",
    [{ kind: "appointment_slot", window: windowOn(2, 13, 15) }],
    "bare start hour, then a vague duration",
  );
  a(
    "a_12",
    "Your extended cover",
    "You're now covered for 36 months from the date of purchase. Keep this email for your records.",
    [{ kind: "warranty", window: coveringDays(1080) }],
    "'covered for' without the word warranty",
  );
  a(
    "a_13",
    "Price promise",
    "Bought something and seen it cheaper? Tell us within 14 days and we'll match the price.",
    [{ kind: "price_match", window: coveringDays(14) }],
    "question phrasing",
  );
  a(
    "a_14",
    "Your ride",
    "Your driver Amara is 4 minutes away and should arrive by 9:12pm.",
    [{ kind: "eta", deadline: on(0, 21, 12) }],
    "a duration and a deadline in one line",
  );
  a(
    "a_15",
    "Delivery scheduled",
    "We'll deliver your sofa on 9 October between 7am and 11am. Please make sure someone over 18 is home.",
    [{ kind: "delivery_window", window: windowOn(4, 7, 11) }],
    "an age that is not a time",
  );
  a(
    "a_16",
    "Returns",
    "Changed your mind? You have 28 days to send it back for a full refund.",
    [{ kind: "refund_sla", deadline: inDays(28) }],
    "'you have N days'",
  );
  a(
    "a_17",
    "Two things",
    "Your parcel will be with you by 6pm today, and your refund for the cancelled item will be processed within 7 days.",
    [
      { kind: "eta", deadline: on(0, 18) },
      { kind: "refund_sla", deadline: inDays(7) },
    ],
    "two promises in one sentence",
  );
  a(
    "a_18",
    "Installation",
    "Your installation slot is Wednesday, 10am to 2pm. Our team will need access to the meter cupboard.",
    [{ kind: "appointment_slot", window: windowOn(2, 10, 14) }],
    "'slot is' without 'between'",
  );
  a(
    "a_19",
    "On its way",
    "Dispatched! Expect it between 3 and 7pm tomorrow.",
    [{ kind: "delivery_window", window: windowOn(1, 15, 19) }],
    "two words of context around the window",
  );
  a(
    "a_20",
    "Warranty registration",
    "Your appliance is registered. Cover runs for 5 years and includes parts and labour.",
    [{ kind: "warranty", window: coveringDays(1825) }],
    "'cover runs for'",
  );
  a(
    "a_21",
    "Delivery tomorrow",
    "Hello! Just to confirm, delivery is tomorrow between 12 and 4pm. Our driver will send a text when he's 10 minutes away.",
    [{ kind: "delivery_window", window: windowOn(1, 12, 16) }],
    "bare 12 in a range",
  );
  a(
    "a_22",
    "Sorry, delayed",
    "Your appointment has moved. The engineer will now come between 3pm and 5pm on Thursday instead.",
    [{ kind: "appointment_slot", window: windowOn(3, 15, 17) }],
    "a rescheduled slot",
  );
  a(
    "a_23",
    "Refund started",
    "We've issued your refund. It should land in 3-5 business days, though some banks are slower.",
    [{ kind: "refund_sla", deadline: inDays(5) }],
    "range in business days with a hedge",
  );
  a(
    "a_24",
    "Your order",
    "This order qualifies for our price promise: if it gets cheaper in the next 21 days, we'll credit the difference automatically.",
    [{ kind: "price_match", window: coveringDays(21) }],
    "'in the next N days'",
  );
  a(
    "a_25",
    "Nearly there",
    "Out for delivery. Arriving by 2:45pm.",
    [{ kind: "eta", deadline: on(0, 14, 45) }],
    "short and precise",
  );
  a(
    "a_26",
    "Service visit",
    "Your annual service is booked for Friday between 9 and 11am.",
    [{ kind: "appointment_slot", window: windowOn(4, 9, 11) }],
    "'annual' is not a duration promise",
  );
  a(
    "a_27",
    "Guaranteed",
    "We guarantee your parcel arrives between 1pm and 5pm today, or we'll refund the postage.",
    [
      { kind: "delivery_window", window: windowOn(0, 13, 17) },
      { kind: "guarantee", window: windowOn(0, 13, 17) },
    ],
    "window and guarantee in one sentence",
  );
  a(
    "a_28",
    "Your refund",
    "Cancelled as requested. The money will be back in your account within 2 weeks.",
    [{ kind: "refund_sla", deadline: inDays(14) }],
    "weeks in prose",
  );
  a(
    "a_29",
    "Delivery window",
    "Tomorrow, 8am to 10am. See you then!",
    [{ kind: "delivery_window", window: windowOn(1, 8, 10) }],
    "subject carries the only cue",
  );
  a(
    "a_30",
    "Late delivery guarantee",
    "If your order doesn't arrive by 9pm we'll refund the delivery charge. That's our guarantee.",
    [{ kind: "guarantee", deadline: on(0, 21) }],
    "remedy stated before the word guarantee",
  );
  a(
    "a_31",
    "Warranty",
    "Every product we sell carries 12 months of manufacturer cover as standard.",
    [{ kind: "warranty", window: coveringDays(360) }],
    "no word 'warranty' at all",
  );
  a(
    "a_32",
    "Your visit",
    "The electrician is booked for 6 October between 4 and 6pm.",
    [{ kind: "appointment_slot", window: windowOn(1, 16, 18) }],
    "date before window",
  );
  a(
    "a_33",
    "Refund",
    "Approved. Expect it within 30 days.",
    [{ kind: "refund_sla", deadline: inDays(30) }],
    "one-word context",
  );
  a(
    "a_34",
    "Delivery confirmed",
    "Great news — your order lands Wednesday between 11am and 1pm.",
    [{ kind: "delivery_window", window: windowOn(2, 11, 13) }],
    "'lands' instead of arrives",
  );
  a(
    "a_35",
    "Arriving soon",
    "Your package will be delivered by 4pm on Thursday. No signature needed.",
    [{ kind: "eta", deadline: on(3, 16) }],
    "deadline with a named day",
  );

  // --- messages that promise nothing ------------------------------------
  a(
    "a_n01",
    "Weekend sale!",
    "Up to 50% off everything this weekend. Our stores are open 9am to 5pm all weekend. Sale ends in 3 days.",
    [],
    "opening hours and a countdown, neither a promise",
  );
  a(
    "a_n02",
    "Your receipt",
    "Thanks for shopping with us. Order total $42.50. VAT included.",
    [],
    "a receipt: money, but nothing promised",
  );
  a(
    "a_n03",
    "Password reset",
    "Someone asked to reset your password. If that wasn't you, ignore this email. The link expires in 24 hours.",
    [],
    "an expiring link is not a promise to the household",
  );
  a(
    "a_n04",
    "Order received",
    "We've got your order and we're packing it now. We'll email you when it ships.",
    [],
    "no commitment at all",
  );
  a(
    "a_n05",
    "We missed you",
    "We tried to deliver at 2:15pm today but nobody was in. Your parcel is at the depot.",
    [],
    "a past event, not a future promise",
  );
  a(
    "a_n06",
    "Newsletter",
    "Five ways to make your kitchen feel bigger. Read our guide, and see what's new in store.",
    [],
    "marketing with no times or commitments",
  );
  a(
    "a_n07",
    "Your order shipped",
    "Tracking number GB8841229. Your parcel has left our warehouse.",
    [],
    "a long number and no commitment",
  );
  a(
    "a_n08",
    "Survey",
    "How did we do? Tell us in 2 minutes and get 10% off your next order.",
    [],
    "a duration about the reader, not the merchant",
  );
  a(
    "a_n09",
    "Back in stock",
    "The item you wanted is back. Only 4 left — order before they go.",
    [],
    "urgency without a time",
  );
  a(
    "a_n10",
    "Delivered",
    "Your parcel was delivered at 3:42pm and left with a neighbour at number 12.",
    [],
    "past tense delivery",
  );
  a(
    "a_n11",
    "Card expiring",
    "The card ending 4417 expires in 2 months. Update it to avoid interruption.",
    [],
    "a duration about a card",
  );
  a(
    "a_n12",
    "Membership",
    "Your membership renews on 5 November. You'll be charged $9.99.",
    [],
    "a charge, not a promise to the household",
  );
  a(
    "a_n13",
    "Store hours",
    "We're open 8am to 8pm Monday to Saturday, and 10am to 4pm on Sundays.",
    [],
    "two time ranges, no promise",
  );
  a(
    "a_n14",
    "Thanks for your review",
    "Your review is live. Reviews usually appear within 48 hours of being written.",
    [],
    "a duration about the merchant's website, not a commitment to this household",
  );
  a(
    "a_n15",
    "Guaranteed fresh",
    "All our produce is guaranteed fresh. Shop the range now.",
    [],
    "a guarantee with nothing behind it",
  );
  a(
    "a_n16",
    "Satisfaction guaranteed",
    "Satisfaction guaranteed on every order. Browse now.",
    [],
    "guarantee with no remedy and no clock",
  );
  a(
    "a_n17",
    "Your account",
    "You have 3 unread messages and 2 saved baskets waiting.",
    [],
    "counts that are not durations",
  );
  a(
    "a_n18",
    "Delivery options",
    "Choose standard, next day or nominated day delivery at checkout.",
    [],
    "options offered, nothing promised yet",
  );
  a(
    "a_n19",
    "Price drop alert",
    "An item on your wishlist is now cheaper. Have a look before it goes.",
    [],
    "a price drop that is not a price promise",
  );
  a(
    "a_n20",
    "Invitation",
    "Join us at 7pm on Thursday for the launch of our autumn range.",
    [],
    "an invitation to an event",
  );
  a(
    "a_n21",
    "Order cancelled",
    "Your order has been cancelled as requested. Nothing has been charged.",
    [],
    "cancellation with no refund clock",
  );
  a(
    "a_n22",
    "Warranty claim received",
    "We've received your claim and someone will look at it. Reference WC-2291.",
    [],
    "no timescale given",
  );
  a(
    "a_n23",
    "Referral",
    "Give a friend 20% off and get $10 when they spend $40 in their first 30 days.",
    [],
    "a promotion with a duration about the friend",
  );
  a(
    "a_n24",
    "App update",
    "Version 4.2 is out. Faster search, and delivery tracking in 1 tap.",
    [],
    "release notes",
  );
  a(
    "a_n25",
    "Out of stock",
    "Sorry, one item is out of stock and has been removed from your order.",
    [],
    "bad news with no promise",
  );

  return out;
}

/** The labelled corpus: 120 messages, sixty of each set. */
export function generateExtractionCorpus(): LabelledMessage[] {
  return [...generated(), ...authored()];
}

export const EXTRACTION_PARAMETERS = {
  sets: ["generated", "authored"],
  kinds: [
    "delivery_window",
    "eta",
    "refund_sla",
    "appointment_slot",
    "guarantee",
    "price_match",
    "warranty",
  ],
  messages: 120,
  received_at: RECEIVED,
  utc_offset: OFFSET,
} as const;

export { authored as authoredMessages, generated as generatedMessages, MONDAY };
