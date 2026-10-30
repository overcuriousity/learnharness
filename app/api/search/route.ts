/**
 * GET /api/search — the search engine's status: the honest availability
 * signal the settings UI explains from.
 *
 * { available, engine, reason } — never a URL, never a secret: `engine` is
 * "searxng" when SEARXNG_URL is valid, and `reason` is the one-line state
 * explanation ("set SEARXNG_URL", or the invalid-URL case).
 */

import { searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(searchStatus());
}
