"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { Loader2Icon, PaperclipIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";

/**
 * The composer's paperclip (server fork): uploads files into
 * <LH_LIBRARY_DIR>/uploads/ (POST /api/library/upload) and inserts the
 * saved paths into the given input as path chips — the same event a
 * dropped desktop path uses. Renders nothing while no library folder is
 * configured (GET /api/library), so the button never promises files the
 * agent could not read.
 */

let available = false;
let loaded = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (!loaded) {
		loaded = true;
		fetch("/api/library", { cache: "no-store" })
			.then((r) => r.json())
			.then((body: { available?: boolean }) => { available = body.available === true; })
			.catch(() => { available = false; })
			.finally(() => { for (const l of listeners) l(); });
	}
	return () => { listeners.delete(listener); };
}

export function useLibraryAvailable(): boolean {
	return useSyncExternalStore(subscribe, () => available, () => false);
}

export function LibraryUploadButton({ inputRef }: { inputRef: React.RefObject<HTMLDivElement | null> }) {
	const isAvailable = useLibraryAvailable();
	const picker = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!isAvailable) return null;

	const upload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const form = new FormData();
			for (const file of Array.from(files)) form.append("files", file);
			const res = await fetch("/api/library/upload", { method: "POST", body: form });
			const body = (await res.json().catch(() => ({}))) as { files?: Array<{ path: string }>; error?: string };
			if (!res.ok || !body.files) throw new Error(body.error ?? `Upload failed (${res.status})`);
			inputRef.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: body.files.map((f) => f.path) }));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<input
				ref={picker}
				type="file"
				multiple
				className="hidden"
				data-testid="library-upload-input"
				onChange={(e) => {
					void upload(e.target.files);
					e.target.value = ""; // allow re-picking the same file
				}}
			/>
			<Hint label={error ?? "Upload files to your library"} side="top">
				<button
					type="button"
					onClick={() => picker.current?.click()}
					disabled={busy}
					aria-label={error ? `Upload failed: ${error}` : "Upload files to your library"}
					data-testid="library-upload-button"
					className={`flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors hover:bg-accent disabled:opacity-60 ${error ? "text-destructive" : "text-muted-foreground"}`}
				>
					{busy ? <Loader2Icon className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
				</button>
			</Hint>
		</>
	);
}
