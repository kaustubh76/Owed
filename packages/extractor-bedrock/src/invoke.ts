/**
 * The one thing in this package that talks to anything.
 *
 * A port, for the same reason `MerchantDirectory` is one: the real adapter reaches a
 * network service, and everything built on top of it has to be testable without that
 * service existing. Prompt construction and reply parsing are the whole substance of a
 * model-backed extractor, and neither needs a model to check — so they sit on this side of
 * the line and get real tests, while the Bedrock call sits on the other side in
 * `bedrock.ts` and is the only file here that cannot be verified offline.
 *
 * Deliberately a bare function rather than an interface with one method. There is one
 * operation, the model is stateless between calls, and a test double is then a two-line
 * function rather than an object pretending to be a client. This repo has no `vi.mock` or
 * `vi.fn` anywhere; substitution is always a real implementation behind a port, and a
 * function is the smallest port that does the job.
 */
export type Invoke = (prompt: string) => Promise<string>;
