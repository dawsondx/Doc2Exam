import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";
import { EngineError, PUBLIC_LIMITS, type SourceBlock } from "./model";
import { splitDocxItem, splitPdfPage } from "./text";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ParseResult {
  blocks: SourceBlock[];
  pageCount: number | null;
  truncated: boolean;
  preview: string;
}

interface DocxItem {
  text: string;
  locatorKind: string;
  label: string;
  headingPath: string[];
}

function capBlocks(blocks: SourceBlock[]): { blocks: SourceBlock[]; truncated: boolean } {
  let chars = 0;
  let truncated = false;
  const kept: SourceBlock[] = [];
  for (const block of blocks) {
    if (chars >= PUBLIC_LIMITS.maxDocumentChars) {
      truncated = true;
      break;
    }
    const remaining = PUBLIC_LIMITS.maxDocumentChars - chars;
    if (block.text.length > remaining) {
      kept.push({ ...block, text: block.text.slice(0, remaining) });
      truncated = true;
      break;
    }
    kept.push(block);
    chars += block.text.length;
  }
  return { blocks: kept, truncated };
}

async function extractPdf(documentId: string, buffer: ArrayBuffer): Promise<ParseResult> {
  let document: pdfjs.PDFDocumentProxy;
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  try {
    document = await task.promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      throw new EngineError(422, "DOCUMENT_ENCRYPTED", "文档已加密，无法解析。", "解除密码后重试");
    }
    throw new EngineError(422, "DOCUMENT_PARSE_FAILED", "文档无法解析，可能已损坏或格式特殊。", "更换文件");
  }

  try {
    const totalPages = document.numPages;
    if (totalPages > PUBLIC_LIMITS.maxPdfPages) {
      // 超出公共体验上限时只解析前 200 页，并在界面上说明。
    }
    const pageLimit = Math.min(totalPages, PUBLIC_LIMITS.maxPdfPages);
    const blocks: SourceBlock[] = [];
    let lowTextPages = 0;
    let emptyPages = 0;

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of content.items) {
        const textItem = item as { str?: string; hasEOL?: boolean };
        if (typeof textItem.str !== "string") continue;
        line += textItem.str;
        if (textItem.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      const pageText = lines.join("\n").replaceAll("\u0000", "");
      const printable = pageText.replace(/\s/g, "").length;
      if (printable < 20) {
        lowTextPages += 1;
        if (!printable) emptyPages += 1;
      }
      blocks.push(...splitPdfPage(documentId, pageText, pageNumber));
      if (blocks.reduce((sum, block) => sum + block.text.length, 0) >= PUBLIC_LIMITS.maxDocumentChars) break;
    }

    if (totalPages > 0 && lowTextPages / pageLimit >= 0.8) {
      if (emptyPages === pageLimit) {
        throw new EngineError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。", "更换文件或先完成 OCR");
      }
      throw new EngineError(
        422,
        "SCANNED_PDF_UNSUPPORTED",
        "检测到扫描件，当前版本不支持 OCR。",
        "先用受信任工具完成 OCR 后再上传",
      );
    }

    const capped = capBlocks(blocks);
    if (!capped.blocks.length) {
      throw new EngineError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。", "更换文件或先完成 OCR");
    }
    return {
      blocks: capped.blocks,
      pageCount: totalPages,
      truncated: capped.truncated || totalPages > pageLimit,
      preview: capped.blocks.map((block) => block.text).join(" ").slice(0, 300),
    };
  } finally {
    void task.destroy();
  }
}

function headingLevel(tag: string): number | null {
  const match = /^h([1-6])$/.exec(tag);
  return match ? Number(match[1]) : null;
}

async function extractDocx(documentId: string, buffer: ArrayBuffer): Promise<ParseResult> {
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) },
    );
    html = result.value;
  } catch {
    throw new EngineError(422, "DOCUMENT_PARSE_FAILED", "文档无法解析，可能已损坏或格式特殊。", "更换文件");
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const items: DocxItem[] = [];
  let headingPath: string[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;

  const textOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      const level = headingLevel(tag);
      if (level) {
        const text = textOf(child);
        if (!text) continue;
        headingPath = headingPath.slice(0, level - 1);
        headingPath.push(text);
        items.push({
          text,
          locatorKind: "docx_paragraph",
          label: headingPath.join(" > "),
          headingPath: [...headingPath],
        });
      } else if (tag === "p") {
        const text = textOf(child);
        if (!text) continue;
        paragraphIndex += 1;
        items.push({
          text,
          locatorKind: "docx_paragraph",
          label: [...headingPath, `段落 ${paragraphIndex}`].join(" > "),
          headingPath: [...headingPath],
        });
      } else if (tag === "table") {
        tableIndex += 1;
        for (const [rowIndex, row] of Array.from(child.querySelectorAll("tr")).entries()) {
          const cells = Array.from(row.children)
            .map((cell) => textOf(cell))
            .filter(Boolean);
          const text = cells.join(" | ");
          if (!text) continue;
          items.push({
            text,
            locatorKind: "docx_table_row",
            label: `表格 ${tableIndex} > 第 ${rowIndex + 1} 行`,
            headingPath: [...headingPath],
          });
        }
      } else if (tag === "ul" || tag === "ol") {
        for (const item of Array.from(child.children)) {
          const text = textOf(item);
          if (!text) continue;
          paragraphIndex += 1;
          items.push({
            text,
            locatorKind: "docx_paragraph",
            label: [...headingPath, `段落 ${paragraphIndex}`].join(" > "),
            headingPath: [...headingPath],
          });
        }
      } else {
        walk(child);
      }
    }
  };

  walk(parsed.body);

  const blocks: SourceBlock[] = [];
  for (const item of items) {
    blocks.push(...splitDocxItem(documentId, item.text, item.locatorKind, item.label));
  }
  const capped = capBlocks(blocks);
  if (!capped.blocks.length) {
    throw new EngineError(422, "DOCUMENT_NO_TEXT", "文档没有可用于出题的文字。", "更换文件或先完成 OCR");
  }
  return {
    blocks: capped.blocks,
    pageCount: null,
    truncated: capped.truncated,
    preview: capped.blocks.map((block) => block.text).join(" ").slice(0, 300),
  };
}

export async function parseDocumentFile(documentId: string, file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase();
  if (file.size > PUBLIC_LIMITS.maxFileBytes) {
    throw new EngineError(422, "DOCUMENT_LIMIT_EXCEEDED", "单个文件不能超过 15 MB。", "压缩或拆分文档");
  }
  if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
    throw new EngineError(422, "DOCUMENT_TYPE_UNSUPPORTED", "仅支持 PDF 与 DOCX 文件。", "更换文件");
  }
  const buffer = await file.arrayBuffer();
  return name.endsWith(".pdf")
    ? extractPdf(documentId, buffer)
    : extractDocx(documentId, buffer);
}

export function mediaTypeOf(file: File): "pdf" | "docx" {
  return file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
}
