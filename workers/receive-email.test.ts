// Guard for #12: the built-in AI is off.
// Inbound mail must not trigger the EmailAgent, and the /agents/* WebSocket route
// must not be mounted. The EmailAgent Durable Object class stays exported (removing
// it needs a delete migration that would destroy stored chat history).
// Static guard, not a behavioural test: receiveEmail needs a full ForwardableEmailMessage,
// R2 and a DO namespace, so a mock would prove little.
// Run: node --import tsx --test workers/receive-email.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, "index.ts"), "utf8");
const appSrc = readFileSync(join(here, "app.ts"), "utf8");

describe("#12: built-in AI is off in the inbound path", () => {
	test("receiveEmail does not call the EmailAgent (no EMAIL_AGENT, no /onNewEmail)", () => {
		assert.equal(indexSrc.includes("EMAIL_AGENT"), false, "workers/index.ts must not reference EMAIL_AGENT");
		assert.equal(indexSrc.includes("onNewEmail"), false, "workers/index.ts must not call /onNewEmail");
	});

	test("the /agents/* route and routeAgentRequest are gone from app.ts", () => {
		assert.equal(appSrc.includes("routeAgentRequest"), false, "app.ts must not import/use routeAgentRequest");
		assert.equal(appSrc.includes('"/agents/*"'), false, "app.ts must not mount /agents/*");
	});

	test("the EmailAgent Durable Object class stays exported and /mcp/* stays mounted", () => {
		assert.ok(appSrc.includes('export { EmailAgent } from "./agent"'), "EmailAgent export must stay");
		assert.ok(appSrc.includes('app.all("/mcp/*"'), "/mcp/* route must stay");
	});
});
