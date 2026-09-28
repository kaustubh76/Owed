import * as z from "zod/v4";
import { PROTOCOL_VERSION, RecourseMessageSchema } from "./messages.js";

/**
 * JSON Schema for the five messages, generated from the zod definitions.
 *
 * Generated rather than hand-written so the specification and the code cannot drift,
 * and published so an implementation in any language can validate against the same
 * definitions we do.
 */
export function recourseJsonSchema(): Record<string, unknown> {
  return {
    $id: `https://owed.dev/schema/${PROTOCOL_VERSION}.json`,
    title: "Recourse protocol v1",
    description:
      "Agent-to-agent dispute resolution between a household's agent and a merchant's agent.",
    ...(z.toJSONSchema(RecourseMessageSchema) as Record<string, unknown>),
  };
}
