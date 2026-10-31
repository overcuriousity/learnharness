/** Server fork: web_fetch's Jina Reader fallback — off by default, opt-in
 *  via agent.search.jinaFallback (Settings → Agent → Tools). */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createWebTools } from "../src/agent/tools/web.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { composeJinaFallback, composeSearchEngine } from "../components/settings/agent-section.tsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A JS-rendered shell Readability cannot extract; Jina returns markdown. */
function stub(requests: string[]) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		if (url.startsWith("https://r.jina.ai/")) {
			return new Response(`Title: App\n\nMarkdown Content:\n${"Rendered by the reader service. ".repeat(12)}`);
		}
		return new Response('<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>', { headers: { "content-type": "text/html" } });
	}) as typeof fetch;
}

describe("web_fetch Jina fallback", () => {
	it("off (default): a JS-rendered page fails and its URL never reaches Jina", async () => {
		const requests: string[] = []; stub(requests);
		const { web_fetch } = createWebTools(() => null);
		const out = await web_fetch!.execute!("c1", { url: "https://example.com/app" });
		assert.match(String(out.details), /Could not extract readable content/);
		assert.deepEqual(requests, ["https://example.com/app"]);
		assert.match(web_fetch!.description, /cannot be extracted/);
	});

	it("on: the page is retried through r.jina.ai", async () => {
		const requests: string[] = []; stub(requests);
		const { web_fetch } = createWebTools(() => null, () => true);
		const out = await web_fetch!.execute!("c2", { url: "https://example.com/app" });
		assert.match(String(out.details), /Rendered by the reader service/);
		assert.deepEqual(requests, ["https://example.com/app", "https://r.jina.ai/https://example.com/app"]);
		assert.match(web_fetch!.description, /reader service/);
	});
});

describe("agent.search.jinaFallback setting", () => {
	it("write side: boolean only, kept beside the engine pin", () => {
		const both = parseAgentSettingsBody({ search: { engine: "searxng", jinaFallback: true } });
		assert.ok(both.ok); assert.deepEqual(both.ok && both.settings.search, { engine: "searxng", jinaFallback: true });
		const alone = parseAgentSettingsBody({ search: { jinaFallback: false } });
		assert.ok(alone.ok); assert.deepEqual(alone.ok && alone.settings.search, { jinaFallback: false });
		const bad = parseAgentSettingsBody({ search: { jinaFallback: "yes" } });
		assert.equal(bad.ok, false); assert.match(!bad.ok ? bad.error : "", /jinaFallback must be a boolean/);
	});

	it("read side: lenient — a bad value drops, the engine pin survives", () => {
		const read = (search: unknown) => sanitizeUserSettings({ version: 1, agent: { search } })?.agent?.search;
		assert.deepEqual(read({ engine: "brave", jinaFallback: true }), { engine: "brave", jinaFallback: true });
		assert.deepEqual(read({ engine: "brave", jinaFallback: "yes" }), { engine: "brave" });
		assert.equal(read({ jinaFallback: 1 }), undefined);
	});

	it("compose: the toggle keeps the engine pin, and picking an engine keeps the toggle", () => {
		assert.deepEqual(composeJinaFallback({ search: { engine: "tavily" } }, true).search, { engine: "tavily", jinaFallback: true });
		assert.deepEqual(composeJinaFallback({ search: { engine: "tavily", jinaFallback: true } }, false).search, { engine: "tavily" });
		assert.equal(composeJinaFallback({ search: { jinaFallback: true } }, false).search, undefined, "off with no pin drops the key");
		assert.deepEqual(composeSearchEngine({ search: { jinaFallback: true } }, "brave").search, { engine: "brave", jinaFallback: true });
		assert.deepEqual(composeSearchEngine({ search: { engine: "brave", jinaFallback: true } }, null).search, { jinaFallback: true });
	});
});
