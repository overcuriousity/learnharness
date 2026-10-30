/**
 * Library uploads (server fork): the composer's paperclip writes files into
 * <LH_LIBRARY_DIR>/uploads/, where the sandboxed file tools can read them.
 *
 * Owner decisions: any file type; at most UPLOAD_MAX_BYTES per request
 * (matches the pdf reader's 25 MB ceiling and nginx client_max_body_size
 * 25m); names are reduced to a safe basename and NEVER overwrite — a clash
 * becomes name-2.ext, name-3.ext, …. No authentication of its own (nginx +
 * the internal network are the boundary); like the other state-changing
 * browser controls it accepts only same-origin requests.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isInside, libraryRoot } from "../agent/tools/fs-shared.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

/** 25 MiB per request — keep in sync with next.config.ts
 *  experimental.proxyClientMaxBodySize and the nginx example. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_SUBDIR = "uploads";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers: HEADERS });

/** Upload availability for the client (the button shows only when true). */
export function libraryUploadStatus(): { available: boolean } {
	return { available: libraryRoot() !== null };
}

/** A client-supplied file name → a safe single path segment. */
export function sanitizeUploadName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	// Control characters and characters that are awkward in quoted paths.
	let name = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
	name = name.replace(/^\.+/, ""); // no hidden files, no "." / ".."
	if (!name) name = "upload";
	// Keep it well under the common 255-byte filename limit.
	while (Buffer.byteLength(name, "utf8") > 200) {
		const ext = path.extname(name);
		const stem = name.slice(0, name.length - ext.length);
		name = stem.slice(0, Math.max(1, stem.length - 10)) + (ext.length <= 20 ? ext : "");
	}
	return name;
}

/** Write one file without ever overwriting: name.ext, name-2.ext, … */
async function writeUnique(dir: string, name: string, data: Uint8Array): Promise<string> {
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length) || name;
	for (let n = 1; n <= 1000; n++) {
		const candidate = path.join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
		try {
			await fs.writeFile(candidate, data, { flag: "wx" });
			return candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
	}
	throw new Error("too many files with this name");
}

/** The uploads folder, created on demand, and proven to sit inside the
 *  library after symlink resolution (an "uploads" symlink pointing out is
 *  refused). */
async function uploadsDir(): Promise<string | null> {
	const root = libraryRoot();
	if (!root) return null;
	const dir = path.join(root.real, UPLOAD_SUBDIR);
	await fs.mkdir(dir, { recursive: true });
	const real = await fs.realpath(dir);
	return isInside(real, root.real) && real !== root.real ? real : null;
}

/** POST multipart/form-data, field "files" (one or more). */
export async function libraryUploadResponse(request: Request): Promise<Response> {
	if (libraryRoot() === null) return error("No library folder is configured (LH_LIBRARY_DIR).", 404);
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") {
		return error("Uploads require a same-origin LearnHarness request.", 403);
	}
	// The advertised size decides BEFORE reading: an over-limit body may
	// already be truncated by the proxy body buffer, so never parse it.
	const length = Number(request.headers.get("content-length"));
	if (!request.headers.get("content-length") || !Number.isFinite(length)) return error("Content-Length is required.", 411);
	if (length > UPLOAD_MAX_BYTES) return error(`Uploads are limited to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB per request.`, 413);
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) return error("Expected multipart/form-data.", 415);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return error("The upload could not be read.", 400);
	}
	const files = form.getAll("files").filter((v): v is File => typeof v === "object" && v !== null && "arrayBuffer" in v);
	if (files.length === 0) return error("No files were sent.", 400);
	if (files.reduce((sum, f) => sum + f.size, 0) > UPLOAD_MAX_BYTES) {
		return error(`Uploads are limited to ${UPLOAD_MAX_BYTES / 1024 / 1024} MB per request.`, 413);
	}

	const dir = await uploadsDir();
	if (!dir) return error("The uploads folder is not usable.", 500);
	const saved: Array<{ name: string; path: string }> = [];
	try {
		for (const file of files) {
			const target = await writeUnique(dir, sanitizeUploadName(file.name), new Uint8Array(await file.arrayBuffer()));
			saved.push({ name: path.basename(target), path: target });
		}
	} catch {
		return error("The file could not be saved.", 500);
	}
	return Response.json({ files: saved }, { headers: HEADERS });
}
