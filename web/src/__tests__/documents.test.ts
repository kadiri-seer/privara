import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detect } from "../engine/detect";
import { downloadOptions, readDocument, readDocx, writeDocx } from "../engine/documents";
import { uploadPath } from "../pages/Actions";

// jsdom's File has no arrayBuffer()/text(); browsers and Node's File do.
const file = (parts: (string | Buffer)[], name: string) => new File(parts, name) as unknown as globalThis.File;
const fixture = (name: string) => file([readFileSync(join(__dirname, "fixtures", name))], name);
const blobBytes = (blob: Blob) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = reject;
    r.readAsArrayBuffer(blob);
  });
const categories = (text: string) => detect(text).map((d) => `${d.category}:${text.slice(d.start, d.end)}`);

describe("reading documents", () => {
  it("reads a Word file, including bold runs, tables and line breaks", async () => {
    const doc = await readDocument(fixture("offer.docx"));
    expect(doc.kind).toBe("docx");
    expect(doc.text).toContain("Dear Sarah Mitchell, we are pleased");
    expect(doc.text).toContain("John Carter\tjohn@example.com\t(415) 555-0132");
    expect(doc.text).toContain("Kind regards,\nEmily Watson");
    const found = categories(doc.text);
    expect(found).toEqual(
      expect.arrayContaining([
        "PERSON:Sarah Mitchell",
        "AMOUNT:$85,000",
        "EMAIL:hr@acme-example.com",
        "PHONE:+44 20 7946 0958",
        "PERSON:John Carter",
        "PHONE:(415) 555-0132",
        "PERSON:Emily Watson",
      ]),
    );
  });

  it("reads every sheet of an Excel file, one row per line", async () => {
    const doc = await readDocument(fixture("customers.xlsx"));
    expect(doc.parts).toEqual({ count: 2, label: "sheets" });
    expect(doc.text).toContain("Customers\nName\tEmail\tPhone\tAmount\nJane Doe\tjane@doe.com\t+1 415 555 2671\t$120.00");
    expect(doc.text).toContain("Notes\nCall Lisa Wong about card 4111 1111 1111 1111");
    expect(categories(doc.text)).toEqual(expect.arrayContaining(["PERSON:Jane Doe", "PERSON:Mark Lee", "PERSON:Lisa Wong", "CARD:4111 1111 1111 1111"]));
  });

  it("reads PowerPoint slides in order", async () => {
    const doc = await readDocument(fixture("review.pptx"));
    expect(doc.parts).toEqual({ count: 1, label: "slide" });
    expect(doc.text).toBe("Slide 1\nQ3 review\nOwner: Tom Hardy\nBudget: €1.2 million\nServer 192.168.1.20");
    expect(categories(doc.text)).toEqual(["PERSON:Tom Hardy", "AMOUNT:€1.2 million", "IP:192.168.1.20"]);
  });

  it("reads plain text formats as they are", async () => {
    const doc = await readDocument(file(["name,email\r\nJane Doe,jane@doe.com\r\n"], "people.csv"));
    expect(doc).toMatchObject({ kind: "text", text: "name,email\nJane Doe,jane@doe.com", truncated: false });
  });

  it("explains files it can't read", async () => {
    await expect(readDocument(fixture("old.doc"))).rejects.toThrow("Older .doc files can’t be read");
    await expect(readDocument(file(["x"], "photo.png"))).rejects.toThrow(".png files aren’t supported");
    await expect(readDocument(file([], "empty.txt"))).rejects.toThrow("That file is empty.");
    await expect(readDocument(file(["not a zip"], "broken.docx"))).rejects.toThrow("couldn’t be opened");
    await expect(readDocument(file(["a\u0000b"], "binary.txt"))).rejects.toThrow("doesn’t look like text");
  });

  it("caps very long documents", async () => {
    const doc = await readDocument(file(["word ".repeat(120_000)], "long.txt"));
    expect(doc.truncated).toBe(true);
    expect(doc.text.length).toBe(500_000);
  });
});

describe("saving documents", () => {
  it("writes a Word file that reads back the same text", async () => {
    const text = "[PERSON_1] owes [AMOUNT_1]\n\nName\tEmail\nA & B <c>";
    const blob = await writeDocx(text);
    const buf = await blobBytes(blob);
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
    expect(await readDocx(buf)).toBe(text);
  });

  it("offers the original format where it can", () => {
    expect(downloadOptions({ name: "offer.docx", kind: "docx" }, "redacted").map((o) => o.filename)).toEqual(["offer.redacted.docx", "offer.redacted.txt"]);
    expect(downloadOptions({ name: "people.csv", kind: "text" }, "redacted").map((o) => o.filename)).toEqual(["people.redacted.csv", "people.redacted.txt"]);
    expect(downloadOptions({ name: "invoice.pdf", kind: "pdf" }, "redacted").map((o) => o.filename)).toEqual(["invoice.redacted.txt", "invoice.redacted.docx"]);
    expect(downloadOptions({ name: "offer.redacted.docx", kind: "docx" }, "restored")[0].filename).toBe("offer.restored.docx");
    expect(downloadOptions(null, "restored").map((o) => o.filename)).toEqual(["privara-restored.txt", "privara-restored.docx"]);
  });

  it("gives uploaded files a safe sandbox path", () => {
    expect(uploadPath({ name: "../../Q3 Report (final).pdf", kind: "pdf" })).toBe("notes/Q3-Report-final.txt");
    expect(uploadPath({ name: "people.csv", kind: "text" })).toBe("notes/people.csv");
  });
});
