/**
 * The search engines (search port + model slots wave, 2026-09-20):
 * engine resolution (the owner's auto-detect decision — a key is enough,
 * no engine choice needed; explicit pin requires the key; no silent
 * fallback) + the Tavily/Brave adapters against a STUB fetch (never the
 * network — the wire shapes are verified against the published docs, and
 * the tests pin those shapes).
 *
 * PURE + injected fetch — this file owns no fs.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { braveProvider, parseSearxngBaseUrl, resolveSearchEngineFor, SEARXNG_TIMEOUT_MS, searxngProvider, tavilyProvider } from "../src/server/search.ts";
import { maskKey, validateKeyShape } from "../src/core/auth-keys.ts";
import { resolveKeyStatuses } from "../src/server/keys.ts";

describe("resolveSearchEngineFor (the auto-detect decision)", () => {
	it("no keys: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("a key alone is enough — no engine choice needed", () => {
		const tav = resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001" });
		assert.ok(tav.available);
		assert.equal(tav.engine, "tavily");
		assert.match(tav.reason, /auto/);

		const brv = resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001" });
		assert.ok(brv.available);
		assert.equal(brv.engine, "brave");
	});

	it("both keys, no pin: preference order — Tavily first (owner decision)", () => {
		const out = resolveSearchEngineFor(undefined, {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "tavily");
	});

	it("the explicit pin wins when its key is present", () => {
		const out = resolveSearchEngineFor("brave", {
			tavily: "tvly-throwaway-key-00001",
			brave: "brave-throwaway-key-00001",
		});
		assert.ok(out.available);
		assert.equal(out.engine, "brave");
		assert.match(out.reason, /chosen/);
	});

	it("the explicit pin does NOT silently fall back to the other engine", () => {
		const out = resolveSearchEngineFor("tavily", { brave: "brave-throwaway-key-00001" });
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.match(out.reason, /tavily/);
		assert.match(out.reason, /API key is missing/);
	});
});

/** A one-shot stub fetch: asserts the request shape and returns the canned response. */
function stubFetch(canned: unknown, expect: (url: string, init: RequestInit) => void) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		expect(url, init);
		return new Response(JSON.stringify(canned), { status: 200 });
	};
}

describe("tavilyProvider (wire shape per docs.tavily.com, verified 2026-09-20)", () => {
	it("POSTs api.tavily.com/search with Bearer auth + the query body", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", stubFetch(
			{
				results: [
					{ title: "Example", url: "https://example.com/a", content: "line1\nline2" },
					{ title: "No URL", content: "dropped" },
				],
			},
			(url, init) => {
				assert.equal(url, "https://api.tavily.com/search");
				assert.equal(init.method, "POST");
				const headers = init.headers as Record<string, string>;
				assert.equal(headers.authorization, "Bearer tvly-throwaway-key-00001");
				const body = JSON.parse(init.body as string);
				assert.equal(body.query, "test query");
				assert.equal(body.max_results, 5);
				// The legacy api_key-in-body form is retired — auth is the header.
				assert.equal(body.api_key, undefined);
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/a", snippet: "line1 line2" }]);
	});

	it("maps the {detail:{error}} error body into the message", async () => {
		const provider = tavilyProvider("tvly-throwaway-key-00001", async () =>
			new Response(JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }), { status: 401 }),
		);
		await assert.rejects(provider.search("q", 5), /Tavily search API 401: Unauthorized/);
	});
});

describe("braveProvider (wire shape per Brave's dashboard docs, verified 2026-09-20)", () => {
	it("GETs res/v1/web/search with the X-Subscription-Token header", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", stubFetch(
			{
				web: {
					results: [
						{ title: "Example", url: "https://example.com/b", description: "a description" },
						{ description: "dropped — no url" },
					],
				},
			},
			(url, init) => {
				assert.ok(url.startsWith("https://api.search.brave.com/res/v1/web/search?"), url);
				assert.ok(url.includes("q=test+query"), url); // URLSearchParams: spaces as +
				assert.ok(url.includes("count=5"));
				const headers = init.headers as Record<string, string>;
				assert.equal(headers["x-subscription-token"], "brave-throwaway-key-00001");
			},
		));
		const hits = await provider.search("test query", 5);
		assert.deepEqual(hits, [{ title: "Example", url: "https://example.com/b", snippet: "a description" }]);
	});

	it("surfaces the HTTP status on failure", async () => {
		const provider = braveProvider("brave-throwaway-key-00001", async () =>
			new Response("rate limited", { status: 429 }),
		);
		await assert.rejects(provider.search("q", 5), /Brave search API 429/);
	});
});

describe("SearXNG as the third engine (server fork; upstream order Tavily → Brave → SearXNG)", () => {
	it("a SearXNG URL alone makes SearXNG the engine", () => {
		const out = resolveSearchEngineFor(undefined, { searxng: "https://search.example.org" });
		assert.ok(out.available);
		assert.equal(out.engine, "searxng");
		assert.equal(out.key, "https://search.example.org");
	});

	it("with Tavily or Brave also keyed and no pin, upstream's order wins", () => {
		assert.equal(resolveSearchEngineFor(undefined, { tavily: "tvly-throwaway-key-00001", searxng: "https://s.example" }).engine, "tavily");
		assert.equal(resolveSearchEngineFor(undefined, { brave: "brave-throwaway-key-00001", searxng: "https://s.example" }).engine, "brave");
	});

	it("an explicit SearXNG pin wins over keyed Tavily/Brave, and never falls back without its URL", () => {
		assert.equal(resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001", searxng: "https://s.example" }).engine, "searxng");
		const missing = resolveSearchEngineFor("searxng", { tavily: "tvly-throwaway-key-00001" });
		assert.equal(missing.available, false);
		assert.match(missing.reason, /SEARXNG_URL/);
	});

	it("an invalid SEARXNG_URL never counts as configured", () => {
		for (const bad of [undefined, "", "search.example.org", "ftp://s.example", "https://u:p@s.example", "https://s.example/?a=1", "https://s.example/#x"]) {
			assert.equal(parseSearxngBaseUrl(bad), null, String(bad));
		}
		assert.equal(parseSearxngBaseUrl("https://search.example.org/"), "https://search.example.org");
		assert.equal(parseSearxngBaseUrl(" http://10.0.0.5:8888/searx/ "), "http://10.0.0.5:8888/searx");
	});
});

type Call = { url: URL; init: RequestInit };

function searxngFetch(response: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url: new URL(url), init });
		return response();
	};
	return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe("searxngProvider (SearXNG search API)", () => {
	it("GETs {base}/search with q, format=json, pageno=1, categories=general, safesearch=0 and no language", async () => {
		const { calls, fetchFn } = searxngFetch(json({ results: [] }));
		await searxngProvider("https://search.example.org/searx", undefined, fetchFn).search("sigma.js v3", 5);
		assert.equal(calls.length, 1);
		const { url, init } = calls[0]!;
		assert.equal(`${url.origin}${url.pathname}`, "https://search.example.org/searx/search");
		assert.deepEqual(Object.fromEntries(url.searchParams), {
			q: "sigma.js v3",
			format: "json",
			pageno: "1",
			categories: "general",
			safesearch: "0",
		});
		assert.equal(init.method ?? "GET", "GET");
		assert.ok(init.signal instanceof AbortSignal, "every request carries a timeout signal");
		assert.equal((init.headers as Record<string, string>).authorization, undefined);
	});

	it("sends SEARXNG_AUTH_HEADER verbatim as the Authorization header", async () => {
		const { calls, fetchFn } = searxngFetch(json({ results: [] }));
		await searxngProvider("https://search.example.org", "Basic dXNlcjpwYXNz", fetchFn).search("q", 3);
		assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Basic dXNlcjpwYXNz");
	});

	it("maps title/url/content, skips entries without a URL, cuts to count, collapses newlines, caps snippets at 500", async () => {
		const long = "x".repeat(600);
		const { fetchFn } = searxngFetch(json({
			results: [
				{ title: "A", url: "https://a.example/", content: "line1\n  line2" },
				{ title: "no url", content: "dropped" },
				{ url: "https://b.example/", content: long },
				{ title: "C", url: "https://c.example/", content: "c" },
			],
		}));
		const hits = await searxngProvider("https://s.example", undefined, fetchFn).search("q", 2);
		assert.deepEqual(hits, [
			{ title: "A", url: "https://a.example/", snippet: "line1 line2" },
			{ title: "https://b.example/", url: "https://b.example/", snippet: "x".repeat(500) },
		]);
	});

	it("403 explains that JSON output must be enabled on the instance", async () => {
		const { fetchFn } = searxngFetch(() => new Response("Forbidden", { status: 403 }));
		await assert.rejects(
			searxngProvider("https://s.example", undefined, fetchFn).search("q", 5),
			/403.*search\.formats: \[html, json\]/s,
		);
	});

	it("429 points at the limiter's pass list", async () => {
		const { fetchFn } = searxngFetch(() => new Response("Too Many Requests", { status: 429 }));
		await assert.rejects(
			searxngProvider("https://s.example", undefined, fetchFn).search("q", 5),
			/429.*limiter.*pass list/s,
		);
	});

	it("other HTTP errors surface the status", async () => {
		const { fetchFn } = searxngFetch(() => new Response("boom", { status: 502 }));
		await assert.rejects(searxngProvider("https://s.example", undefined, fetchFn).search("q", 5), /SearXNG 502: boom/);
	});

	it("a timeout becomes a clear 15 s error (the adapter's AbortSignal.timeout)", async () => {
		assert.equal(SEARXNG_TIMEOUT_MS, 15_000);
		const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
			// Simulate the timeout signal firing (no real waiting).
			assert.ok(init.signal);
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		};
		await assert.rejects(searxngProvider("https://s.example", undefined, fetchFn).search("q", 5), /did not answer within 15 s/);
	});
});

describe("SearXNG keys in the auth catalog", () => {
	it("SEARXNG_URL accepts only http(s) base URLs", () => {
		assert.deepEqual(validateKeyShape("SEARXNG_URL", "https://search.example.org"), { ok: true });
		assert.deepEqual(validateKeyShape("SEARXNG_URL", "http://127.0.0.1:8888/"), { ok: true });
		for (const bad of ["search.example.org", "file:///etc/passwd", "https://u:p@s.example", "https://s.example/?x=1"]) {
			assert.equal(validateKeyShape("SEARXNG_URL", bad).ok, false, bad);
		}
	});

	it("SEARXNG_AUTH_HEADER is a single-line value and is never returned, not even masked", () => {
		assert.deepEqual(validateKeyShape("SEARXNG_AUTH_HEADER", "Basic dXNlcjpwYXNz"), { ok: true });
		assert.equal(validateKeyShape("SEARXNG_AUTH_HEADER", "Basic a\nX-Evil: 1").ok, false);
		const secret = "Basic c2VjcmV0OnZhbHVlUTk=";
		const rows = resolveKeyStatuses({ SEARXNG_AUTH_HEADER: secret, SEARXNG_URL: "https://s.example" }, {}, new Set());
		const header = rows.find((r) => r.id === "SEARXNG_AUTH_HEADER")!;
		assert.equal(header.present, true);
		assert.equal(header.masked, "••••");
		assert.ok(!JSON.stringify(rows).includes(maskKey(secret).slice(1)), "no tail of the header leaks");
	});
});
