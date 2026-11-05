/**
 * Minimal, dependency-free PDF writer.
 *
 * The project deliberately carries no PDF library: one report format does not
 * justify a dependency tree. This emits a valid PDF 1.4 document with the
 * built-in Helvetica fonts, automatic pagination and simple text tables.
 *
 * Scope is intentionally small — headings, paragraphs and tables. It is not a
 * typesetting engine, and it makes no attempt to embed custom fonts.
 */

const PAGE_WIDTH = 595.28; // A4, in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Characters outside WinAnsi that appear in the product's copy/labels. */
const TRANSLITERATIONS = new Map([
  ["—", "-"],
  ["–", "-"],
  ["’", "'"],
  ["‘", "'"],
  ["“", '"'],
  ["”", '"'],
  ["•", "-"],
  ["…", "..."],
  ["→", "->"],
  ["≤", "<="],
  ["≥", ">="],
  ["✔", "ok"],
  ["✓", "ok"],
]);

function sanitise(text) {
  let out = "";
  for (const char of String(text ?? "")) {
    if (TRANSLITERATIONS.has(char)) {
      out += TRANSLITERATIONS.get(char);
    } else if (char.codePointAt(0) <= 0xff) {
      out += char;
    } else {
      out += "?";
    }
  }
  return out.replace(/[\r\n]+/g, " ");
}

function escapePdf(text) {
  return sanitise(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Approximate Helvetica advance width; good enough for wrapping and truncation. */
function wrapText(text, maxWidth, fontSize) {
  const averageCharWidth = fontSize * 0.5;
  const maxChars = Math.max(8, Math.floor(maxWidth / averageCharWidth));
  const words = sanitise(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    // A single unbroken token longer than the line is hard-split.
    while (current.length > maxChars) {
      lines.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

class PdfDocument {
  constructor(title) {
    this.title = title;
    this.pages = [];
    this.current = [];
    this.y = PAGE_HEIGHT - MARGIN;
    this.startPage();
  }

  startPage() {
    if (this.current.length) this.pages.push(this.current);
    this.current = [];
    this.y = PAGE_HEIGHT - MARGIN;
  }

  ensureSpace(height) {
    if (this.y - height < MARGIN) {
      this.footer();
      this.startPage();
    }
  }

  text(value, { size = 10, bold = false, color = "0 0 0", gap = 4, x = MARGIN } = {}) {
    const font = bold ? "/F2" : "/F1";
    const lines = wrapText(value, CONTENT_WIDTH - (x - MARGIN), size);
    for (const line of lines) {
      this.ensureSpace(size + gap);
      this.y -= size;
      this.current.push(`BT ${color} rg ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${this.y.toFixed(2)} Tm (${escapePdf(line)}) Tj ET`);
      this.y -= gap;
    }
  }

  heading(value) {
    this.ensureSpace(30);
    this.y -= 8;
    this.text(value, { size: 14, bold: true, gap: 6 });
    this.y -= 2;
  }

  divider() {
    this.ensureSpace(10);
    this.y -= 6;
    this.current.push(`${MARGIN} ${this.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l 0.75 w 0.8 0.8 0.8 RG S`);
    this.y -= 6;
  }

  keyValues(pairs) {
    for (const [label, value] of pairs) {
      this.text(`${label}: ${value}`, { size: 10, gap: 3 });
    }
  }

  /** Fixed-width columns; the last column absorbs any remaining space. */
  table(columns, rows) {
    const fontSize = 9;
    const rowHeight = 14;
    const widths = columns.map((column) => column.width ?? CONTENT_WIDTH / columns.length);

    const drawRow = (cells, bold) => {
      this.ensureSpace(rowHeight);
      let x = MARGIN;
      cells.forEach((cell, index) => {
        const width = widths[index] ?? widths.at(-1);
        const text = String(cell ?? "");
        // Truncate rather than wrap inside a table: wrapped rows would break the
        // column alignment that makes a report scannable.
        const maxChars = Math.max(3, Math.floor(width / (fontSize * 0.5)) - 1);
        const clipped = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
        this.current.push(
          `BT /${bold ? "F2" : "F1"} ${fontSize} Tf 1 0 0 1 ${x.toFixed(2)} ${(this.y - fontSize).toFixed(2)} Tm (${escapePdf(clipped)}) Tj ET`,
        );
        x += width;
      });
      this.y -= rowHeight;
    };

    drawRow(columns.map((column) => column.label), true);
    this.current.push(`${MARGIN} ${this.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l 0.5 w 0.85 0.85 0.85 RG S`);
    this.y -= 3;
    for (const row of rows) drawRow(row, false);
    this.y -= 6;
  }

  footer() {
    const label = `Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
    this.current.push(
      `BT 0.45 0.45 0.45 rg /F1 8 Tf 1 0 0 1 ${MARGIN} ${(MARGIN / 2).toFixed(2)} Tm (${escapePdf(label)}) Tj ET`,
    );
  }

  build() {
    if (this.current.length) {
      this.footer();
      this.pages.push(this.current);
    }
    if (!this.pages.length) {
      this.footer();
      this.pages.push(this.current);
    }

    const objects = [];
    const pageObjectNumber = (index) => 5 + index * 2;

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages
      .map((_, index) => `${pageObjectNumber(index)} 0 R`)
      .join(" ")}] >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

    this.pages.forEach((commands, index) => {
      const content = commands.join("\n");
      const pageNumber = pageObjectNumber(index);
      const contentNumber = pageNumber + 1;
      objects[pageNumber] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`;
      objects[contentNumber] = `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
    });

    let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
    const offsets = [];
    for (let i = 1; i < objects.length; i += 1) {
      const object = objects[i];
      if (!object) continue;
      offsets[i] = Buffer.byteLength(pdf, "latin1");
      pdf += `${i} 0 obj\n${object}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    const maxObject = objects.length - 1;
    pdf += `xref\n0 ${maxObject + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= maxObject; i += 1) {
      const offset = offsets[i] ?? 0;
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
  }
}

/**
 * @param {object} report
 * @param {string} report.title
 * @param {string} [report.subtitle]
 * @param {Array<[string, unknown]>} [report.meta]   key/value lines under the title
 * @param {Array<object>} [report.sections]          { heading, text?, pairs?, table? }
 */
export function buildPdf({ title, subtitle, meta = [], sections = [] }) {
  const doc = new PdfDocument(title);

  doc.text(title, { size: 20, bold: true, gap: 8 });
  if (subtitle) doc.text(subtitle, { size: 11, color: "0.35 0.35 0.35", gap: 8 });
  if (meta.length) doc.keyValues(meta);
  doc.divider();

  for (const section of sections) {
    if (section.heading) doc.heading(section.heading);
    if (section.text) doc.text(section.text, { size: 10, gap: 4 });
    if (section.pairs) doc.keyValues(section.pairs);
    if (section.table) doc.table(section.table.columns, section.table.rows);
  }

  return doc.build();
}

/** Send a generated document as a download. */
export function sendPdf(res, filename, buffer) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buffer.length);
  return res.send(buffer);
}

export default { buildPdf, sendPdf };
