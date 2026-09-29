# @owed/extractor

**Reads promises out of merchant email. Rules, not a model.**

Apache-2.0. Part of [Owed](../../readme.md), and useful on its own.

---

## The idea

A merchant tells you something: *"Your parcel will be delivered tomorrow between 1 and
5pm."* That is a commitment with a shape — a kind, a window, a merchant — and once it has
that shape a machine can notice when it is broken.

```ts
import { extractPromises } from "@owed/extractor";

extractPromises({
  id: "msg_8841",
  merchant: "Northwind Parcel",
  received_at: "2026-10-10T21:15:00-07:00",
  utc_offset: "-07:00",
  subject: "Delivery scheduled",
  body: "Your order is out for delivery and will arrive tomorrow between 1 and 5pm.",
});
// [{
//   kind: "delivery_window",
//   confidence: 0.95,
//   window: { start: "2026-10-11T20:00:00.000Z", end: "2026-10-12T00:00:00.000Z" },
//   evidence_text: "Your order is out for delivery and will arrive tomorrow between 1 and 5pm.",
// }]
```

Seven kinds: `delivery_window`, `eta`, `refund_sla`, `appointment_slot`, `guarantee`,
`price_match`, `warranty`.

## How it reads a sentence

Not seven regexes fired at the text. It finds **time expressions** first — ranges,
deadlines, durations — and then decides what each one belongs to from the words around it,
because "between 1 and 5" is a delivery window, an engineer's visit or a shop's opening
hours depending entirely on its neighbours.

Two rules do most of the work, and both were learned the hard way:

- **A cue before the clock beats one after it**, however far away. English puts the
  subject first: *"your refund will arrive within 7 days"* is about a refund, while
  *"arriving by 4pm, and we'll credit you"* is about an arrival with a remark after it. A
  window that looked both ways read the second as a refund promise.
- **A word that can only mean one thing outranks a nearer word that could mean several.**
  *"Our engineer will arrive between 10am and 2pm"* has a generic verb next to the clock
  and the noun that settles it further back. Pure nearness read it as a parcel.

## Every extraction cites its source

`evidence_text` is the sentence the rules matched, and it is not decoration. A promise a
household cannot trace back to words somebody actually wrote them is a promise the
extractor invented. Owed quotes it on the card, under *they wrote*.

## What it costs you to not use a model

Measured, on a 120-message labelled corpus and on **40 held-out messages the extractor has
never been run against**:

| | precision | recall |
|---|---|---|
| tuned corpus | 100.0% | 99.0% |
| **held out** | **73.7%** | **58.3%** |

The first number measures a fit — the rules were changed three times in response to the
corpus they are scored against. The second is the honest one: **four promises found in
seven, and one in four of the things it reports is wrong.** Full write-up, including which
nine messages it missed and why, in [`eval/README.md`](../../eval/README.md).

Use it where determinism, auditability and running offline matter more than coverage. It
is a reasonable first pass and a poor last word.

## Known limits, stated rather than discovered

- **Fixed UTC offsets, not timezones.** "Tuesday at 1pm" in Los Angeles is a different
  instant in March than in December. Every input carries the offset its merchant writes
  in; a real deployment needs a timezone database.
- **Day-level deadlines are not read.** "With you by Wednesday" and "should arrive by 9
  October" are missed — it wants a clock.
- **Vocabulary is the ceiling.** A rule extractor is exactly as good as its cue words, and
  the held-out misses are mostly ordinary English it had never been shown.
- **English only.**
