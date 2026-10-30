/** A throwaway library folder for file-tool tests: LH_LIBRARY_DIR points at
 *  it for this test process (each test file runs in its own process), and
 *  fixtures are created INSIDE it — the tools refuse everything else. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TEST_LIBRARY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-")));
process.env.LH_LIBRARY_DIR = TEST_LIBRARY;
process.on("exit", () => fs.rmSync(TEST_LIBRARY, { recursive: true, force: true }));

/** mkdtemp inside the test library (sync). */
export function libraryTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(TEST_LIBRARY, prefix));
}

/** Copy a repo fixture into the test library; returns the library path. */
export function libraryCopy(source: string, relative = path.basename(source)): string {
	const target = path.join(TEST_LIBRARY, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.copyFileSync(source, target);
	return target;
}
