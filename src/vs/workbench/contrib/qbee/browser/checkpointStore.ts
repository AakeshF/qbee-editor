/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checkpoint snapshots for agent runs.
//
// Layout under <workspaceRoot>/.qbee/checkpoints/:
//   latest.json                              { runId, ts, files: [...] }
//   <runId>/manifest.json                    { runId, ts, files: [{ path, existed }] }
//   <runId>/files/<rel-path>                 verbatim pre-state of the file
//
// Behavior:
// - On every apply_edit, the EditApplier calls recordPreState() with the
//   *current* disk content (or absence) of the target file. We only record on
//   the first apply per (runId, path) so subsequent diffs in the same run
//   don't overwrite the original state.
// - undoRun() walks the manifest and writes each snapshot back. Files that
//   didn't exist before the run get deleted on undo (rather than restored as
//   empty).
//
// run_terminal commands sit OUTSIDE this scope — the agent can run shell
// commands that modify arbitrary files, and we don't snapshot proactively.
// Documented as a known limitation; users should commit before agent runs
// that involve terminal commands.

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';

const MAX_RETAINED_RUNS = 10;
const CHECKPOINT_ROOT = '.qbee/checkpoints';

interface ManifestEntry {
	// Workspace-relative path of the file.
	path: string;
	// Whether the file existed before this run. False means the run created
	// it, so undo deletes it rather than restoring an empty snapshot.
	existed: boolean;
}

interface RunManifest {
	runId: string;
	ts: number;
	files: ManifestEntry[];
}

interface LatestPointer {
	runId: string;
	ts: number;
}

export class CheckpointStore {

	constructor(private readonly fileService: IFileService) { }

	/** Record the pre-edit state of a file for this run. No-op if already recorded. */
	async recordPreState(workspaceRoot: URI, runId: string, relPath: string, target: URI): Promise<void> {
		const runDir = this.runDir(workspaceRoot, runId);
		const filesDir = URI.joinPath(runDir, 'files');
		const snapshotPath = URI.joinPath(filesDir, ...relPath.split('/'));

		// First-write-wins: don't overwrite a snapshot taken earlier in the same run.
		if (await this.fileService.exists(snapshotPath)) {
			return;
		}

		let existed = false;
		let bytes: VSBuffer = VSBuffer.alloc(0);
		try {
			const content = await this.fileService.readFile(target);
			existed = true;
			bytes = content.value;
		} catch {
			// File doesn't exist pre-run; we'll record absence in the manifest.
		}

		// Always write a snapshot file so undo can find it (empty when not-existed).
		await this.fileService.writeFile(snapshotPath, bytes);
		await this.appendManifest(workspaceRoot, runId, { path: relPath, existed });
		await this.writeLatest(workspaceRoot, { runId, ts: Date.now() });
		await this.pruneOld(workspaceRoot);
	}

	/** Returns the most recent run's runId, or undefined if no checkpoints exist. */
	async latestRunId(workspaceRoot: URI): Promise<string | undefined> {
		const latestUri = URI.joinPath(workspaceRoot, CHECKPOINT_ROOT, 'latest.json');
		try {
			const content = await this.fileService.readFile(latestUri);
			const ptr = JSON.parse(content.value.toString()) as LatestPointer;
			return ptr.runId;
		} catch {
			return undefined;
		}
	}

	/** Returns manifest entries for a run, or undefined if not found. */
	async readManifest(workspaceRoot: URI, runId: string): Promise<RunManifest | undefined> {
		const manifestUri = URI.joinPath(this.runDir(workspaceRoot, runId), 'manifest.json');
		try {
			const content = await this.fileService.readFile(manifestUri);
			return JSON.parse(content.value.toString()) as RunManifest;
		} catch {
			return undefined;
		}
	}

	/** Read the snapshot bytes for a single file in a run. */
	async readSnapshot(workspaceRoot: URI, runId: string, relPath: string): Promise<VSBuffer | undefined> {
		const snapshotPath = URI.joinPath(this.runDir(workspaceRoot, runId), 'files', ...relPath.split('/'));
		try {
			const content = await this.fileService.readFile(snapshotPath);
			return content.value;
		} catch {
			return undefined;
		}
	}

	private runDir(workspaceRoot: URI, runId: string): URI {
		return URI.joinPath(workspaceRoot, CHECKPOINT_ROOT, runId);
	}

	private async appendManifest(workspaceRoot: URI, runId: string, entry: ManifestEntry): Promise<void> {
		const manifestUri = URI.joinPath(this.runDir(workspaceRoot, runId), 'manifest.json');
		let manifest: RunManifest;
		try {
			const content = await this.fileService.readFile(manifestUri);
			manifest = JSON.parse(content.value.toString()) as RunManifest;
		} catch {
			manifest = { runId, ts: Date.now(), files: [] };
		}
		// Idempotent on path.
		if (!manifest.files.some((f) => f.path === entry.path)) {
			manifest.files.push(entry);
		}
		await this.fileService.writeFile(manifestUri, VSBuffer.fromString(JSON.stringify(manifest, null, 2)));
	}

	private async writeLatest(workspaceRoot: URI, ptr: LatestPointer): Promise<void> {
		const latestUri = URI.joinPath(workspaceRoot, CHECKPOINT_ROOT, 'latest.json');
		await this.fileService.writeFile(latestUri, VSBuffer.fromString(JSON.stringify(ptr, null, 2)));
	}

	private async pruneOld(workspaceRoot: URI): Promise<void> {
		const rootUri = URI.joinPath(workspaceRoot, CHECKPOINT_ROOT);
		try {
			const stat = await this.fileService.resolve(rootUri);
			if (!stat.children) {
				return;
			}
			// Skip the latest.json file; keep the most-recent MAX_RETAINED_RUNS dirs.
			const dirs = stat.children
				.filter((c) => c.isDirectory && /^run-/.test(c.name))
				.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
			for (const dir of dirs.slice(MAX_RETAINED_RUNS)) {
				await this.fileService.del(dir.resource, { recursive: true, useTrash: false }).catch(() => undefined);
			}
		} catch {
			// First-run case: directory doesn't exist yet. Nothing to prune.
		}
	}
}
