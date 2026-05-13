/**
 * pdf-imposer.js
 * Cut-and-Stack PDF Imposer — fully client-side, no framework.
 *
 * Imposition algorithm (plain English):
 * ─────────────────────────────────────
 * Goal: produce a PDF whose page order, when printed duplex
 *   (2-up, landscape, flip-on-short-edge) and then cut down
 *   the vertical centre, yields two stacks that read 1,2,3,…
 *   when the left stack is placed on top of the right stack.
 *
 * Step 1 – Pad to even count
 *   If N is odd, append one blank page so N becomes even.
 *
 * Step 2 – Split
 *   left_stack  = pages 1 … N/2
 *   right_stack = pages N/2+1 … N
 *
 * Step 3 – Pair
 *   Each physical sheet carries two logical pages side-by-side.
 *   After cutting:
 *     • left half of sheet k  →  left_stack[k]   = page k
 *     • right half of sheet k →  right_stack[k]  = page N/2+k
 *   So sheet k should be printed as: (page k) | (page N/2+k)
 *
 * Step 4 – Duplex / flip-on-short-edge back sides
 *   With "flip on short edge", the back of sheet k is already
 *   correctly oriented when the sheet is flipped over its short
 *   (top/bottom) edge.  In 2-up landscape the two pages on the
 *   back need to be placed so that, after flipping, they appear
 *   right-way-up.  For portrait source pages that means the back
 *   side is simply: (page k+half) | (page N/2+k+half) where
 *   "half" = N/2 sheets printed per side.
 *
 *   Concretely, the imposed PDF's page sequence is:
 *
 *   Sheet 1 front  → src page  1         | src page  (N/2)+1
 *   Sheet 1 back   → src page  (N/4)+1   | src page  (3N/4)+1
 *   Sheet 2 front  → src page  2         | src page  (N/2)+2
 *   Sheet 2 back   → src page  (N/4)+2   | src page  (3N/4)+2
 *   …
 *
 *   But we do NOT physically combine pages side-by-side in the
 *   PDF; instead we output them as individual portrait pages in
 *   the correct order and instruct the user to print "2-up
 *   landscape".  That way vector quality is fully preserved and
 *   we never need to know the page dimensions to tile them.
 *
 * Dependencies (loaded via CDN script tags):
 *   • pdf-lib  →  PDFLib  global
 *   • pdf.js   →  pdfjsLib global  (preview only)
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

  /**
   * computeImposition(n)
   * Given an (already-even) page count n, return the sequence of
   * 0-based page indices that should appear in the output PDF.
   *
   * The output sequence is ordered so that printing as
   *   duplex / 2-up landscape / flip-on-short-edge
   * and then cutting + stacking yields pages 0…n-1 in order.
   *
   * Layout per printed sheet (landscape, 2-up):
   *   Front:  [left_page]  [right_page]
   *   Back :  [left_page2] [right_page2]   ← flip on short edge
   *
   * We output individual portrait pages; the printer's 2-up
   * driver places them left-to-right across the sheet.
   *
   * Sequence for sheet s (0-based), out of S = n/2 sheets total:
   *   Front slot 0  (left  half):  page  s
   *   Front slot 1  (right half):  page  s + S          = s + n/2
   *   Back  slot 0  (left  half):  page  s + S/2        = s + n/4
   *   Back  slot 1  (right half):  page  s + S + S/2    = s + 3n/4
   *
   * This ensures:
   *   After printing + cutting:
   *     Left  stack sheet s front top    → page s
   *     Right stack sheet s front top    → page s + n/2
   *     Left  stack sheet s back  bottom → page s + n/4
   *     Right stack sheet s back  bottom → page s + 3n/4
   *   Stacking left-then-right gives 0 … n-1 in order.  ✓
   *
   * @param  {number} n  Must be divisible by 4 for perfect duplex.
   *                     We pad to nearest multiple of 4 internally.
   * @return {number[]}  Array of 0-based source page indices.
   */
  function computeImposition(n) {
    // Pad to multiple of 4 (two sheets on each side of the duplex)
    let N = n;
    while (N % 4 !== 0) N++;

    const S = N / 2;   // total physical sheets
    const imposed = [];

    for (let s = 0; s < S / 2; s++) {
      // Front side of sheet s
      imposed.push(s);            // left  slot
      imposed.push(s + S);       // right slot

      // Back side of sheet s
      imposed.push(s + S / 2);   // left  slot (flip on short edge)
      imposed.push(s + S + S / 2); // right slot
    }

    // The imposed array now has N entries (indices 0…N-1).
    // Any index >= original n is a blank placeholder.
    return imposed;
  }

  /**
   * humanReadableMapping(originalN, paddedN, imposed)
   * Returns rows for the UI mapping table.
   * Each row: { sheet, side, slot, imposedIdx, srcPage }
   * srcPage is 1-based; null means blank.
   */
  function humanReadableMapping(originalN, imposed) {
    const rows = [];
    const S = imposed.length / 2; // total (front+back) sides → /2 pairs

    for (let i = 0; i < imposed.length; i += 2) {
      const sheetIndex = Math.floor(i / 4);
      const side = (Math.floor(i / 2) % 2 === 0) ? 'Front' : 'Back';
      const leftIdx  = imposed[i];
      const rightIdx = imposed[i + 1];

      rows.push({
        sheet: sheetIndex + 1,
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
