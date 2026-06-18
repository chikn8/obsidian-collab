export interface WikiLinkRewriteOptions {
  oldRelPath: string;
  newRelPath: string;
  sourceRelPath?: string;
  resolveLink?: (linkPath: string, sourceRelPath: string) => string | null | undefined;
}

export interface WikiLinkRewriteResult {
  content: string;
  replacements: number;
}

export function rewriteObsidianLinks(content: string, opts: WikiLinkRewriteOptions): WikiLinkRewriteResult {
  const oldRel = normalizeRel(opts.oldRelPath);
  const newRel = normalizeRel(opts.newRelPath);
  const sourceRel = normalizeRel(opts.sourceRelPath || "");
  let replacements = 0;
  let inFence: "`" | "~" | null = null;

  const rewritten = content.split(/(\r\n|\n|\r)/).map((part) => {
    if (part === "\n" || part === "\r" || part === "\r\n") return part;
    const fence = fenceMarker(part);
    if (fence) {
      if (inFence === fence) inFence = null;
      else if (!inFence) inFence = fence;
      return part;
    }
    if (inFence) return part;
    return rewriteLine(part, (raw) => {
      const next = rewriteRawLink(raw, oldRel, newRel, sourceRel, opts.resolveLink);
      if (next !== raw) replacements++;
      return next;
    });
  }).join("");

  return { content: rewritten, replacements };
}

function rewriteLine(line: string, rewrite: (raw: string) => string): string {
  let out = "";
  let i = 0;
  let codeTickLen = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const len = countRun(line, i, "`");
      out += line.slice(i, i + len);
      if (codeTickLen === 0) codeTickLen = len;
      else if (len === codeTickLen) codeTickLen = 0;
      i += len;
      continue;
    }
    if (codeTickLen === 0) {
      const embed = line[i] === "!" && line.slice(i + 1, i + 3) === "[[";
      const plain = line.slice(i, i + 2) === "[[";
      if (embed || plain) {
        const open = i + (embed ? 1 : 0);
        const close = line.indexOf("]]", open + 2);
        if (close >= 0) {
          out += embed ? "![[" : "[[";
          out += rewrite(line.slice(open + 2, close));
          out += "]]";
          i = close + 2;
          continue;
        }
      }
    }
    out += line[i];
    i++;
  }
  return out;
}

function rewriteRawLink(
  raw: string,
  oldRel: string,
  newRel: string,
  sourceRel: string,
  resolveLink?: WikiLinkRewriteOptions["resolveLink"]
): string {
  const pipe = raw.indexOf("|");
  const target = pipe >= 0 ? raw.slice(0, pipe) : raw;
  const alias = pipe >= 0 ? raw.slice(pipe) : "";
  const split = splitSubpath(target);
  if (!split.path) return raw;

  const resolved = resolveLink?.(split.path, sourceRel);
  const matches = resolved == null
    ? directLinkMatch(split.path, oldRel)
    : sameMarkdownTarget(resolved, oldRel);
  if (!matches) return raw;

  return `${replacementTarget(split.path, newRel)}${split.subpath}${alias}`;
}

function splitSubpath(target: string): { path: string; subpath: string } {
  const idx = target.search(/[#^]/);
  if (idx < 0) return { path: target, subpath: "" };
  return { path: target.slice(0, idx), subpath: target.slice(idx) };
}

function replacementTarget(originalPath: string, newRel: string): string {
  const originalHadSlash = originalPath.includes("/");
  const originalHadMd = /\.md$/i.test(originalPath);
  const next = originalHadSlash ? newRel : basename(newRel);
  if (/\.md$/i.test(next) && !originalHadMd) return next.slice(0, -3);
  return next;
}

function directLinkMatch(linkPath: string, oldRel: string): boolean {
  const clean = normalizeRel(linkPath);
  if (sameMarkdownTarget(clean, oldRel)) return true;
  if (clean.includes("/")) return false;
  return stripMarkdownExt(clean).toLowerCase() === stripMarkdownExt(basename(oldRel)).toLowerCase();
}

function sameMarkdownTarget(a: string, b: string): boolean {
  return stripMarkdownExt(normalizeRel(a)).toLowerCase() === stripMarkdownExt(normalizeRel(b)).toLowerCase();
}

function stripMarkdownExt(path: string): string {
  return path.replace(/\.md$/i, "");
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function basename(path: string): string {
  return normalizeRel(path).split("/").pop() || path;
}

function fenceMarker(line: string): "`" | "~" | null {
  const m = line.match(/^\s*(```+|~~~+)/);
  if (!m) return null;
  return m[1][0] as "`" | "~";
}

function countRun(line: string, start: number, ch: string): number {
  let i = start;
  while (i < line.length && line[i] === ch) i++;
  return i - start;
}
