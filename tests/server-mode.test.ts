/** LH_SERVER_MODE=1: Claude Code is off everywhere (admission, catalog,
 *  routes 404) and ChatGPT sign-in is replaced by a one-line explanation;
 *  Copilot/Grok are untouched. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-mode-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "secrets", "auth.json");
fs.mkdirSync(path.join(scratch, "secrets"), { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
delete process.env.LH_PUBLIC_ORIGIN;

const { settingsStore } = await import("../src/store/settings.ts");
const { claudeCodeEnabled } = await import("../src/server/claude-code-config.ts");
const { claudeCodeInstallationResponse } = await import("../src/server/claude-code.ts");
const { subscriptionControlsResponse } = await import("../src/server/web-subscription-http.ts");
const { webSubscriptionStatus } = await import("../src/server/web-subscriptions.ts");
const { chatGPTConnected } = await import("../src/agent/chatgpt-bridge.ts");
const settingsRoute = await import("../app/api/settings/[section]/route.ts");
const { CHATGPT_SERVER_MODE_NOTICE, serverMode } = await import("../src/core/server-mode.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { delete process.env.LH_SERVER_MODE; });

const ORIGIN = "http://learn.test";
const claudeCheck = () => new Request(`${ORIGIN}/api/claude-code`, { headers: { host: "learn.test", origin: ORIGIN, "x-learnharness-claude-code": "1" } });
const chatgptLogin = () => new Request(`${ORIGIN}/api/subscriptions`, {
	method: "POST",
	headers: { host: "learn.test", origin: ORIGIN, "content-type": "application/json", "x-learnharness-subscriptions": "1" },
	body: JSON.stringify({ providerId: "chatgpt", op: "login" }),
});

describe("serverMode()", () => {
	it("is exactly LH_SERVER_MODE=1", () => {
		assert.equal(serverMode({}), false);
		assert.equal(serverMode({ LH_SERVER_MODE: "0" }), false);
		assert.equal(serverMode({ LH_SERVER_MODE: "1" }), true);
	});
});

describe("Claude Code", () => {
	it("an opted-in Claude Code is disabled in server mode", () => {
		settingsStore.writeSettings({ version: 1, claudeCode: { enabled: true } });
		assert.equal(claudeCodeEnabled(), true);
		process.env.LH_SERVER_MODE = "1";
		assert.equal(claudeCodeEnabled(), false);
	});

	it("GET /api/claude-code is 404 and never probes", async () => {
		process.env.LH_SERVER_MODE = "1";
		const res = await claudeCodeInstallationResponse(claudeCheck(), async () => assert.fail("must not probe"), () => true);
		assert.equal(res.status, 404);
	});

	it("PUT /api/settings/claudeCode is 404", async () => {
		process.env.LH_SERVER_MODE = "1";
		const res = await settingsRoute.PUT(
			new Request(`${ORIGIN}/api/settings/claudeCode`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) }),
			{ params: Promise.resolve({ section: "claudeCode" }) },
		);
		assert.equal(res.status, 404);
	});
});

describe("ChatGPT", () => {
	it("is never connected, its controls are 404, and the status carries the one-line notice", async () => {
		process.env.LH_SERVER_MODE = "1";
		assert.equal(chatGPTConnected(), false);
		assert.equal((await subscriptionControlsResponse(chatgptLogin())).status, 404);
		const status = await webSubscriptionStatus();
		assert.equal(status.chatgpt.available, false);
		assert.deepEqual(status.chatgpt.accounts, []);
		assert.equal(status.chatgpt.serverUnavailable, CHATGPT_SERVER_MODE_NOTICE);
		assert.ok(Array.isArray(status.native), "Copilot/Grok statuses still flow");
	});

	it("outside server mode the status carries no notice", async () => {
		const status = await webSubscriptionStatus();
		assert.equal(status.chatgpt.serverUnavailable, undefined);
	});
});
