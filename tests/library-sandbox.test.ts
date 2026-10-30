/**
 * The library sandbox (fs-shared.ts): every file tool resolves inside
 * LH_LIBRARY_DIR only — `..` and symlink escapes are refused, the data
 * folder and the auth file's folder are always refused, and without a
 * usable library the file tools (and the pdf job + learner-files prompt
 * segment) are not registered at all.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// Layout (all real paths): <base>/library, <base>/outside, <base>/data,
// <base>/secrets/auth.json — configured BEFORE config.ts is imported.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-sandbox-")));
const library = path.join(base, "library");
const outside = path.join(base, "outside");
const data = path.join(base, "data");
const secrets = path.join(base, "secrets");
for (const dir of [library, outside, data, secrets, path.join(library, "notes")]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(library, "notes", "a.md"), "inside the library\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE\n");
fs.writeFileSync(path.join(data, "chat.json"), "TOP-SECRET-DATA\n");
fs.writeFileSync(path.join(secrets, "auth.json"), '{"OPENAI_API_KEY":"TOP-SECRET-KEY"}');
fs.writeFileSync(path.join(secrets, "chatgpt-credentials.json"), "TOP-SECRET-CRED");
// Escapes planted inside the library:
fs.symlinkSync(path.join(outside, "secret.txt"), path.join(library, "link-to-secret.txt"));
fs.symlinkSync(outside, path.join(library, "link-to-outside"));
fs.symlinkSync(data, path.join(library, "link-to-data"));
fs.symlinkSync(path.join(secrets, "auth.json"), path.join(library, "link-to-auth.json"));
fs.symlinkSync(path.join(library, "notes", "a.md"), path.join(library, "inner-link.md"));

process.env.LH_DATA_DIR = data;
process.env.LH_AUTH_FILE = path.join(secrets, "auth.json");
process.env.LH_LIBRARY_DIR = library;

const { libraryRoot, resolveLibraryPath, LEARNER_FILES_SEGMENT } = await import("../src/agent/tools/fs-shared.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { findTool } = await import("../src/agent/tools/find.ts");
const { grepTool } = await import("../src/agent/tools/grep.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");

after(() => fs.rmSync(base, { recursive: true, force: true }));

const text = async (tool: typeof readTool | typeof lsTool | typeof findTool | typeof grepTool, args: Record<string, unknown>) => {
	const result = await tool.execute!("t", args as never);
	return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
};

describe("resolveLibraryPath", () => {
	it("relative and absolute paths inside the library resolve to real paths", async () => {
		assert.equal(await resolveLibraryPath("notes/a.md"), path.join(library, "notes", "a.md"));
		assert.equal(await resolveLibraryPath(path.join(library, "notes", "a.md")), path.join(library, "notes", "a.md"));
		assert.equal(await resolveLibraryPath(), library, "no path = the library root");
		assert.equal(await resolveLibraryPath("inner-link.md"), path.join(library, "notes", "a.md"), "a symlink staying inside is fine");
		assert.equal(await resolveLibraryPath("notes/new.md"), path.join(library, "notes", "new.md"), "a missing file still resolves inside");
	});

	it("`..` escapes are refused, relative or absolute", async () => {
		for (const p of ["../outside/secret.txt", "notes/../../outside/secret.txt", path.join(library, "..", "outside", "secret.txt"), "/etc/passwd", "../"]) {
			await assert.rejects(resolveLibraryPath(p), /outside the library folder/, p);
		}
	});

	it("symlinks that end up outside are refused — files and directories", async () => {
		await assert.rejects(resolveLibraryPath("link-to-secret.txt"), /outside the library folder/);
		await assert.rejects(resolveLibraryPath("link-to-outside"), /outside the library folder/);
		await assert.rejects(resolveLibraryPath("link-to-outside/secret.txt"), /outside the library folder/);
	});

	it("the data folder and the auth folder are refused even via symlink", async () => {
		await assert.rejects(resolveLibraryPath("link-to-data/chat.json"), /outside the library folder|not readable/);
		await assert.rejects(resolveLibraryPath("link-to-auth.json"), /outside the library folder|not readable/);
		await assert.rejects(resolveLibraryPath(path.join(secrets, "chatgpt-credentials.json")), /outside the library folder|not readable/);
	});
});

describe("the tools inherit the sandbox", () => {
	it("read refuses escapes and never returns the secret", async () => {
		assert.equal(await text(readTool, { path: "notes/a.md" }), "inside the library\n");
		for (const p of ["../outside/secret.txt", "link-to-secret.txt", "link-to-auth.json", "link-to-data/chat.json", path.join(secrets, "auth.json")]) {
			await assert.rejects(readTool.execute!("t", { path: p }), /outside the library folder|not readable/, p);
		}
	});

	it("ls refuses `..` and symlinked directories that leave the library", async () => {
		await assert.rejects(lsTool.execute!("t", { path: ".." }), /outside the library folder/);
		await assert.rejects(lsTool.execute!("t", { path: "link-to-outside" }), /outside the library folder/);
		assert.match(await text(lsTool, {}), /notes\//);
	});

	it("find and grep walks never follow symlinks out of the library", async () => {
		const found = await text(findTool, { pattern: "*" });
		assert.match(found, /notes\/a\.md/);
		assert.doesNotMatch(found, /secret\.txt|chat\.json|auth\.json/);
		const grepped = await text(grepTool, { pattern: "TOP-SECRET" });
		assert.doesNotMatch(grepped, /TOP-SECRET-/);
		await assert.rejects(grepTool.execute!("t", { pattern: "x", path: "link-to-secret.txt" }), /outside the library folder/);
	});
});

describe("libraryRoot: unset or misconfigured = no file tools", () => {
	it("unset, relative, missing, or overlapping the data/auth folders → null", () => {
		assert.equal(libraryRoot({}), null);
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: "relative/library" }), null);
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: path.join(base, "missing") }), null);
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: data }), null, "the data folder itself");
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: path.join(data) + "/" }), null);
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: secrets }), null, "the auth folder");
		assert.equal(libraryRoot({ LH_LIBRARY_DIR: base }), null, "a library CONTAINING the data/auth folders");
		assert.deepEqual(libraryRoot({ LH_LIBRARY_DIR: library }), { configured: library, real: library });
	});

	it("without LH_LIBRARY_DIR the registries carry no file tools and no pdf job, and the prompt drops the learner-files segment", () => {
		const ctx = { chatId: "c", jobStore: {} as never, spawn: () => {} } as never;
		const withLibrary = Object.keys(createTeacherTools(ctx));
		for (const name of ["read", "ls", "find", "grep", "pdf"]) assert.ok(withLibrary.includes(name), name);
		assert.ok(composeInstructions("teacher").includes("## Learner files"));
		const saved = process.env.LH_LIBRARY_DIR;
		delete process.env.LH_LIBRARY_DIR;
		try {
			for (const registry of [createTeacherTools(ctx), createProberTools(ctx)]) {
				for (const name of ["read", "ls", "find", "grep", "pdf"]) assert.ok(!(name in registry), name);
				assert.ok("research" in registry, "research is unaffected");
			}
			for (const kind of ["teacher", "prober"] as const) {
				assert.ok(!composeInstructions(kind).includes("## Learner files"), `${kind}: ${LEARNER_FILES_SEGMENT} omitted`);
			}
		} finally {
			process.env.LH_LIBRARY_DIR = saved;
		}
	});
});
