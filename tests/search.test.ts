/**
 * The SearXNG engine: availability resolution (no URL = honestly
 * unavailable, no fallback) + the adapter against an injected fetch
 * (never the network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSearxngBaseUrl, resolveSearchEngineFor, SEARXNG_TIMEOUT_MS, searxngProvider } from "../src/server/search.ts";
import { maskKey, validateKeyShape } from "../src/core/auth-keys.ts";
import { resolveKeyStatuses } from "../src/server/keys.ts";

type Call = { url: URL; init: RequestInit };

function stubFetch(response: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
		calls.push({ url: new URL(url), init });
		return response();
	};
	return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe("resolveSearchEngineFor (SearXNG is live exactly when SEARXNG_URL is valid)", () => {
	it("no URL: unavailable, no default engine", () => {
		const out = resolveSearchEngineFor(undefined);
		assert.equal(out.available, false);
		assert.equal(out.engine, null);
		assert.match(out.reason, /SEARXNG_URL/);
	});

	it("an invalid URL is unavailable too — never a guess", () => {
		for (const bad of ["search.example.org", "ftp://search.example.org", "https://u:p@search.example.org", "https://s.example.org/?a=1", "https://s.example.org/#x"]) {
			const out = resolveSearchEngineFor(bad);
			assert.equal(out.available, false, bad);
			assert.match(out.reason, /not a valid/);
		}
	});

	it("a valid http(s) base URL makes SearXNG live", () => {
		const out = resolveSearchEngineFor("https://search.example.org/");
		assert.equal(out.available, true);
		assert.equal(out.engine, "searxng");
		assert.equal(out.baseUrl, "https://search.example.org");
		assert.equal(parseSearxngBaseUrl(" http://10.0.0.5:8888/searx/ "), "http://10.0.0.5:8888/searx");
	});
});

describe("searxngProvider (SearXNG search API)", () => {
	it("GETs {base}/search with q, format=json, pageno=1, categories=general, safesearch=0 and no language", async () => {
		const { calls, fetchFn } = stubFetch(json({ results: [] }));
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
		const { calls, fetchFn } = stubFetch(json({ results: [] }));
		await searxngProvider("https://search.example.org", "Basic dXNlcjpwYXNz", fetchFn).search("q", 3);
		assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Basic dXNlcjpwYXNz");
	});

	it("maps title/url/content, skips entries without a URL, cuts to count, collapses newlines, caps snippets at 500", async () => {
		const long = "x".repeat(600);
		const { fetchFn } = stubFetch(json({
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
		const { fetchFn } = stubFetch(() => new Response("Forbidden", { status: 403 }));
		await assert.rejects(
			searxngProvider("https://s.example", undefined, fetchFn).search("q", 5),
			/403.*search\.formats: \[html, json\]/s,
		);
	});

	it("429 points at the limiter's pass list", async () => {
		const { fetchFn } = stubFetch(() => new Response("Too Many Requests", { status: 429 }));
		await assert.rejects(
			searxngProvider("https://s.example", undefined, fetchFn).search("q", 5),
			/429.*limiter.*pass list/s,
		);
	});

	it("other HTTP errors surface the status", async () => {
		const { fetchFn } = stubFetch(() => new Response("boom", { status: 502 }));
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
