// Reads documents in the browser. Nothing here touches the network: files are read from disk with the
// File API, and PDF, Word, Excel and PowerPoint files are unpacked in the page.

import type JSZip from "jszip";

const loadZip = async () => (await import("jszip")).default;

export const MAX_DOC_BYTES = 15 * 1024 * 1024;
export const MAX_DOC_CHARS = 500_000;

const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "html", "htm", "yaml", "yml", "eml", "ini", "srt", "vtt"];
const OFFICE_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx"];

/** Value for an <input type="file" accept="…">. */
export const ACCEPT = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS].map((e) => `.${e}`).join(",");
export const FORMATS_LABEL = "PDF, Word, Excel, PowerPoint, TXT, Markdown, CSV, JSON, HTML and email files";

export type DocKind = "text" | "pdf" | "docx" | "xlsx" | "pptx";

export interface LoadedDocument {
  name: string;
  kind: DocKind;
  text: string;
  /** Pages, sheets or slides, when the format has them. */
  parts?: { count: number; label: string };
  truncated: boolean;
}

export class DocumentError extends Error {}

export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function baseName(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** File bytes, with a FileReader fallback for browsers without Blob.arrayBuffer(). */
function bytesOf(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new DocumentError("That file couldn’t be read."));
    reader.readAsArrayBuffer(file);
  });
}

export async function readDocument(file: File): Promise<LoadedDocument> {
  const ext = extensionOf(file.name);
  if (["doc", "xls", "ppt"].includes(ext)) {
    throw new DocumentError(`Older .${ext} files can’t be read. Save it as .${ext}x or PDF and try again.`);
  }
  if (!TEXT_EXTENSIONS.includes(ext) && !OFFICE_EXTENSIONS.includes(ext)) {
    throw new DocumentError(`.${ext || "?"} files aren’t supported. Try ${FORMATS_LABEL}.`);
  }
  if (file.size > MAX_DOC_BYTES) throw new DocumentError("That file is larger than 15 MB.");
  if (file.size === 0) throw new DocumentError("That file is empty.");

  let kind: DocKind = "text";
  let text: string;
  let parts: LoadedDocument["parts"];
  if (ext === "pdf") {
    kind = "pdf";
    const r = await readPdf(await bytesOf(file));
    text = r.text;
    parts = { count: r.pages, label: r.pages === 1 ? "page" : "pages" };
  } else if (ext === "docx") {
    kind = "docx";
    text = await readDocx(await bytesOf(file));
  } else if (ext === "xlsx") {
    kind = "xlsx";
    const r = await readXlsx(await bytesOf(file));
    text = r.text;
    parts = { count: r.sheets, label: r.sheets === 1 ? "sheet" : "sheets" };
  } else if (ext === "pptx") {
    kind = "pptx";
    const r = await readPptx(await bytesOf(file));
    text = r.text;
    parts = { count: r.slides, label: r.slides === 1 ? "slide" : "slides" };
  } else {
    text = new TextDecoder().decode(await bytesOf(file));
    if (text.includes("\u0000")) throw new DocumentError("That file doesn’t look like text.");
  }

  text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) {
    throw new DocumentError(
      kind === "pdf"
        ? "This PDF has no selectable text. It’s probably a scan, and Privara can’t read text in images yet."
        : "No text was found in that file.",
    );
  }
  const truncated = text.length > MAX_DOC_CHARS;
  return { name: file.name, kind, text: truncated ? text.slice(0, MAX_DOC_CHARS) : text, parts, truncated };
}

// ---- PDF ---------------------------------------------------------------------------------------
async function readPdf(data: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerUrl = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
    }).promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new DocumentError("This PDF is password-protected. Remove the password and try again.");
    throw new DocumentError("That PDF couldn’t be read. It may be damaged.");
  }
  const pages: string[] = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total <= MAX_DOC_CHARS; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      out += item.str;
      if (item.hasEOL) out += "\n";
    }
    pages.push(out.trim());
    total += out.length;
    page.cleanup();
  }
  const count = doc.numPages;
  await doc.destroy();
  return { text: pages.join("\n\n"), pages: count };
}

// ---- Office Open XML ---------------------------------------------------------------------------
async function openZip(data: ArrayBuffer) {
  try {
    return await (await loadZip()).loadAsync(new Uint8Array(data));
  } catch {
    throw new DocumentError("That file couldn’t be opened. It may be damaged or password-protected.");
  }
}

async function xmlOf(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}

const byNumber = (prefix: RegExp) => (a: string, b: string) => Number(a.match(prefix)?.[1] ?? 0) - Number(b.match(prefix)?.[1] ?? 0);

function childrenNamed(el: Element, local: string) {
  return Array.from(el.children).filter((c) => c.localName === local);
}

/** Text of a Word paragraph: runs, tabs and line breaks in document order. */
function wordParagraph(p: Element): string {
  let out = "";
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      switch (child.localName) {
        case "t":
          out += child.textContent ?? "";
          break;
        case "tab":
          out += "\t";
          break;
        case "br":
        case "cr":
          out += "\n";
          break;
        case "delText":
        case "instrText":
          break;
        default:
          walk(child);
      }
    }
  };
  walk(p);
  return out;
}

function wordBlocks(container: Element, lines: string[]) {
  for (const el of Array.from(container.children)) {
    if (el.localName === "p") lines.push(wordParagraph(el));
    else if (el.localName === "tbl") {
      for (const row of childrenNamed(el, "tr")) {
        const cells = childrenNamed(row, "tc").map((tc) =>
          childrenNamed(tc, "p")
            .map(wordParagraph)
            .join(" ")
            .trim(),
        );
        lines.push(cells.join("\t"));
      }
      lines.push("");
    } else if (el.localName === "sdt") {
      const content = childrenNamed(el, "sdtContent")[0];
      if (content) wordBlocks(content, lines);
    }
  }
}

export async function readDocx(data: ArrayBuffer): Promise<string> {
  const zip = await openZip(data);
  const doc = await xmlOf(zip, "word/document.xml");
  if (!doc) throw new DocumentError("That Word file couldn’t be read.");
  const body = doc.getElementsByTagNameNS("*", "body")[0];
  const lines: string[] = [];
  if (body) wordBlocks(body, lines);
  return lines.join("\n");
}

export async function readXlsx(data: ArrayBuffer): Promise<{ text: string; sheets: number }> {
  const zip = await openZip(data);
  const shared: string[] = [];
  const sst = await xmlOf(zip, "xl/sharedStrings.xml");
  if (sst) {
    for (const si of Array.from(sst.getElementsByTagNameNS("*", "si"))) {
      shared.push(Array.from(si.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join(""));
    }
  }
  const names = (await xmlOf(zip, "xl/workbook.xml"))?.getElementsByTagNameNS("*", "sheet");
  const sheetFiles = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort(byNumber(/sheet(\d+)\.xml$/));
  const sections: string[] = [];
  for (const [i, path] of sheetFiles.entries()) {
    const sheet = await xmlOf(zip, path);
    if (!sheet) continue;
    const rows: string[] = [];
    for (const row of Array.from(sheet.getElementsByTagNameNS("*", "row"))) {
      const cells: string[] = [];
      for (const c of childrenNamed(row, "c")) {
        const col = columnIndex(c.getAttribute("r"));
        const type = c.getAttribute("t");
        let value = "";
        if (type === "s") value = shared[Number(childrenNamed(c, "v")[0]?.textContent)] ?? "";
        else if (type === "inlineStr") value = Array.from(c.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join("");
        else value = childrenNamed(c, "v")[0]?.textContent ?? "";
        if (col !== null) cells[col] = value.replace(/[\t\n]+/g, " ");
        else cells.push(value.replace(/[\t\n]+/g, " "));
      }
      const line = Array.from(cells, (v) => v ?? "").join("\t").replace(/\t+$/, "");
      if (line.trim()) rows.push(line);
    }
    const name = names?.[i]?.getAttribute("name") ?? `Sheet ${i + 1}`;
    sections.push(`${name}\n${rows.join("\n")}`);
  }
  return { text: sections.join("\n\n"), sheets: sheetFiles.length };
}

function columnIndex(ref: string | null): number | null {
  const letters = ref?.match(/^[A-Z]+/)?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readPptx(data: ArrayBuffer): Promise<{ text: string; slides: number }> {
  const zip = await openZip(data);
  const slideFiles = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort(byNumber(/slide(\d+)\.xml$/));
  const sections: string[] = [];
  for (const [i, path] of slideFiles.entries()) {
    const slide = await xmlOf(zip, path);
    if (!slide) continue;
    const paras = Array.from(slide.getElementsByTagNameNS("*", "p"))
      .map((p) =>
        Array.from(p.getElementsByTagNameNS("*", "t"))
          .map((t) => t.textContent ?? "")
          .join(""),
      )
      .filter((t) => t.trim());
    sections.push(`Slide ${i + 1}\n${paras.join("\n")}`);
  }
  return { text: sections.join("\n\n"), slides: slideFiles.length };
}

// ---- writing -----------------------------------------------------------------------------------
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Characters XML 1.0 doesn't allow.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A plain Word document: one paragraph per line, tabs kept. */
export async function writeDocx(text: string): Promise<Blob> {
  const paragraphs = text
    .replace(INVALID_XML, "")
    .split("\n")
    .map((line) => {
      const runs = line
        .split("\t")
        .map((part, i) => `${i ? "<w:tab/>" : ""}${part ? `<w:t xml:space="preserve">${xmlEscape(part)}</w:t>` : ""}`)
        .join("");
      return `<w:p><w:r>${runs}</w:r></w:p>`;
    })
    .join("");
  const zip = new (await loadZip())();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export interface DownloadOption {
  label: string;
  filename: string;
  make: (text: string) => Promise<Blob> | Blob;
}

const textBlob = (type: string) => (text: string) => new Blob([text], { type: `${type};charset=utf-8` });

/** Which formats the redacted (or restored) text can be saved as, given the original file. */
export function downloadOptions(doc: Pick<LoadedDocument, "name" | "kind"> | null, suffix: string): DownloadOption[] {
  const stem = doc ? `${baseName(doc.name).replace(/\.(redacted|restored)$/i, "")}.${suffix}` : `privara-${suffix}`;
  const txt: DownloadOption = { label: ".txt", filename: `${stem}.txt`, make: textBlob("text/plain") };
  const docx: DownloadOption = { label: ".docx", filename: `${stem}.docx`, make: writeDocx };
  if (!doc) return [txt, docx];
  if (doc.kind === "text") {
    const ext = extensionOf(doc.name);
    const mime = ext === "csv" ? "text/csv" : ext === "json" ? "application/json" : ext === "md" || ext === "markdown" ? "text/markdown" : ext === "html" || ext === "htm" ? "text/html" : "text/plain";
    return ext === "txt" ? [txt, docx] : [{ label: `.${ext}`, filename: `${stem}.${ext}`, make: textBlob(mime) }, txt];
  }
  if (doc.kind === "docx") return [docx, txt];
  return [txt, docx];
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
