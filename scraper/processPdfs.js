import fs from "fs/promises";
import path from "path";
import axios from "axios";
import pdfParse from "pdf-parse";
import { exec as _exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const exec = promisify(_exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const SCRAPED_DATA_DIR = path.join(ROOT_DIR, "scraped_data");

const normalizePdfKey = (url = "") => {
  if (typeof url !== "string" || !url.trim()) return null;
  return url.split("#")[0].split("?")[0].trim().toLowerCase();
};

async function resolveTargetFile(cliPath) {
  if (cliPath) {
    const absolute = path.isAbsolute(cliPath)
        ? cliPath
        : path.resolve(ROOT_DIR, cliPath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Provided path is not a file: ${absolute}`);
    }
    return absolute;
  }

  await fs.mkdir(SCRAPED_DATA_DIR, { recursive: true });
  const entries = await fs.readdir(SCRAPED_DATA_DIR);

  // Look for hybrid scraper files first
  const hybridFiles = entries
      .filter((name) => name.includes("hybrid_complete") && name.endsWith(".json"))
      .sort();

  if (hybridFiles.length > 0) {
    return path.join(SCRAPED_DATA_DIR, hybridFiles[hybridFiles.length - 1]);
  }

  // Fallback to any JSON file
  const jsonFiles = entries
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .sort();

  if (!jsonFiles.length) {
    throw new Error(
        `No JSON snapshots found inside ${SCRAPED_DATA_DIR}. Run the scraper first.`
    );
  }

  return path.join(SCRAPED_DATA_DIR, jsonFiles[jsonFiles.length - 1]);
}

async function loadScrapedJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);

  // Detect format
  const isHybrid = data.metadata?.scrapeType === 'hybrid_api_and_dom_with_navigation' ||
      data.staticPages || data.apiData;

  console.log(`[pdf] Detected ${isHybrid ? 'HYBRID' : 'LEGACY'} scraper format`);

  // Normalize to ensure required structures exist
  if (isHybrid) {
    // Hybrid format
    if (!data.allPdfUrls) data.allPdfUrls = [];
    if (!data.processedPdfs) data.processedPdfs = [];
  } else {
    // Legacy format
    if (!data.documents || typeof data.documents !== "object") {
      data.documents = {};
    }
    if (!Array.isArray(data.documents.pdfs)) {
      data.documents.pdfs = [];
    }
    if (!data.links || typeof data.links !== "object") {
      data.links = {};
    }
    if (!Array.isArray(data.links.pdf)) {
      data.links.pdf = [];
    }
  }

  if (!data.statistics || typeof data.statistics !== "object") {
    data.statistics = {};
  }

  return data;
}

function collectPdfCandidates(scrapedData) {
  const candidates = new Map();

  const remember = (url, extra = {}) => {
    const key = normalizePdfKey(url);
    if (!key) return;

    if (!candidates.has(key)) {
      candidates.set(key, {
        key,
        url,
        metadata: {},
      });
    }

    const entry = candidates.get(key);
    if (extra.text) entry.metadata.text = extra.text;
    if (extra.sourceUrl) entry.metadata.sourceUrl = extra.sourceUrl;
    if (extra.sourceTitle) entry.metadata.sourceTitle = extra.sourceTitle;
    if (extra.source) entry.metadata.source = extra.source;
    if (extra.path) entry.metadata.path = extra.path;
  };

  // Check format
  const isHybrid = scrapedData.allPdfUrls || scrapedData.apiData;

  if (isHybrid) {
    console.log('[pdf] Processing hybrid format PDFs');

    // Process allPdfUrls from hybrid scraper
    if (Array.isArray(scrapedData.allPdfUrls)) {
      console.log(`[pdf] Found ${scrapedData.allPdfUrls.length} PDFs in allPdfUrls`);
      for (const pdf of scrapedData.allPdfUrls) {
        remember(pdf.url, {
          text: pdf.text,
          sourceUrl: pdf.sourceUrl,
          sourceTitle: pdf.sourceTitle,
          source: pdf.source,
          path: pdf.path,
        });
      }
    }
  } else {
    console.log('[pdf] Processing legacy format PDFs');

    // Legacy format
    if (Array.isArray(scrapedData.documents?.pdfs)) {
      for (const doc of scrapedData.documents.pdfs) {
        if (doc?.url) {
          remember(doc.url, doc);
        }
      }
    }

    if (Array.isArray(scrapedData.links?.pdf)) {
      for (const link of scrapedData.links.pdf) {
        if (link?.url) {
          remember(link.url, {
            text: link.text,
            sourceUrl: link.sourceUrl,
            sourceTitle: link.sourceTitle,
          });
        }
      }
    }
  }

  const results = Array.from(candidates.values()).filter((entry) => !!entry.url);
  console.log(`[pdf] Total unique PDFs to process: ${results.length}`);
  return results;
}

async function downloadPdfBuffer(pdfUrl) {
  const response = await axios.get(pdfUrl, {
    responseType: "arraybuffer",
    timeout: 60000,
    headers: {
      "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    maxContentLength: 50 * 1024 * 1024,
  });
  return Buffer.from(response.data);
}

async function extractPdfText(buffer, pdfUrl = "") {
  let text = "";
  let pages = 0;
  try {
    const parsed = await pdfParse(buffer);
    text = parsed.text || "";
    pages = parsed.numpages || 0;
  } catch (error) {
    console.error(`[pdf] pdf-parse failed for ${pdfUrl}: ${error.message}`);
  }

  const needsOCR = !text || text.trim().length < 40;
  return { text, pages, needsOCR };
}

async function ocrPdfBuffer(buffer, pdfUrl = "") {
  const tmpBase = path.join(
      __dirname,
      `tmp_ocr_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
  const pdfPath = `${tmpBase}.pdf`;
  const imgPath = `${tmpBase}-1.png`;
  const txtPath = `${tmpBase}.txt`;

  try {
    await fs.writeFile(pdfPath, buffer);
    await exec(`pdftoppm -f 1 -l 1 -png "${pdfPath}" "${tmpBase}"`);
    await exec(`tesseract "${imgPath}" "${tmpBase}" -l eng`);
    const ocrText = await fs.readFile(txtPath, "utf8");
    return ocrText.trim();
  } catch (error) {
    console.error(`[pdf] Local OCR failed for ${pdfUrl}: ${error.message}`);
    return "";
  } finally {
    const extraCandidates = [
      pdfPath,
      imgPath,
      txtPath,
      `${tmpBase}.log`,
      `${tmpBase}.html`,
      `${tmpBase}.hocr`,
      `${tmpBase}.tsv`,
      `${tmpBase}-1.ppm`,
      `${tmpBase}.png`,
    ];

    for (const candidate of extraCandidates) {
      try {
        await fs.unlink(candidate);
      } catch {}
    }

    try {
      const tmpPrefix = path.basename(tmpBase);
      const entries = await fs.readdir(__dirname);
      for (const entry of entries) {
        if (entry.startsWith(tmpPrefix)) {
          const fullPath = path.join(__dirname, entry);
          try {
            await fs.unlink(fullPath);
          } catch {}
        }
      }
    } catch {}
  }
}

function categorizePdfUrl(url) {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('/tender')) return 'tender';
  if (lowerUrl.includes('/notice')) return 'notice';
  if (lowerUrl.includes('/calendar')) return 'calendar';
  if (lowerUrl.includes('/syllabus') || lowerUrl.includes('/curriculum')) return 'curriculum';
  if (lowerUrl.includes('/recruitment')) return 'recruitment';
  if (lowerUrl.includes('/department')) return 'department';
  if (lowerUrl.includes('/faculty')) return 'faculty';
  if (lowerUrl.includes('/research')) return 'research';
  return 'general';
}

function buildPdfDoc(pdfUrl, pdfText, pdfPages, metadata) {
  const timestamp = new Date().toISOString();
  const category = categorizePdfUrl(pdfUrl);

  const titleCandidates = [
    metadata.text,
    metadata.sourceTitle,
    pdfUrl.split("/").pop(),
  ];
  const title = titleCandidates.find(
      (value) => typeof value === "string" && value.trim().length > 0
  ) || pdfUrl;

  const wordCount = pdfText
      ? pdfText.split(/\s+/).filter(Boolean).length
      : 0;

  return {
    url: pdfUrl,
    title: title.trim(),
    text: pdfText,
    pages: pdfPages || 0,
    category: category,
    timestamp,
    sourceUrl: metadata.sourceUrl || "",
    sourceTitle: metadata.sourceTitle || "",
    source: metadata.source || "",
    wordCount,
  };
}

function savePdfDoc(scrapedData, pdfDoc) {
  // Initialize processedPdfs if needed
  if (!scrapedData.processedPdfs) {
    scrapedData.processedPdfs = [];
  }

  // Check if already processed
  const existingIndex = scrapedData.processedPdfs.findIndex(
      (doc) => normalizePdfKey(doc.url) === normalizePdfKey(pdfDoc.url)
  );

  if (existingIndex !== -1) {
    // Update existing
    scrapedData.processedPdfs[existingIndex] = {
      ...scrapedData.processedPdfs[existingIndex],
      ...pdfDoc,
    };
    return scrapedData.processedPdfs[existingIndex];
  }

  // Add new
  scrapedData.processedPdfs.push(pdfDoc);
  return pdfDoc;
}

async function processPdfs(cliPath, options = {}) {
  const { maxPdfs = null, skipOcr = false } = options;

  const targetFile = await resolveTargetFile(cliPath);
  console.log(`[pdf] Processing PDFs from: ${targetFile}`);

  const scrapedData = await loadScrapedJson(targetFile);
  const candidates = collectPdfCandidates(scrapedData);

  if (!candidates.length) {
    console.log("[pdf] No PDF entries found in this snapshot.");
    return;
  }

  const toProcess = maxPdfs ? candidates.slice(0, maxPdfs) : candidates;
  console.log(`[pdf] Processing ${toProcess.length} PDF(s)${maxPdfs ? ` (limited to ${maxPdfs})` : ''}...`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { url: pdfUrl, metadata } = toProcess[i];
    console.log(`\n[pdf] (${i + 1}/${toProcess.length}) Processing: ${pdfUrl}`);

    let buffer = null;
    try {
      buffer = await downloadPdfBuffer(pdfUrl);
      console.log(`[pdf] Downloaded ${(buffer.length / 1024).toFixed(2)} KB`);
    } catch (error) {
      console.error(`[pdf] ❌ Download failed: ${error.message}`);
      failCount++;
      continue;
    }

    let pdfText = "";
    let pdfPages = 0;

    if (buffer) {
      const parsed = await extractPdfText(buffer, pdfUrl);
      pdfText = parsed.text;
      pdfPages = parsed.pages;
      console.log(`[pdf] Extracted ${pdfPages} pages, ${pdfText.length} characters`);

      if (parsed.needsOCR && !skipOcr) {
        console.log(`[pdf] Text extraction insufficient, running OCR...`);
        const ocrText = await ocrPdfBuffer(buffer, pdfUrl);
        if (ocrText && ocrText.length > pdfText.length) {
          pdfText = ocrText;
          console.log(`[pdf] OCR improved text to ${ocrText.length} characters`);
        }
      }
    }

    try {
      const pdfDoc = buildPdfDoc(pdfUrl, pdfText, pdfPages, metadata);
      savePdfDoc(scrapedData, pdfDoc);
      console.log(
          `[pdf] ✓ Saved: ${pdfDoc.pages} pages, ${pdfDoc.wordCount} words, category: ${pdfDoc.category}`
      );
      successCount++;
    } catch (error) {
      console.error(`[pdf] ❌ Failed to save metadata: ${error.message}`);
      failCount++;
    }

    // Small delay to avoid overwhelming the server
    if (i < toProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Update statistics
  scrapedData.statistics.totalProcessedPDFs = scrapedData.processedPdfs?.length || 0;
  scrapedData.statistics.pdfProcessingDate = new Date().toISOString();

  // Save updated data
  await fs.writeFile(targetFile, JSON.stringify(scrapedData, null, 2), "utf8");

  console.log(`\n${'='.repeat(70)}`);
  console.log(`[pdf] ✅ Processing Complete!`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total processed PDFs in file: ${scrapedData.processedPdfs?.length || 0}`);
  console.log(`Saved to: ${targetFile}`);
  console.log(`${'='.repeat(70)}`);
}

// CLI execution
const isDirectRun =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const cliPath = process.argv[2] || null;
  const maxPdfsArg = process.argv[3] ? parseInt(process.argv[3]) : null;
  const skipOcr = process.argv.includes('--skip-ocr');

  processPdfs(cliPath, { maxPdfs: maxPdfsArg, skipOcr }).catch((error) => {
    console.error(`[pdf] ❌ Processing failed: ${error?.message || error}`);
    process.exit(1);
  });
}

export { processPdfs };