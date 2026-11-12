// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import yazl from "yazl";
import { extractArchiveBuffer, resolveSafeEntryPath, assertTarEntrySafe, normalizeToRootTarGz } from "./codebase-archive.js";

/**
 * Build a raw (uncompressed) USTAR archive from a map of entry name -> contents.
 * `tar.create` sanitizes `..` out of entry names, so to test path-traversal
 * rejection we hand-assemble the 512-byte USTAR blocks with the malicious name
 * intact.
 */
function makeRawTar(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "ascii");
    header.write("0000644\0", 100, 8, "ascii"); // mode
    header.write("0000000\0", 108, 8, "ascii"); // uid
    header.write("0000000\0", 116, 8, "ascii"); // gid
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); // size
    header.write("00000000000\0", 136, 12, "ascii"); // mtime
    header.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
    header.write("0", 156, 1, "ascii"); // typeflag: normal file
    header.write("ustar\0", 257, 6, "ascii"); // magic
    header.write("00", 263, 2, "ascii"); // version
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii"); // checksum
    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks terminate the archive
  return Buffer.concat(blocks);
}

/** Build an in-memory zip from a map of entry name -> contents. */
async function makeZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) {
    zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/**
 * yazl refuses to write malicious entry names, so build a benign zip whose
 * entry name has the same byte length, then patch the filename bytes (which
 * appear in the local + central headers) to the malicious value. Equal length
 * keeps every zip offset/length field valid.
 */
async function makeMaliciousZip(maliciousName: string, content: string): Promise<Buffer> {
  const placeholder = "p".repeat(maliciousName.length);
  const buffer = await makeZip({ [placeholder]: content });
  const malicious = Buffer.from(maliciousName, "utf8");
  const safe = Buffer.from(placeholder, "utf8");
  let idx = buffer.indexOf(safe);
  while (idx !== -1) {
    malicious.copy(buffer, idx);
    idx = buffer.indexOf(safe, idx + safe.length);
  }
  return buffer;
}

describe("resolveSafeEntryPath", () => {
  const dest = "/tmp/codebase-dest";

  it("resolves a normal nested path inside destDir", () => {
    expect(resolveSafeEntryPath(dest, "src/index.ts")).toBe(join(dest, "src", "index.ts"));
  });

  it("rejects a '../' traversal escaping destDir", () => {
    expect(() => resolveSafeEntryPath(dest, "../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects a deep '../../' traversal", () => {
    expect(() => resolveSafeEntryPath(dest, "a/../../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects an absolute path", () => {
    expect(() => resolveSafeEntryPath(dest, "/etc/passwd")).toThrow(/outside target directory/);
  });
});

describe("extractArchiveBuffer (zip)", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("extracts a well-formed zip into the destination", async () => {
    const buffer = await makeZip({
      "README.md": "hello",
      "src/index.ts": "export const x = 1;",
    });
    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("creates nested directories from entries", async () => {
    const buffer = await makeZip({ "a/b/c.txt": "deep" });
    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readdirSync(join(dest, "a", "b"))).toContain("c.txt");
    expect(readFileSync(join(dest, "a", "b", "c.txt"), "utf8")).toBe("deep");
  });

  it("rejects a zip whose entry escapes the destination via '../' (Zip Slip)", async () => {
    const buffer = await makeMaliciousZip("../evil.txt", "pwned");
    const dest = newDir();

    await expect(extractArchiveBuffer(buffer, dest)).rejects.toThrow(
      /outside target directory|invalid relative path/
    );
    expect(existsSync(join(dest, "..", "evil.txt"))).toBe(false);
  });
});

describe("assertTarEntrySafe", () => {
  const dest = "/tmp/codebase-dest";

  it("accepts a normal nested path", () => {
    expect(assertTarEntrySafe(dest, "src/index.ts")).toBe(true);
  });

  it("rejects a '../' traversal escaping destDir", () => {
    expect(() => assertTarEntrySafe(dest, "../evil.txt")).toThrow(/outside target directory/);
  });

  it("rejects an absolute entry path", () => {
    expect(() => assertTarEntrySafe(dest, "/etc/passwd")).toThrow(/outside target directory/);
  });

  it("accepts a symlink whose target stays inside destDir", () => {
    expect(assertTarEntrySafe(dest, "link", "real.txt")).toBe(true);
  });

  it("rejects a symlink whose target escapes destDir", () => {
    expect(() => assertTarEntrySafe(dest, "link", "../../etc/passwd")).toThrow(
      /link escaping target directory/
    );
  });
});

describe("extractArchiveBuffer (tar.gz)", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-tar-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("extracts a well-formed tar.gz into the destination", async () => {
    const tar = await import("tar");
    const src = newDir();
    writeFileSync(join(src, "README.md"), "hello tar");
    mkdirSync(join(src, "src"));
    writeFileSync(join(src, "src", "index.ts"), "export const y = 2;");

    const tgz = newDir();
    const tgzPath = join(tgz, "out.tar.gz");
    await tar.create({ gzip: true, file: tgzPath, cwd: src }, ["README.md", "src"]);
    const buffer = readFileSync(tgzPath);

    const dest = newDir();
    await extractArchiveBuffer(buffer, dest);

    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("hello tar");
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const y = 2;");
  });

  it("rejects (without crashing) a tar whose entry escapes destDir", async () => {
    // dest is nested so `../evil.txt` would land in its parent if unguarded.
    const parent = newDir();
    const dest = join(parent, "extract");
    mkdirSync(dest);
    const buffer = makeRawTar({ "../evil.txt": "pwned" });

    await expect(extractArchiveBuffer(buffer, dest)).rejects.toThrow(/Refusing to extract/);
    // The escaping entry must never be written outside destDir.
    expect(existsSync(join(parent, "evil.txt"))).toBe(false);
  });

  it("rejects a tar.gz that exceeds the max uncompressed bytes", async () => {
    const tar = await import("tar");
    const src = newDir();
    writeFileSync(join(src, "big.txt"), "x".repeat(2000));
    const tgz = newDir();
    const tgzPath = join(tgz, "out.tar.gz");
    await tar.create({ gzip: true, file: tgzPath, cwd: src }, ["big.txt"]);
    const buffer = readFileSync(tgzPath);

    const dest = newDir();
    await expect(
      extractArchiveBuffer(buffer, dest, { maxBytes: 10, maxEntries: 1000 })
    ).rejects.toThrow(/maximum uncompressed size/);
  });

  it("rejects a tar.gz that exceeds the max entry count", async () => {
    const tar = await import("tar");
    const src = newDir();
    writeFileSync(join(src, "a.txt"), "a");
    writeFileSync(join(src, "b.txt"), "b");
    const tgz = newDir();
    const tgzPath = join(tgz, "out.tar.gz");
    await tar.create({ gzip: true, file: tgzPath, cwd: src }, ["a.txt", "b.txt"]);
    const buffer = readFileSync(tgzPath);

    const dest = newDir();
    await expect(
      extractArchiveBuffer(buffer, dest, { maxBytes: 1_000_000, maxEntries: 1 })
    ).rejects.toThrow(/maximum entry count/);
  });
});

describe("extractArchiveBuffer (zip) — extraction limits", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-ziplimit-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("rejects a zip that exceeds the max uncompressed bytes", async () => {
    const buffer = await makeZip({ "big.txt": "x".repeat(2000) });
    const dest = newDir();
    await expect(
      extractArchiveBuffer(buffer, dest, { maxBytes: 10, maxEntries: 1000 })
    ).rejects.toThrow(/maximum uncompressed size/);
  });

  it("rejects a zip that exceeds the max entry count", async () => {
    const buffer = await makeZip({ "a.txt": "a", "b.txt": "b" });
    const dest = newDir();
    await expect(
      extractArchiveBuffer(buffer, dest, { maxBytes: 1_000_000, maxEntries: 1 })
    ).rejects.toThrow(/maximum entry count/);
  });
});

describe("normalizeToRootTarGz — hidden files", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const d = mkdtempSync(join(tmpdir(), "codebase-archive-dot-test-"));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("keeps top-level dotfiles and dot folders in the snapshot", async () => {
    const tar = await import("tar");
    const src = newDir();
    writeFileSync(join(src, "readme.txt"), "visible");
    writeFileSync(join(src, ".env"), "SECRET=1");
    mkdirSync(join(src, ".github"));
    writeFileSync(join(src, ".github", "ci.yml"), "name: ci");
    const tgz = newDir();
    const tgzPath = join(tgz, "in.tar.gz");
    await tar.create({ gzip: true, file: tgzPath, cwd: src }, ["."]);

    const normalized = await normalizeToRootTarGz(readFileSync(tgzPath));
    const dest = newDir();
    await extractArchiveBuffer(normalized.data, dest);

    expect(readFileSync(join(dest, "readme.txt"), "utf8")).toBe("visible");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("SECRET=1");
    expect(readFileSync(join(dest, ".github", "ci.yml"), "utf8")).toBe("name: ci");
  });
});
