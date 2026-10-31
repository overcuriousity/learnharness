/** Server fork: the ChatGPT sign-in callback relay (src/server/chatgpt-callback-relay.ts)
 *  against upstream's real loopback listener (electron/chatgpt.cjs), offline. */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-chatgpt-relay-"));
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_DATA_DIR = path.join(directory, "data");
delete process.env.LH_DESKTOP_SERVER; delete process.env.LH_DESKTOP_API_SECRET; delete process.env.LH_PUBLIC_ORIGIN;
await fs.writeFile(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const originalFetch = globalThis.fetch;
const outside: string[] = [];
// Loopback reaches the real listener; anything else (the token grant) fails offline.
globalThis.fetch = async (input, init) => {
	const url = new URL(String(input));
	if (url.hostname === "127.0.0.1") return originalFetch(input, init);
	outside.push(url.origin);
	throw new Error("offline fixture");
};

const { webSubscriptionOwner } = await import("../src/server/web-subscriptions.ts");
const { chatGPTCallbackRelayResponse, relayTarget, RELAY_MISMATCH, RELAY_NOT_PENDING, RELAY_REJECTED } = await import("../src/server/chatgpt-callback-relay.ts");
after(async () => { webSubscriptionOwner().close(); globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); });

const ORIGIN = "http://192.168.1.10:3000";
function relay(url: unknown, origin = ORIGIN) {
	return new Request(`${ORIGIN}/api/subscriptions/chatgpt-callback`, {
		method: "POST",
		headers: { host: new URL(ORIGIN).host, origin, "sec-fetch-site": "same-origin", "x-learnharness-subscriptions": "1", "content-type": "application/json" },
		body: JSON.stringify({ url }),
	});
}
async function startLogin() {
	const owner = webSubscriptionOwner();
	const reply = await owner.control("chatgpt", { op: "login" }, ORIGIN);
	const id = new URL(reply.browserAction!, ORIGIN).searchParams.get("id")!;
	const authorize = new URL((await owner.takeBrowserAction(id, ORIGIN))!);
	return { redirect: authorize.searchParams.get("redirect_uri")!, state: authorize.searchParams.get("state")! };
}
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20)); };

test("relayTarget: only the pending loopback callback, query carried over, nothing else", () => {
	const redirect = "http://127.0.0.1:41234/auth/callback";
	assert.equal(relayTarget(" http://127.0.0.1:41234/auth/callback?code=c&state=s ", redirect), "http://127.0.0.1:41234/auth/callback?code=c&state=s");
	for (const pasted of [
		"http://127.0.0.1:41235/auth/callback?code=c&state=s", // other port
		"http://localhost:41234/auth/callback?code=c&state=s", // other host
		"https://127.0.0.1:41234/auth/callback?code=c&state=s", // other scheme
		"http://127.0.0.1:41234/other?code=c&state=s", // other path
		"http://u:p@127.0.0.1:41234/auth/callback?code=c", // credentials
		"http://127.0.0.1:41234/auth/callback", // no query
		"not a url",
	]) assert.equal(relayTarget(pasted, redirect), null, pasted);
	assert.equal(relayTarget("http://10.0.0.1:41234/auth/callback?x=1", "http://10.0.0.1:41234/auth/callback"), null, "a non-loopback redirect is never relayed");
});

test("no pending sign-in: 409, nothing forwarded", async () => {
	const response = await chatGPTCallbackRelayResponse(relay("http://127.0.0.1:1/auth/callback?code=c&state=s"));
	assert.equal(response.status, 409);
	assert.equal((await response.json()).error, RELAY_NOT_PENDING);
});

test("cross-origin requests are refused", async () => {
	assert.equal((await chatGPTCallbackRelayResponse(relay("x", "https://unrelated.invalid"))).status, 403);
});

test("pending sign-in: mismatch and wrong state are refused without consuming it; the real callback completes it", async () => {
	const { redirect, state } = await startLogin();
	assert.equal((await webSubscriptionOwner().chatgpt.status()).pending, true);

	const otherPort = new URL(redirect); otherPort.port = String(Number(otherPort.port) === 65535 ? 1 : Number(otherPort.port) + 1);
	const mismatch = await chatGPTCallbackRelayResponse(relay(`${otherPort.origin}/auth/callback?code=c&state=${state}`));
	assert.equal(mismatch.status, 400); assert.equal((await mismatch.json()).error, RELAY_MISMATCH);

	const wrongState = await chatGPTCallbackRelayResponse(relay(`${redirect}?code=c&state=forged`));
	assert.equal(wrongState.status, 400); assert.equal((await wrongState.json()).error, RELAY_REJECTED);
	assert.equal((await webSubscriptionOwner().chatgpt.status()).pending, true, "a forged state never consumes the attempt");

	const ok = await chatGPTCallbackRelayResponse(relay(`${redirect}?code=fixture-code&state=${state}&client_id=oaiapp_fixture`));
	assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true });
	await until(async () => (await webSubscriptionOwner().chatgpt.status()).pending === false);
	assert.equal((await webSubscriptionOwner().chatgpt.status()).pending, false, "the listener consumed the callback and ran the grant");
	assert(outside.includes("https://auth.openai.com"), "the listener went on to the token grant (offline here)");

	const again = await chatGPTCallbackRelayResponse(relay(`${redirect}?code=fixture-code&state=${state}`));
	assert.equal(again.status, 409, "single use: the attempt is over");
});
