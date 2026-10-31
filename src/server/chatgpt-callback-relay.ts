/**
 * ChatGPT sign-in callback relay (server fork). Upstream's sign-in sends the
 * browser to http://127.0.0.1:<port>/auth/callback — the server's own
 * loopback, unreachable from a remote browser. The learner pastes the address
 * the browser ended up on; this handler checks it names the PENDING sign-in's
 * redirect_uri and forwards its query to that listener, whose own checks
 * (state, single use, host) decide. Upstream's sign-in code is untouched.
 */
import { authorized } from "./web-subscription-http.ts";
import { webSubscriptionOwner, webSubscriptionsEnabled } from "./web-subscriptions.ts";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const MAX_BODY = 16384;
export const RELAY_MISMATCH = "That address doesn't belong to the current sign-in. Copy the full address of the page your browser ended up on.";
export const RELAY_NOT_PENDING = "No ChatGPT sign-in is waiting. Start it again with Connect.";
export const RELAY_REJECTED = "The sign-in could not be verified. Start it again with Connect.";
export const RELAY_USED = "This sign-in address was already used or has expired. Start it again with Connect.";

function reply(body: Record<string, unknown>, status = 200) { return Response.json(body, { status, headers: HEADERS }); }

/** The URL to forward, or null when `pasted` is not the pending callback. */
export function relayTarget(pasted: string, redirectUri: string): string | null {
	let given: URL, expected: URL;
	try { given = new URL(pasted.trim()); expected = new URL(redirectUri); } catch { return null; }
	if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1") return null;
	if (given.origin !== expected.origin || given.pathname !== expected.pathname || given.username || given.password || !given.search) return null;
	return `${expected.origin}${expected.pathname}${given.search}`;
}

export async function chatGPTCallbackRelayResponse(request: Request, forward: typeof fetch = fetch): Promise<Response> {
	if (!webSubscriptionsEnabled()) return reply({ error: "Unavailable." }, 404);
	if (request.method !== "POST" || !authorized(request)) return reply({ error: "Sign-in controls require a same-origin LearnHarness request." }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reply({ error: "Expected JSON." }, 415);
	if (Number(request.headers.get("content-length")) > MAX_BODY) return reply({ error: "Request too large." }, 413);
	let url: unknown;
	try {
		const text = await request.text();
		if (text.length > MAX_BODY) return reply({ error: "Request too large." }, 413);
		url = (JSON.parse(text) as { url?: unknown })?.url;
	} catch { return reply({ error: "Invalid request." }, 400); }
	if (typeof url !== "string") return reply({ error: RELAY_MISMATCH }, 400);
	const owner = webSubscriptionOwner();
	const redirect = owner.chatGPTRedirect();
	if (!redirect || (await owner.chatgpt.status()).pending !== true) return reply({ error: RELAY_NOT_PENDING }, 409);
	const target = relayTarget(url, redirect);
	if (!target) return reply({ error: RELAY_MISMATCH }, 400);
	let status: number;
	try {
		status = (await forward(target, { redirect: "manual", signal: AbortSignal.timeout(15000) })).status;
	} catch { return reply({ error: RELAY_NOT_PENDING }, 409); }
	if (status === 200) return reply({ ok: true });
	return reply({ error: status === 400 ? RELAY_REJECTED : RELAY_USED }, 400);
}
