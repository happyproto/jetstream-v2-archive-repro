// Nothing secret may reach a results file: credentials, CDN tokens, or key-shaped strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactHeaders, redactUrl, scrubText } from "../src/lib/results.ts";

// Built at runtime so the repo never contains a key-shaped literal.
const FAKE_KEY = ["g", "k_"].join("") + "abcDEF123_-xyz";

test("drops credential headers and redacts the Location token", () => {
  const headers = new Headers([
    ["Authorization", `Bearer ${FAKE_KEY}`],
    ["Set-Cookie", "session=secret"],
    ["Cookie", "a=b"],
    ["Location", "https://cdn.example/blk?segment=s&token=SIGNED.value-1&x=1"],
    ["headwind-quota-burst-bytes", "1000000000"],
  ]);
  assert.deepEqual(redactHeaders(headers), {
    location: "https://cdn.example/blk?segment=s&token=REDACTED&x=1",
    "headwind-quota-burst-bytes": "1000000000",
  });
});

test("redactUrl replaces every token= value, case-insensitively", () => {
  assert.equal(redactUrl("https://x/?Token=abc&token=def#frag"), "https://x/?Token=REDACTED&token=REDACTED#frag");
  assert.equal(redactUrl(undefined), "");
});

test("scrubText removes key-shaped strings and tokens from free text", () => {
  const s = scrubText(`{"auth":"Bearer ${FAKE_KEY}","loc":"https://cdn/?token=zzz"}`);
  assert.equal(s, '{"auth":"Bearer REDACTED_KEY","loc":"https://cdn/?token=REDACTED"}');
});
