/**
 * LH_PUBLIC_ORIGIN: behind a TLS-terminating proxy the app sees
 * http://<host> while the browser sends Origin: https://<host>. With the
 * variable set, that configured origin is the ONLY accepted one — the
 * request URL/Host are ignored and X-Forwarded-* is never trusted.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { configuredPublicOrigin, subscriptionRequestOrigin } from "../src/server/web-subscription-http.ts";
import { claudeCodeInstallationResponse } from "../src/server/claude-code.ts";

const PUBLIC = "https://learn.example.org";
// What the app actually receives from nginx: plain http, Host preserved.
const proxied = (headers: Record<string, string> = {}) =>
	new Request("http://127.0.0.1:3000/api/claude-code", { headers: { host: "learn.example.org", "x-learnharness-claude-code": "1", ...headers } });
const status = { state: "not-found" as const, version: null, minimumVersion: "2.1.259" };
const probe = (response: Promise<Response>) => response.then((r) => r.status);

afterEach(() => { delete process.env.LH_PUBLIC_ORIGIN; });

describe("configuredPublicOrigin", () => {
	it("accepts bare http(s) origins only", () => {
		assert.equal(configuredPublicOrigin("https://learn.example.org"), "https://learn.example.org");
		assert.equal(configuredPublicOrigin("https://learn.example.org/"), "https://learn.example.org");
		assert.equal(configuredPublicOrigin("http://10.0.0.5:8080"), "http://10.0.0.5:8080");
		for (const bad of ["learn.example.org", "https://learn.example.org/app", "https://u:p@learn.example.org", "https://learn.example.org?x", "ftp://learn.example.org", "https://learn.example.org#a"]) {
			assert.equal(configuredPublicOrigin(bad), undefined, bad);
		}
	});
});

describe("subscriptionRequestOrigin with LH_PUBLIC_ORIGIN", () => {
	it("unset: the addressed http origin (the TLS mismatch this variable fixes)", () => {
		assert.equal(subscriptionRequestOrigin(proxied()), "http://learn.example.org");
	});

	it("set: the configured origin, regardless of URL scheme or Host", () => {
		process.env.LH_PUBLIC_ORIGIN = PUBLIC;
		assert.equal(subscriptionRequestOrigin(proxied()), PUBLIC);
		assert.equal(subscriptionRequestOrigin(proxied({ host: "evil.example" })), PUBLIC);
	});

	it("set but invalid: no origin at all, so every same-origin control refuses", () => {
		process.env.LH_PUBLIC_ORIGIN = "learn.example.org";
		assert.equal(subscriptionRequestOrigin(proxied()), undefined);
	});
});

describe("a same-origin control behind TLS (the Claude Code status check)", () => {
	const respond = (request: Request) => claudeCodeInstallationResponse(request, async () => status, () => true);

	it("without LH_PUBLIC_ORIGIN the browser's https Origin is refused (the reproduced 403)", async () => {
		assert.equal(await probe(respond(proxied({ origin: PUBLIC, "sec-fetch-site": "same-origin" }))), 403);
	});

	it("with LH_PUBLIC_ORIGIN the browser's https Origin is accepted", async () => {
		process.env.LH_PUBLIC_ORIGIN = PUBLIC;
		assert.equal(await probe(respond(proxied({ origin: PUBLIC, "sec-fetch-site": "same-origin" }))), 200);
	});

	it("with LH_PUBLIC_ORIGIN any other Origin is refused — forwarded headers included", async () => {
		process.env.LH_PUBLIC_ORIGIN = PUBLIC;
		for (const headers of [
			{ origin: "http://learn.example.org" },
			{ origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
			{ origin: "https://evil.example", host: "evil.example" },
		] as Record<string, string>[]) {
			assert.equal(await probe(respond(proxied(headers))), 403, JSON.stringify(headers));
		}
	});
});
