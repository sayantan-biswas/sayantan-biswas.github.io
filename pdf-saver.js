/**
 * pdf-imposer.js
 * Cut-and-Stack PDF Imposer — fully client-side, no framework.
 *
 * ═══════════════════════════════════════════════════════════════
 * IMPOSITION ALGORITHM
 * ═══════════════════════════════════════════════════════════════
 *
 * Goal
 * ────
 * Produce a PDF whose page order, when printed with:
 *   • Duplex
 *   • 2 pages per side (2-up)
 *   • Landscape orientation
 *   • "Flip on short edge"
 * and then cut vertically down the centre of every sheet and
 * stacked (all left halves first, then all right halves),
 * reads naturally: 1, 2, 3, 4, 5, …
 *
 * Step 1 – Pad to even count
 * ──────────────────────────
 * If the original page count N is odd, append one blank page so
 * N becomes even.  (For perfect duplex with no wasted half-sheets
 * you ideally want N divisible by 4; we pad blanks silently.)
 *
 * Step 2 – Define the two stacks
 * ────────────────────────────────
 *   left_stack  = pages  1  …  N/2        (indices 0 … N/2−1)
 *   right_stack = pages  N/2+1  …  N      (indices N/2 … N−1)
 *
 * Step 3 – Understand the physical result
 * ────────────────────────────────────────
 * The printer consumes PDF pages sequentially and places them
 * two-per-sheet-side, left slot then right slot:
 *
 *   PDF pages 1,2  → Sheet 1 Front  left=PDF-p1   right=PDF-p2
 *   PDF pages 3,4  → Sheet 1 Back   left=PDF-p3   right=PDF-p4
 *   PDF pages 5,6  → Sheet 2 Front  left=PDF-p5   right=PDF-p6
 *   PDF pages 7,8  → Sheet 2 Back   left=PDF-p7   right=PDF-p8
 *   …
 *
 * After cutting every sheet down the centre and stacking:
 *   Left  pile order: Sheet1-Front-L, Sheet1-Back-L,
 *                     Sheet2-Front-L, Sheet2-Back-L, …
 *   Right pile order: Sheet1-Front-R, Sheet1-Back-R,
 *                     Sheet2-Front-R, Sheet2-Back-R, …
 *   Final order (left pile on top): all lefts then all rights.
 *
 * Step 4 – Assign source pages to slots
 * ──────────────────────────────────────
 * We want final order = 1, 2, 3, …, N.
 *
 *   Left  pile position k (0-based) must hold source page k+1
 *   Right pile position k (0-based) must hold source page N/2+k+1
 *
 * Left pile position k maps to PDF output page:
 *   Sheet ⌊k/2⌋, side (k%2==0 ? Front : Back), Left slot
 *   → PDF page index = k*2   (because each sheet-side = 2 PDF pages,
 *                              and left slot is always the first of the pair)
 *   → PDF page index for left slot of pile-position k = 2k
 *
 * Right slot is always the immediately following PDF page:
 *   → PDF page index for right slot of pile-position k = 2k+1
 *
 * So the imposed PDF sequence is simply:
 *
 *   PDF slot 2k   ← source page  k+1         (= left_stack[k])
 *   PDF slot 2k+1 ← source page  N/2+k+1     (= right_stack[k])
 *
 * Written out:
 *   PDF: [ 1, N/2+1,  2, N/2+2,  3, N/2+3,  4, N/2+4, … ]
 *         └──────┘   └──────┘   └──────┘
 *         Sheet1-F   Sheet1-B   Sheet2-F   (each pair = one sheet side)
 *
 * This is the ONLY ordering needed. The printer and the duplex
 * mechanism handle everything else automatically.
 *
 * No page rotation is required — pages remain upright throughout.
 *
 * ═══════════════════════════════════════════════════════════════
 * Dependencies (loaded via CDN script tags):
 *   • pdf-lib  →  PDFLib  global
 *   • pdf.js   →  pdfjsLib global  (preview only, optional)
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ── Guard against double-initialisation ─────────────────── */
  if (window.__pdfImposerInit) return;
  window.__pdfImposerInit = true;

  /* ── Locate DOM nodes injected by the HTML snippet ───────── */
  const ROOT_ID = 'pdfimposer-root';

  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  /* ── State ───────────────────────────────────────────────── */
  const state = {
    file: null,          // File object
    pageCount: 0,        // original page count
    paddedCount: 0,      // after optional blank-page padding
    imposed: [],         // imposed page-index sequence (0-based)
    pdfBytes: null,      // Uint8Array of the loaded PDF
    outputUrl: null,     // object URL of generated PDF
  };

  /* ─────────────────────────────────────────────────────────────
     IMPOSITION MATHS
     ───────────────────────────────────────────────────────────── */

  function computeImposition(n) {
    // Pad to nearest multiple of 4 for clean duplex sheets.
    // (2 pages per sheet side × 2 sides = 4 source pages per sheet)
    let N = n;
    while (N % 4 !== 0) N++;

    const half = N / 2;  // size of each stack (left / right)
    const imposed = [];

    // Interleave left_stack and right_stack so that:
    //   PDF page 2k+1  ← left_stack[k]  = source page k+1
    //   PDF page 2k+2  ← right_stack[k] = source page N/2+k+1
    //
    // For N=8: imposed = [0,4, 1,5, 2,6, 3,7]
    //   Sheet 1 Front: pages 1,5  | Sheet 1 Back: pages 2,6
    //   Sheet 2 Front: pages 3,7  | Sheet 2 Back: pages 4,8
    //   Left  pile after cut: 1,2,3,4  ✓
    //   Right pile after cut: 5,6,7,8  ✓
    //   Combined (left on top): 1,2,3,4,5,6,7,8  ✓
    for (let k = 0; k < half; k++) {
      imposed.push(k);         // left slot  — PDF page 2k+1
      imposed.push(k + half); // right slot — PDF page 2k+2
    }

    // imposed.length === N
    // Any index >= original n will be rendered as a blank page.
    return imposed;
  }

  /**
   * humanReadableMapping(originalN, imposed)
   * Returns table rows for the UI.
   *
   * imposed is the interleaved array: [L0,R0, L1,R1, L2,R2, …]
   * Each adjacent pair [2i, 2i+1] is one physical sheet side.
   * Sides alternate Front / Back per sheet (every 2 pairs = 1 sheet).
   *
   * Row columns: Sheet | Side | Left half (src page) | Right half (src page)
   */
  function humanReadableMapping(originalN, imposed) {
    const rows = [];
    // Each pair of imposed indices = one sheet side (2 PDF pages)
    for (let i = 0; i < imposed.length; i += 2) {
      const sideIndex  = i / 2;                                  // 0-based side number
      const sheetNum   = Math.floor(sideIndex / 2) + 1;          // 1-based sheet
      const side       = sideIndex % 2 === 0 ? 'Front' : 'Back';
      const leftIdx    = imposed[i];
      const rightIdx   = imposed[i + 1];

      rows.push({
        sheet: sheetNum,
        side,
        left:  leftIdx  < originalN ? leftIdx  + 1 : '(blank)',
        right: rightIdx < originalN ? rightIdx + 1 : '(blank)',
      });
    }
    return rows;
  }

  /* ─────────────────────────────────────────────────────────────
     PDF GENERATION  (pdf-lib)
     ───────────────────────────────────────────────────────────── */

  /**
   * generateImposedPdf(pdfBytes, imposed, originalN)
   * Copies source pages in imposed order into a new PDFDocument.
   * Blank slots (index >= originalN) become blank pages matching
   * the median source page size.
   *
   * Pages are NOT rotated or scaled — vector quality preserved.
   */
  async function generateImposedPdf(pdfBytes, imposed, originalN) {
    const { PDFDocument } = PDFLib;

    // Load source (allow encrypted will throw a readable error)
    const srcDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: false,
    });

    const outDoc = await PDFDocument.create();

    // Compute median page size for blanks
    const srcPages = srcDoc.getPages();
    const { width: bw, height: bh } = srcPages[
      Math.floor(srcPages.length / 2)
    ].getSize();

    for (const idx of imposed) {
      if (idx < originalN) {
        // Copy existing page
        const [copied] = await outDoc.copyPages(srcDoc, [idx]);
        outDoc.addPage(copied);
      } else {
        // Insert blank page
        const blank = outDoc.addPage([bw, bh]);
        // blank page is already white by default
      }
    }

    return outDoc.save();
  }

  /* ─────────────────────────────────────────────────────────────
     UI HELPERS
     ───────────────────────────────────────────────────────────── */

  function showError(root, msg) {
    const el = $('.pdfimposer__error', root);
    el.textContent = msg;
    el.removeAttribute('hidden');
  }

  function clearError(root) {
    const el = $('.pdfimposer__error', root);
    el.textContent = '';
    el.setAttribute('hidden', '');
  }

  function setStatus(root, msg, spinning) {
    const bar = $('.pdfimposer__status', root);
    const spin = $('.pdfimposer__spinner', bar);
    bar.removeAttribute('hidden');
    spin.style.display = spinning ? 'inline-block' : 'none';
    bar.childNodes[bar.childNodes.length - 1].textContent = ' ' + msg;
  }

  function hideStatus(root) {
    $('.pdfimposer__status', root).setAttribute('hidden', '');
  }

  function buildMappingTable(root, rows) {
    const wrap = $('.pdfimposer__mapping-wrap', root);
    const table = $('.pdfimposer__table', wrap);
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';

    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${r.sheet}</td><td>${r.side}</td>
        <td>${r.left}</td><td>${r.right}</td>`;
      tbody.appendChild(tr);
    });

    const showMapping = $('.pdfimposer__opt-mapping', root).checked;
    if (showMapping) wrap.removeAttribute('hidden');
    else wrap.setAttribute('hidden', '');
  }

  function resetDownload(root) {
    const row = $('.pdfimposer__download-row', root);
    row.setAttribute('hidden', '');
    const btn = $('.pdfimposer__btn--download', root);
    btn.removeAttribute('href');
  }

  /* ─────────────────────────────────────────────────────────────
     CORE WORKFLOW
     ───────────────────────────────────────────────────────────── */

  async function processFile(root, file) {
    clearError(root);
    resetDownload(root);
    hideStatus(root);

    // ── 1. Read file ───────────────────────────────────────────
    setStatus(root, 'Reading file…', true);

    let pdfBytes;
    try {
      pdfBytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      showError(root, 'Could not read file: ' + e.message);
      hideStatus(root);
      return;
    }

    // ── 2. Count pages via pdf-lib (lightweight) ───────────────
    let originalN;
    try {
      const { PDFDocument } = PDFLib;
      const probe = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
      originalN = probe.getPageCount();
    } catch (e) {
      if (/encrypt/i.test(e.message)) {
        showError(root, 'This PDF is password-protected. Please unlock it first.');
      } else {
        showError(root, 'Could not parse PDF: ' + e.message);
      }
      hideStatus(root);
      return;
    }

    setStatus(root, `Loaded — ${originalN} pages.`, false);

    // ── 3. Pad ─────────────────────────────────────────────────
    const autoBlank = $('.pdfimposer__opt-blank', root).checked;

    // We always pad to even for the cut-and-stack to work.
    // Additionally pad to multiple of 4 inside computeImposition.
    let paddedN = originalN;
    if (autoBlank && paddedN % 2 !== 0) paddedN++;

    if (originalN % 2 !== 0 && !autoBlank) {
      showError(root,
        `Page count (${originalN}) is odd. Enable "Add blank page if needed" to auto-pad.`);
      hideStatus(root);
      return;
    }

    // ── 4. Compute imposition ──────────────────────────────────
    const imposed = computeImposition(paddedN);

    // ── 5. Info card ───────────────────────────────────────────
    const N4 = imposed.length; // padded to multiple of 4
    const sheets = N4 / 4;
    const info = $('.pdfimposer__info', root);
    info.innerHTML =
      `<strong>Pages:</strong> ${originalN} original` +
      (N4 > originalN ? ` → padded to ${N4}` : '') +
      ` &nbsp;|&nbsp; <strong>Physical sheets:</strong> ${sheets}` +
      ` &nbsp;|&nbsp; <strong>Output pages:</strong> ${N4}` +
      `<br><em>Print duplex · 2-up landscape · flip on short edge · cut vertically · stack left then right.</em>`;
    info.removeAttribute('hidden');

    // ── 6. Mapping table ───────────────────────────────────────
    const rows = humanReadableMapping(originalN, imposed);
    buildMappingTable(root, rows);

    // Store for generation
    state.pdfBytes  = pdfBytes;
    state.imposed   = imposed;
    state.pageCount = originalN;

    // ── 7. Enable generate button ──────────────────────────────
    const genBtn = $('.pdfimposer__btn--generate', root);
    genBtn.disabled = false;

    setStatus(root, 'Ready — click "Generate Imposed PDF" to proceed.', false);
  }

  async function generateAndDownload(root) {
    const genBtn = $('.pdfimposer__btn--generate', root);
    genBtn.disabled = true;
    clearError(root);
    setStatus(root, 'Generating imposed PDF…', true);

    // Revoke previous blob URL
    if (state.outputUrl) {
      URL.revokeObjectURL(state.outputUrl);
      state.outputUrl = null;
    }

    try {
      const outBytes = await generateImposedPdf(
        state.pdfBytes,
        state.imposed,
        state.pageCount
      );

      const blob = new Blob([outBytes], { type: 'application/pdf' });
      state.outputUrl = URL.createObjectURL(blob);

      const a = $('.pdfimposer__btn--download', root);
      a.href = state.outputUrl;
      a.download = 'imposed-cut-and-stack.pdf';
      $('.pdfimposer__download-row', root).removeAttribute('hidden');

      setStatus(root, `Done! ${state.imposed.length} pages in output PDF.`, false);
    } catch (e) {
      showError(root, 'Generation failed: ' + e.message);
      setStatus(root, 'Error during generation.', false);
    } finally {
      genBtn.disabled = false;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     INITIALISATION
     ───────────────────────────────────────────────────────────── */

  function init() {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      console.warn('[pdf-imposer] Root element #' + ROOT_ID + ' not found.');
      return;
    }

    // Check dependencies
    if (typeof PDFLib === 'undefined') {
      console.error('[pdf-imposer] pdf-lib not loaded.');
      showError(root, 'pdf-lib library failed to load. Check your script tags.');
      return;
    }

    // ── Drag-and-drop ──────────────────────────────────────────
    const dropzone = $('.pdfimposer__dropzone', root);
    const fileInput = dropzone.querySelector('input[type="file"]');

    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('pdfimposer--drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('pdfimposer--drag-over');
    });
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('pdfimposer--drag-over');
      const f = e.dataTransfer.files[0];
      if (f && f.type === 'application/pdf') {
        handleFileSelected(root, f);
      } else {
        showError(root, 'Please drop a PDF file.');
      }
    });

    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) handleFileSelected(root, f);
    });

    // ── Mapping toggle ─────────────────────────────────────────
    const optMapping = $('.pdfimposer__opt-mapping', root);
    optMapping.addEventListener('change', () => {
      const wrap = $('.pdfimposer__mapping-wrap', root);
      if (optMapping.checked && wrap.querySelector('tbody').children.length > 0) {
        wrap.removeAttribute('hidden');
      } else {
        wrap.setAttribute('hidden', '');
      }
    });

    // ── Generate button ────────────────────────────────────────
    const genBtn = $('.pdfimposer__btn--generate', root);
    genBtn.addEventListener('click', () => generateAndDownload(root));
  }

  function handleFileSelected(root, file) {
    state.file = file;
    // Reset
    $('.pdfimposer__info', root).setAttribute('hidden', '');
    $('.pdfimposer__mapping-wrap', root).setAttribute('hidden', '');
    resetDownload(root);
    $('.pdfimposer__btn--generate', root).disabled = true;

    // Update dropzone label
    const p = $('.pdfimposer__dropzone p', root);
    if (p) p.textContent = `📄 ${file.name}`;

    processFile(root, file);
  }

  /* Run after DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();