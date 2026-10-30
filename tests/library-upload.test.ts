/** Library uploads: files land in <library>/uploads/ under a safe name,
 *  never overwrite, respect the 25 MB cap and same-origin rule. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-upload-")));
const library = path.join(base, "library");
fs.mkdirSync(library);
fs.mkdirSync(path.join(base, "data"));
process.env.LH_DATA_DIR = path.join(base, "data");
process.env.LH_AUTH_FILE = path.join(base, "secrets", "auth.json");
process.env.LH_LIBRARY_DIR = library;
delete process.env.LH_PUBLIC_ORIGIN;

const { libraryUploadResponse, sanitizeUploadName, UPLOAD_MAX_BYTES } = await import("../src/server/library-upload.ts");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const ORIGIN = "http://learn.test:3000";

async function uploadRequest(files: Array<[string, string]>, headers: Record<string, string> = {}): Promise<Request> {
	const form = new FormData();
	for (const [name, content] of files) form.append("files", new File([content], name));
	// Serialize like a browser would: multipart body + its Content-Length.
	const encoded = new Response(form);
	const body = new Uint8Array(await encoded.arrayBuffer());
	return new Request(`${ORIGIN}/api/library/upload`, {
		method: "POST",
		body,
		headers: {
			host: "learn.test:3000",
			origin: ORIGIN,
			"content-type": encoded.headers.get("content-type")!,
			"content-length": String(body.byteLength),
			...headers,
		},
	});
}

describe("sanitizeUploadName", () => {
	it("reduces any client name to one safe segment", () => {
		assert.equal(sanitizeUploadName("notes.pdf"), "notes.pdf");
		assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd");
		assert.equal(sanitizeUploadName("..\\..\\boot.ini"), "boot.ini");
		assert.equal(sanitizeUploadName(".."), "upload");
		assert.equal(sanitizeUploadName(".bashrc"), "bashrc");
		assert.equal(sanitizeUploadName("a\u0000b\n\"c\".txt"), "abc.txt");
		assert.ok(Buffer.byteLength(sanitizeUploadName(`${"x".repeat(400)}.pdf`)) <= 200);
		assert.ok(sanitizeUploadName(`${"x".repeat(400)}.pdf`).endsWith(".pdf"));
	});
});

describe("POST /api/library/upload", () => {
	it("saves into <library>/uploads and returns the absolute paths", async () => {
		const res = await libraryUploadResponse(await uploadRequest([["paper.pdf", "%PDF-1.4 x"], ["notes.md", "# hi"]]));
		assert.equal(res.status, 200);
		const body = (await res.json()) as { files: Array<{ name: string; path: string }> };
		assert.deepEqual(body.files.map((f) => f.path), [path.join(library, "uploads", "paper.pdf"), path.join(library, "uploads", "notes.md")]);
		assert.equal(fs.readFileSync(path.join(library, "uploads", "notes.md"), "utf8"), "# hi");
	});

	it("never overwrites: a clash becomes name-2.ext, name-3.ext", async () => {
		const first = await libraryUploadResponse(await uploadRequest([["same.txt", "one"]]));
		const second = await libraryUploadResponse(await uploadRequest([["same.txt", "two"]]));
		const third = await libraryUploadResponse(await uploadRequest([["same.txt", "three"]]));
		const names = await Promise.all([first, second, third].map(async (r) => ((await r.json()) as { files: Array<{ name: string }> }).files[0]!.name));
		assert.deepEqual(names, ["same.txt", "same-2.txt", "same-3.txt"]);
		assert.equal(fs.readFileSync(path.join(library, "uploads", "same.txt"), "utf8"), "one");
	});

	it("a traversal file name still lands inside uploads/", async () => {
		const res = await libraryUploadResponse(await uploadRequest([["../../../escape.txt", "x"]]));
		const body = (await res.json()) as { files: Array<{ path: string }> };
		assert.equal(body.files[0]!.path, path.join(library, "uploads", "escape.txt"));
		assert.equal(fs.existsSync(path.join(base, "escape.txt")), false);
	});

	it("refuses cross-origin and origin-less requests", async () => {
		assert.equal((await libraryUploadResponse(await uploadRequest([["a.txt", "a"]], { origin: "https://evil.example" }))).status, 403);
		assert.equal((await libraryUploadResponse(await uploadRequest([["a.txt", "a"]], { "sec-fetch-site": "cross-site" }))).status, 403);
		const noOrigin = await uploadRequest([["a.txt", "a"]]);
		noOrigin.headers.delete("origin");
		assert.equal((await libraryUploadResponse(noOrigin)).status, 403);
	});

	it("rejects bodies over 25 MB by Content-Length before reading them", async () => {
		assert.equal(UPLOAD_MAX_BYTES, 25 * 1024 * 1024);
		const res = await libraryUploadResponse(await uploadRequest([["big.bin", "x"]], { "content-length": String(UPLOAD_MAX_BYTES + 1) }));
		assert.equal(res.status, 413);
	});

	it("an uploads/ symlink pointing out of the library is refused", async () => {
		const other = fs.mkdtempSync(path.join(base, "other-"));
		fs.renameSync(path.join(library, "uploads"), path.join(base, "uploads-moved"));
		fs.symlinkSync(other, path.join(library, "uploads"));
		try {
			const res = await libraryUploadResponse(await uploadRequest([["x.txt", "x"]]));
			assert.equal(res.status, 500);
			assert.deepEqual(fs.readdirSync(other), []);
		} finally {
			fs.unlinkSync(path.join(library, "uploads"));
			fs.renameSync(path.join(base, "uploads-moved"), path.join(library, "uploads"));
		}
	});

	it("without a library folder the route is 404", async () => {
		const saved = process.env.LH_LIBRARY_DIR;
		delete process.env.LH_LIBRARY_DIR;
		try {
			assert.equal((await libraryUploadResponse(await uploadRequest([["x.txt", "x"]]))).status, 404);
		} finally {
			process.env.LH_LIBRARY_DIR = saved;
		}
	});
});
