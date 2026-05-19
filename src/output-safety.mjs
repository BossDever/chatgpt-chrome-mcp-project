import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function defaultArtifactRoot() {
  return path.resolve(process.cwd(), ".chatgpt-chrome-mcp", "artifacts");
}

export function isUnsafeFileName(name) {
  const value = String(name ?? "");
  return (
    !value ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
    WINDOWS_RESERVED_NAMES.test(value)
  );
}

export function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveSafeOutputDir({ outputDir, rootDir = defaultArtifactRoot() } = {}) {
  const root = path.resolve(rootDir);
  const requested = outputDir ? String(outputDir).trim() : "";
  if (requested.split(/[\\/]+/).includes("..")) {
    throw new Error("UNSAFE_OUTPUT_DIR");
  }

  const resolved = requested
    ? path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested))
    : root;
  if (!pathInside(root, resolved)) {
    throw new Error("UNSAFE_OUTPUT_DIR");
  }

  await mkdir(root, { recursive: true });
  await mkdir(resolved, { recursive: true });
  const realRoot = await realpath(root);
  const realOutputDir = await realpath(resolved);
  if (!pathInside(realRoot, realOutputDir)) {
    throw new Error("UNSAFE_OUTPUT_DIR_SYMLINK");
  }
  return {
    outputDir: realOutputDir,
    outputRoot: realRoot,
    relativeOutputDir: path.relative(realRoot, realOutputDir) || ".",
  };
}

export function safeRelativeArtifactPath(filePath, outputRoot) {
  const relative = path.relative(outputRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("UNSAFE_ARTIFACT_PATH");
  }
  return relative;
}
