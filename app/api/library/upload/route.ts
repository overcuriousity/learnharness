/** POST /api/library/upload — multipart field "files" into
 *  <LH_LIBRARY_DIR>/uploads/ (src/server/library-upload.ts). */
import { libraryUploadResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return libraryUploadResponse(request);
}
