import { chatGPTCallbackRelayResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The relay is POST-only; pass no extra arguments to the handler.
export const POST = (request: Request) => chatGPTCallbackRelayResponse(request);
