import assert from "node:assert/strict";
import fsPromises, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { replaceManifestFile, withManifestMutation } from "../src/isolation/manifest-mutation.ts";

async function fixture(t: TestContext, check: (path: string, temporaryPath: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "pi-manifest-replace-"));
	const path = join(root, "manifest.json");
	const temporaryPath = path + ".tmp";
	await writeFile(path, "previous checkpoint");
	await writeFile(temporaryPath, "next checkpoint");
	try { await check(path, temporaryPath); }
	finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
}

for (const code of ["EPERM", "EACCES"]) {
	it("retries a transient Windows " + code + " without removing the previous checkpoint", { skip: process.platform !== "win32" }, async (t) => {
		await fixture(t, async (path, temporaryPath) => {
			const rename = fsPromises.rename;
			let attempts = 0;
			t.mock.method(fsPromises, "rename", async (source: string, destination: string) => {
				assert.equal(destination, path);
				assert.equal(await readFile(path, "utf8"), "previous checkpoint");
				assert.equal(await readFile(temporaryPath, "utf8"), "next checkpoint");
				if (++attempts < 3) throw Object.assign(new Error("Windows sharing conflict"), { code });
				await rename(source, destination);
			});
			syncBuiltinESMExports();
			await withManifestMutation(path, () => replaceManifestFile(temporaryPath, path));
			assert.equal(attempts, 3);
			assert.equal(await readFile(path, "utf8"), "next checkpoint");
			await assert.rejects(readFile(temporaryPath), { code: "ENOENT" });
		});
	});
}

for (const code of ["EPERM", "EIO"]) {
	it("preserves the previous checkpoint and propagates persistent " + code, async (t) => {
		await fixture(t, async (path, temporaryPath) => {
			const error = Object.assign(new Error("Persistent replacement failure"), { code });
			let attempts = 0;
			t.mock.method(fsPromises, "rename", async () => { attempts++; throw error; });
			syncBuiltinESMExports();
			await assert.rejects(withManifestMutation(path, () => replaceManifestFile(temporaryPath, path)), (failure) => failure === error);
			assert.equal(attempts, code === "EPERM" && process.platform === "win32" ? 6 : 1);
			assert.equal(await readFile(path, "utf8"), "previous checkpoint");
			assert.equal(await readFile(temporaryPath, "utf8"), "next checkpoint");
			await assert.rejects(fsPromises.stat(path + ".lock"), { code: "ENOENT" });
		});
	});
}
