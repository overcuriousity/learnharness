/** GET /api/library — whether a library folder is configured (the upload
 *  button's visibility). Never returns the path. */
import { libraryUploadStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(libraryUploadStatus(), { headers: { "Cache-Control": "no-store" } });
}
