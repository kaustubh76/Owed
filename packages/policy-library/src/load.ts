import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MerchantPolicy, MerchantPolicySchema } from "./schema.js";

export class PolicyLibrary {
  readonly #byMerchant: Map<string, MerchantPolicy>;

  constructor(policies: readonly MerchantPolicy[]) {
    this.#byMerchant = new Map(policies.map((policy) => [policy.merchant, policy]));
  }

  get(merchant: string): MerchantPolicy | undefined {
    return this.#byMerchant.get(merchant);
  }

  all(): MerchantPolicy[] {
    return [...this.#byMerchant.values()];
  }

  merchants(): string[] {
    return [...this.#byMerchant.keys()].sort();
  }
}

export class PolicyParseError extends Error {}

/** Parse and validate. A malformed policy is rejected, never partially trusted. */
export function parsePolicies(raw: readonly unknown[], origin = "policy"): PolicyLibrary {
  return new PolicyLibrary(
    raw.map((entry, index) => {
      const parsed = MerchantPolicySchema.safeParse(entry);
      if (!parsed.success) {
        throw new PolicyParseError(
          `${origin}[${index}] is not a valid merchant policy: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    }),
  );
}

/**
 * Load every `.json` in a directory.
 *
 * Adding a merchant is dropping in a file — no code change — which is what makes this
 * a library rather than a hard-coded table.
 */
export function loadPolicyDirectory(directory: string): PolicyLibrary {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return parsePolicies(
    files.map((name) => JSON.parse(readFileSync(join(directory, name), "utf8"))),
    directory,
  );
}

export const BUILTIN_POLICY_DIRECTORY = fileURLToPath(new URL("../policies/", import.meta.url));

let cached: PolicyLibrary | undefined;

/** The policies shipped with this package. */
export function builtinPolicies(): PolicyLibrary {
  cached ??= loadPolicyDirectory(BUILTIN_POLICY_DIRECTORY);
  return cached;
}
