// ============================================================================
// PSD STUDIO LOCAL — CORE ENGINE (FONT, LAYER EFFECTS, CLIPPING, MASK, TOUCH)
// ============================================================================

let openedFilesQueue = [];
let activeFileIndex = -1;
let currentPsd = null;
let currentFileName = 'document.psd';
let currentFileSize = 0;
let flatLayers = [];
let selectedLayerId = null;
let nextUid = 1;
let undoStack = [];
let customLoadedFonts = [];

// Trạng thái Zoom, Pan & Touch (Hỗ trợ Desktop, Tablet, Mobile)
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let isDraggingCanvas = false;
let dragStartX = 0;
let dragStartY = 0;
let layerStartLeft = 0;
let layerStartTop = 0;
let lastPinchDist = 0;

const COLOR_MODES = {
  0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB',
  4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab'
};

const BLEND_MAP_TO_CANVAS = {
  'normal': 'source-over', 'pass-through': 'source-over',
  'multiply': 'multiply', 'screen': 'screen', 'overlay': 'overlay',
  'darken': 'darken', 'lighten': 'lighten', 'color-dodge': 'color-dodge',
  'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
  'difference': 'difference', 'exclusion': 'exclusion', 'hue': 'hue',
  'saturation': 'saturation', 'color': 'color', 'luminosity': 'luminosity'
};

// ============================================================================
// KHỞI TẠO SỰ KIỆN GIAO DIỆN & RESPONSIVE MOBILE/TABLET
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  initFileInputs();
  initCanvasInteractions();
  initKeyboardShortcuts();
});

function switchMobileTab(tabName) {
  const ws = document.getElementById('mainWorkspace');
  ws.setAttribute('data-mobile-tab', tabName);
  document.querySelectorAll('.mob-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
  });
  if (tabName === 'canvas' && currentPsd) {
    setTimeout(() => fitCanvasToScreen(), 60);
  }
}

function toggleTheme() {
  const body = document.body;
  const isDark = body.getAttribute('data-theme') === 'dark';
  body.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('btnThemeToggle').textContent = isDark ? '🌙 Giao diện Tối' : '☀️ Giao diện Sáng';
}

// ============================================================================
// QUẢN LÝ HOÀN TÁC (UNDO CTRL+Z)
// ============================================================================
function cloneLayerTreeForUndo(children) {
  if (!children) return [];
  return children.map(item => {
    const copy = Object.assign({}, item);
    delete copy._parent;
    if (item.effects) copy.effects = JSON.parse(JSON.stringify(item.effects));
    if (item.text) copy.text = JSON.parse(JSON.stringify(item.text));
    if (item.children) copy.children = cloneLayerTreeForUndo(item.children);
    return copy;
  });
}

function pushUndoState(label) {
  if (!currentPsd || !currentPsd.children) return;
  if (undoStack.length >= 15) undoStack.shift();
  undoStack.push({
    label: label || 'Thao tác',
    childrenSnapshot: cloneLayerTreeForUndo(currentPsd.children),
    selectedId: selectedLayerId
  });
  // Khi người dùng đã chỉnh sửa, tự động chuyển sang chế độ Live Layer Composite
  const viewModeSel = document.getElementById('selRenderMode');
  if (viewModeSel && viewModeSel.value === 'psd_composite') {
    viewModeSel.value = 'live_layers';
  }
  updateUndoButtonUI();
}

function undoLastAction() {
  if (undoStack.length === 0 || !currentPsd) return;
  const state = undoStack.pop();
  currentPsd.children = state.childrenSnapshot;
  assignLayerMetadata(currentPsd.children, currentPsd, 0);
  updateDocumentSummaryUI(currentFileName, currentFileSize);
  selectedLayerId = state.selectedId;
  renderLayerTree();
  renderComposite();
  if (selectedLayerId && findLayerById(selectedLayerId)) {
    selectLayer(selectedLayerId);
  } else if (flatLayers.length > 0) {
    selectLayer(flatLayers[0]._uid);
  }
  updateUndoButtonUI();
  setStatus(`Đã hoàn tác: ${state.label}`);
}

function updateUndoButtonUI() {
  const btn = document.getElementById('btnUndo');
  const lbl = document.getElementById('undoCountLabel');
  if (btn) btn.disabled = undoStack.length === 0;
  if (lbl) lbl.textContent = undoStack.length;
}

function initKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLastAction();
    } else if (e.key === 'Delete' && selectedLayerId) {
      e.preventDefault();
      deleteSelectedLayer();
    }
  });
}

// ============================================================================
// ĐỌC FILE PSD, ẢNH JPG/PNG & NẠP FONT TÙY CHỈNH (.TTF / .OTF)
// ============================================================================
function initFileInputs() {
  const psdFileInput = document.getElementById('psdFileInput');
  const folderInput = document.getElementById('folderInput');
  const replaceImageInput = document.getElementById('replaceImageInput');
  const addLayerImageInput = document.getElementById('addLayerImageInput');
  const customFontInput = document.getElementById('customFontInput');
  const emptyDropzone = document.getElementById('emptyDropzone');

  psdFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      ingestFileList(e.target.files);
      e.target.value = '';
    }
  });

  folderInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      ingestFileList(e.target.files);
      e.target.value = '';
    }
  });

  replaceImageInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleReplaceSelectedLayerWithImage(e.target.files[0]);
      e.target.value = '';
    }
  });

  addLayerImageInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleAddNewImageLayer(e.target.files[0]);
      e.target.value = '';
    }
  });

  customFontInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      for (const f of e.target.files) {
        await loadCustomFontFile(f);
      }
      e.target.value = '';
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (emptyDropzone) emptyDropzone.classList.add('dragover');
  });

  window.addEventListener('dragleave', () => {
    if (emptyDropzone) emptyDropzone.classList.remove('dragover');
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (emptyDropzone) emptyDropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      ingestFileList(e.dataTransfer.files);
    }
  });
}

async function loadCustomFontFile(file) {
  try {
    const fontName = file.name.replace(/\.[^.]+$/, '');
    const buf = await file.arrayBuffer();
    const fontFace = new FontFace(fontName, buf);
    await fontFace.load();
    document.fonts.add(fontFace);

    if (!customLoadedFonts.includes(fontName)) {
      customLoadedFonts.push(fontName);
      const sel = document.getElementById('inpTextFont');
      if (sel) {
        const opt = document.createElement('option');
        opt.value = fontName;
        opt.textContent = `⭐ ${fontName} (Font vừa nạp)`;
        sel.insertBefore(opt, sel.firstChild);
        sel.value = fontName;
      }
    }
    setStatus(`Đã nạp thành công Font chữ "${fontName}"! Bạn có thể áp dụng cho mọi Text Layer.`);
  } catch (err) {
    alert('Không thể nạp file Font này: ' + err.message);
  }
}

function ingestFileList(fileList) {
  const allFiles = Array.from(fileList);
  // Nạp tự động các file font (.ttf, .otf, .woff) nếu có trong thư mục
  allFiles.filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f.name)).forEach(f => loadCustomFontFile(f));

  const supported = allFiles.filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp'].includes(ext);
  });

  if (supported.length === 0) {
    alert('Không tìm thấy file .PSD, .PNG, .JPG nào trong lựa chọn vừa rồi.');
    return;
  }

  supported.sort((a, b) => {
    const aPsd = a.name.toLowerCase().endsWith('.psd') ? 0 : 1;
    const bPsd = b.name.toLowerCase().endsWith('.psd') ? 0 : 1;
    if (aPsd !== bPsd) return aPsd - bPsd;
    return a.name.localeCompare(b.name);
  });

  openedFilesQueue = supported;
  renderFileTabs();
  switchToFileTab(0);
}

function renderFileTabs() {
  const bar = document.getElementById('fileTabsBar');
  if (openedFilesQueue.length <= 1) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = `<span style="font-size:11.5px; color:var(--text-secondary); margin-right:4px; font-weight:700;">File (${openedFilesQueue.length}):</span>`;
  openedFilesQueue.forEach((f, idx) => {
    const tab = document.createElement('div');
    tab.className = 'file-tab' + (idx === activeFileIndex ? ' active' : '');
    const isPsd = f.name.toLowerCase().endsWith('.psd');
    tab.innerHTML = `<span>${isPsd ? '🟦' : '🖼️'} ${f.name}</span> <span style="opacity:0.75; font-size:10.5px;">(${formatBytes(f.size)})</span>`;
    tab.onclick = () => switchToFileTab(idx);
    bar.appendChild(tab);
  });
}

function switchToFileTab(index) {
  if (index < 0 || index >= openedFilesQueue.length) return;
  activeFileIndex = index;
  renderFileTabs();
  handleOpenFile(openedFilesQueue[index]);
}

async function handleOpenFile(file) {
  setStatus(`Đang đọc và phân tích cấu trúc file "${file.name}" (${formatBytes(file.size)})...`);
  currentFileName = file.name;
  currentFileSize = file.size;
  undoStack = [];
  updateUndoButtonUI();

  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'psd' || ext === 'psb') {
      const buffer = await file.arrayBuffer();
      await loadPsdBuffer(buffer, file.name, file.size);
    } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      await loadStandardImageAsPsd(file);
    }
  } catch (err) {
    console.error(err);
    alert('Có lỗi khi đọc file: ' + (err.message || err));
    setStatus('Lỗi khi đọc file: ' + (err.message || err));
  }
}

async function loadPsdBuffer(arrayBuffer, fileName, fileSize) {
  let psd = null;
  if (typeof agPsd !== 'undefined') {
    try {
      psd = agPsd.readPsd(arrayBuffer, {
        skipLayerImageData: false,
        skipCompositeImageData: false,
        skipThumbnail: false
      });
    } catch (err1) {
      console.warn('Thử đọc PSD ở chế độ tương thích mở rộng:', err1);
      try {
        psd = agPsd.readPsd(arrayBuffer, {
          skipLayerImageData: false,
          skipCompositeImageData: true
        });
      } catch (err2) {
        psd = parsePsdBinaryFallback(arrayBuffer);
      }
    }
  } else {
    psd = parsePsdBinaryFallback(arrayBuffer);
  }

  currentPsd = psd;
  // Lưu giữ bản sao ảnh Composite gốc chuẩn 100% của Photoshop (đảm bảo mọi font & hiệu ứng phức tạp hiển thị tuyệt đối chính xác)
  if (currentPsd.canvas) {
    const origComp = document.createElement('canvas');
    origComp.width = currentPsd.canvas.width;
    origComp.height = currentPsd.canvas.height;
    origComp.getContext('2d').drawImage(currentPsd.canvas, 0, 0);
    currentPsd._originalCompositeCanvas = origComp;
  }

  if (!currentPsd.children) currentPsd.children = [];

  await decodeEmbeddedSmartObjects(currentPsd);

  nextUid = 1;
  assignLayerMetadata(currentPsd.children, null, 0);

  if (currentPsd.children.length === 0 && currentPsd.canvas) {
    currentPsd.children.push({
      _uid: nextUid++,
      name: 'Background (Ảnh gốc)',
      left: 0,
      top: 0,
      right: currentPsd.width,
      bottom: currentPsd.height,
      opacity: 1,
      blendMode: 'normal',
      hidden: false,
      canvas: currentPsd.canvas,
      _depth: 0,
      _parent: currentPsd
    });
  }

  finalizeDocumentLoad(fileName, fileSize);
}

// ============================================================================
// GIẢI MÃ SMART OBJECT, MASK, SOLID FILL & LƯU BITMAP GỐC CỦA LAYER CHỮ/HIỆU ỨNG
// ============================================================================
async function decodeEmbeddedSmartObjects(psd) {
  if (!psd.linkedFiles || !psd.linkedFiles.length) return;
  const fileMap = new Map();

  for (const lf of psd.linkedFiles) {
    if (lf.data && lf.data.byteLength > 0) {
      try {
        const nameLower = (lf.name || '').toLowerCase();
        if (nameLower.endsWith('.png') || nameLower.endsWith('.jpg') || nameLower.endsWith('.jpeg') || nameLower.endsWith('.webp')) {
          const blob = new Blob([lf.data]);
          const img = await blobToImage(blob);
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          lf._decodedCanvas = c;
        }
        if (lf.id) fileMap.set(lf.id, lf);
      } catch (e) {
        console.warn('Không thể giải mã linkedFile:', lf.name, e);
      }
    }
  }

  function attachToLayers(children) {
    if (!children) return;
    for (const layer of children) {
      if (layer.placedLayer && layer.placedLayer.id && fileMap.has(layer.placedLayer.id)) {
        const lf = fileMap.get(layer.placedLayer.id);
        layer._linkedFile = lf;
        if (!layer.canvas && lf._decodedCanvas) {
          const w = Math.max(1, (layer.right || psd.width) - (layer.left || 0));
          const h = Math.max(1, (layer.bottom || psd.height) - (layer.top || 0));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(lf._decodedCanvas, 0, 0, w, h);
          layer.canvas = c;
        }
      }
      if (layer.children) attachToLayers(layer.children);
    }
  }
  attachToLayers(psd.children);
}

function assignLayerMetadata(children, parentNode, depth) {
  if (!children) return;
  for (const item of children) {
    if (!item._uid) item._uid = nextUid++;
    item._parent = parentNode || currentPsd;
    item._depth = depth;
    if (typeof item.opacity !== 'number') item.opacity = 1;
    if (!item.blendMode) item.blendMode = 'normal';
    if (typeof item.left !== 'number') item.left = 0;
    if (typeof item.top !== 'number') item.top = 0;

    // Nếu là Solid Color Fill Layer mà chưa có canvas thì dựng canvas màu tương ứng
    if (!item.canvas && !item.children && item.solidColorFill && item.solidColorFill.color) {
      const col = psdColorToCss(item.solidColorFill.color, 1);
      const w = Math.max(1, (item.right > item.left) ? (item.right - item.left) : currentPsd.width);
      const h = Math.max(1, (item.bottom > item.top) ? (item.bottom - item.top) : currentPsd.height);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = col;
      ctx.fillRect(0, 0, w, h);
      item.canvas = c;
      if (item.right <= item.left) {
        item.left = 0; item.top = 0; item.right = w; item.bottom = h;
      }
    }

    if (item.canvas && (typeof item.right !== 'number' || item.right <= item.left)) {
      item.right = item.left + item.canvas.width;
      item.bottom = item.top + item.canvas.height;
    }

    // Bảo toàn tuyệt đối Bitmap gốc của Layer (chứa đúng Font gốc và Raster của Photoshop)
    if (item.canvas && !item._originalPsdCanvas) {
      const backup = document.createElement('canvas');
      backup.width = item.canvas.width;
      backup.height = item.canvas.height;
      backup.getContext('2d').drawImage(item.canvas, 0, 0);
      item._originalPsdCanvas = backup;
      item._originalBounds = { left: item.left, top: item.top, right: item.right, bottom: item.bottom };
    }

    if (item.children) {
      if (typeof item.opened === 'undefined') item.opened = true;
      assignLayerMetadata(item.children, item, depth + 1);
    }
  }
}

async function loadStandardImageAsPsd(file) {
  const img = await blobToImage(file);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);

  currentPsd = {
    width: c.width,
    height: c.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3,
    children: [
      {
        _uid: 1,
        name: file.name.replace(/\.[^.]+$/, ''),
        left: 0,
        top: 0,
        right: c.width,
        bottom: c.height,
        opacity: 1,
        blendMode: 'normal',
        hidden: false,
        canvas: c,
        _depth: 0
      }
    ]
  };
  nextUid = 2;
  assignLayerMetadata(currentPsd.children, currentPsd, 0);
  finalizeDocumentLoad(file.name, file.size);
}

function finalizeDocumentLoad(fileName, fileSize) {
  ['btnAddImageLayer', 'btnAddTextLayer', 'btnStructureReport', 'btnExportPNG', 'btnExportJPG', 'btnSavePSD'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });

  document.getElementById('emptyDropzone').style.display = 'none';
  const wrapper = document.getElementById('canvasWrapper');
  wrapper.style.display = 'block';

  const mainCanvas = document.getElementById('mainCanvas');
  mainCanvas.width = currentPsd.width;
  mainCanvas.height = currentPsd.height;

  // Mặc định hiển thị Kết hợp Layer Động để người dùng ẩn/hiện/xóa/thay thế thấy ngay
  const viewModeSel = document.getElementById('selRenderMode');
  if (viewModeSel) viewModeSel.value = 'live_layers';

  updateDocumentSummaryUI(fileName, fileSize);
  rebuildFlatLayers();
  renderLayerTree();
  renderComposite();
  fitCanvasToScreen();

  if (flatLayers.length > 0) {
    selectLayer(flatLayers[0]._uid);
  }

  setStatus(`Đã tải "${fileName}" — Kích thước: ${currentPsd.width} × ${currentPsd.height} px • Tổng số Layer/Group: ${flatLayers.length}`);
}

// ============================================================================
// BỘ KẾT HỢP (COMPOSITOR) CHUẨN PHOTOSHOP: HỖ TRỢ LAYER MASK, CLIPPING MASK & EFFECTS
// ============================================================================
function renderComposite() {
  if (!currentPsd) return;
  const mainCanvas = document.getElementById('mainCanvas');
  const ctx = mainCanvas.getContext('2d');
  ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

  // 1. Chế độ Solo (Chỉ xem riêng Layer đang chọn)
  const soloMode = document.getElementById('chkSoloMode').checked;
  if (soloMode && selectedLayerId) {
    const sel = findLayerById(selectedLayerId);
    if (sel) {
      drawSingleNodeRecursive(ctx, sel, 1, true);
      updateSelectionBox();
      return;
    }
  }

  // 2. Chế độ Xem Ảnh Gộp gốc của Photoshop (nếu người dùng chọn xem bản gốc 100%)
  const renderMode = document.getElementById('selRenderMode') ? document.getElementById('selRenderMode').value : 'live_layers';
  if (renderMode === 'psd_composite' && currentPsd._originalCompositeCanvas) {
    ctx.drawImage(currentPsd._originalCompositeCanvas, 0, 0);
    updateSelectionBox();
    return;
  }

  // 3. Nếu file PSD không lưu pixel từng layer mà chỉ có ảnh gộp
  const hasAnyLayerCanvas = flatLayers.some(l => l.canvas && l.canvas.width > 0 && l.canvas.height > 0);
  if (!hasAnyLayerCanvas && currentPsd._originalCompositeCanvas) {
    ctx.drawImage(currentPsd._originalCompositeCanvas, 0, 0);
    updateSelectionBox();
    return;
  }

  // 4. Vẽ đệ quy toàn bộ cây Layer với hỗ trợ đầy đủ Clipping Mask, Layer Mask & Layer Effects
  drawChildrenList(ctx, currentPsd.children, 1);
  updateSelectionBox();
}

function drawChildrenList(ctx, children, parentOpacity) {
  if (!children || children.length === 0) return;

  let i = 0;
  while (i < children.length) {
    const baseLayer = children[i];

    // Kiểm tra xem ngay phía trên baseLayer có các layer dùng Clipping Mask (clipping: true) hay không
    let j = i + 1;
    while (j < children.length && children[j].clipping) {
      j++;
    }

    if (j > i + 1) {
      // Có nhóm Clipping Mask! Nếu baseLayer không bị ẩn, ta vẽ baseLayer vào offscreen canvas rồi clip các layer phía trên vào alpha của baseLayer
      if (!baseLayer.hidden) {
        const groupCanvas = document.createElement('canvas');
        groupCanvas.width = currentPsd.width;
        groupCanvas.height = currentPsd.height;
        const gctx = groupCanvas.getContext('2d');

        // Bước 1: Vẽ Base Layer với độ mờ đầy đủ trên mặt nạ gốc, sau đó áp dụng các Clipped Layer bằng 'source-atop'
        drawSingleNodeRecursive(gctx, baseLayer, 1, false);

        for (let k = i + 1; k < j; k++) {
          const clippedLayer = children[k];
          if (clippedLayer.hidden) continue;
          const clipTemp = document.createElement('canvas');
          clipTemp.width = currentPsd.width;
          clipTemp.height = currentPsd.height;
          drawSingleNodeRecursive(clipTemp.getContext('2d'), clippedLayer, 1, false);

          gctx.save();
          gctx.globalCompositeOperation = 'source-atop';
          gctx.globalAlpha = typeof clippedLayer.opacity === 'number' ? clippedLayer.opacity : 1;
          gctx.drawImage(clipTemp, 0, 0);
          gctx.restore();
        }

        // Bước 2: Vẽ kết quả nhóm Clipping lên Canvas chính
        const baseOp = (typeof baseLayer.opacity === 'number' ? baseLayer.opacity : 1) * parentOpacity;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, baseOp));
        ctx.globalCompositeOperation = BLEND_MAP_TO_CANVAS[baseLayer.blendMode] || 'source-over';
        ctx.drawImage(groupCanvas, 0, 0);
        ctx.restore();
      }
      i = j;
    } else {
      if (!baseLayer.hidden) {
        drawSingleNodeRecursive(ctx, baseLayer, parentOpacity, false);
      }
      i++;
    }
  }
}

function drawSingleNodeRecursive(ctx, layer, parentOpacity, ignoreHidden) {
  if (!ignoreHidden && layer.hidden) return;
  const layerOpacity = (typeof layer.opacity === 'number' ? layer.opacity : 1) * parentOpacity;

  if (layer.children && layer.children.length > 0) {
    // Nếu Group có Blend Mode hoặc Opacity riêng, hoặc có Layer Mask trên Group, vẽ vào buffer nhóm trước
    const needsGroupBuffer = (layerOpacity < 0.999) || (layer.blendMode && layer.blendMode !== 'normal' && layer.blendMode !== 'pass-through') || (layer.mask && layer.mask.canvas && !layer.mask.disabled);
    if (needsGroupBuffer) {
      const grpCanvas = document.createElement('canvas');
      grpCanvas.width = currentPsd.width;
      grpCanvas.height = currentPsd.height;
      const gctx = grpCanvas.getContext('2d');
      drawChildrenList(gctx, layer.children, 1);

      if (layer.mask && layer.mask.canvas && !layer.mask.disabled) {
        applyLayerMaskToFullCanvas(grpCanvas, layer.mask);
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layerOpacity));
      ctx.globalCompositeOperation = BLEND_MAP_TO_CANVAS[layer.blendMode] || 'source-over';
      ctx.drawImage(grpCanvas, 0, 0);
      ctx.restore();
    } else {
      drawChildrenList(ctx, layer.children, layerOpacity);
    }
    return;
  }

  if (layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
    const x = layer.left || 0;
    const y = layer.top || 0;
    const w = (typeof layer.right === 'number' && layer.right > x) ? (layer.right - x) : layer.canvas.width;
    const h = (typeof layer.bottom === 'number' && layer.bottom > y) ? (layer.bottom - y) : layer.canvas.height;

    // Chuẩn bị hình ảnh của Layer (đã áp dụng Layer Mask & Layer Effects nếu có)
    const renderedSource = getProcessedLayerCanvas(layer, w, h);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, layerOpacity));
    ctx.globalCompositeOperation = BLEND_MAP_TO_CANVAS[layer.blendMode] || 'source-over';

    // Áp dụng Drop Shadow / Outer Glow trực tiếp từ layer.effects nếu được kích hoạt
    const fx = layer.effects;
    if (fx && !fx.disabled) {
      if (fx.dropShadow && fx.dropShadow.length > 0) {
        const ds = fx.dropShadow.find(d => d.enabled !== false);
        if (ds) {
          const dist = (ds.distance && ds.distance.value) ? ds.distance.value : 5;
          const angleRad = ((ds.angle !== undefined ? ds.angle : 120) * Math.PI) / 180;
          const blur = (ds.size && ds.size.value) ? ds.size.value : 8;
          const op = (ds.opacity !== undefined) ? ds.opacity : 0.65;
          ctx.shadowColor = psdColorToCss(ds.color, op);
          ctx.shadowBlur = blur;
          ctx.shadowOffsetX = Math.round(-Math.cos(angleRad) * dist);
          ctx.shadowOffsetY = Math.round(Math.sin(angleRad) * dist);
        }
      } else if (fx.outerGlow && fx.outerGlow.enabled !== false) {
        const og = fx.outerGlow;
        const blur = (og.size && og.size.value) ? og.size.value : 10;
        const op = (og.opacity !== undefined) ? og.opacity : 0.75;
        ctx.shadowColor = psdColorToCss(og.color, op);
        ctx.shadowBlur = blur;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    }

    ctx.drawImage(renderedSource.canvas, x - renderedSource.pad, y - renderedSource.pad);
    ctx.restore();
  }
}

// Xử lý Layer Mask, Color Overlay (solidFill) và Stroke (viền) cho từng Layer
function getProcessedLayerCanvas(layer, w, h) {
  const hasMask = layer.mask && layer.mask.canvas && !layer.mask.disabled;
  const fx = (layer.effects && !layer.effects.disabled) ? layer.effects : null;
  const activeStroke = (fx && fx.stroke && fx.stroke.length > 0) ? fx.stroke.find(s => s.enabled !== false) : null;
  const activeSolidFill = (fx && fx.solidFill && fx.solidFill.length > 0) ? fx.solidFill.find(s => s.enabled !== false) : null;

  const strokeSize = (activeStroke && activeStroke.size && activeStroke.size.value) ? Math.min(20, Math.max(1, Math.round(activeStroke.size.value))) : 0;
  const pad = strokeSize > 0 ? strokeSize + 2 : 0;

  if (!hasMask && !activeStroke && !activeSolidFill && w === layer.canvas.width && h === layer.canvas.height) {
    return { canvas: layer.canvas, pad: 0 };
  }

  const out = document.createElement('canvas');
  out.width = w + pad * 2;
  out.height = h + pad * 2;
  const octx = out.getContext('2d');

  // 1. Vẽ ảnh gốc của layer
  const baseTemp = document.createElement('canvas');
  baseTemp.width = w;
  baseTemp.height = h;
  const bctx = baseTemp.getContext('2d');
  bctx.drawImage(layer.canvas, 0, 0, w, h);

  // 2. Nếu có Layer Mask thì cắt theo mặt nạ Luminance/Alpha
  if (hasMask) {
    applyMaskToLayerCanvas(baseTemp, layer.left || 0, layer.top || 0, layer.mask);
  }

  // 3. Nếu có Color Overlay (solidFill trong Layer Effects)
  if (activeSolidFill && activeSolidFill.color) {
    const fillTemp = document.createElement('canvas');
    fillTemp.width = w;
    fillTemp.height = h;
    const fctx = fillTemp.getContext('2d');
    fctx.drawImage(baseTemp, 0, 0);
    fctx.globalCompositeOperation = 'source-in';
    fctx.fillStyle = psdColorToCss(activeSolidFill.color, activeSolidFill.opacity !== undefined ? activeSolidFill.opacity : 1);
    fctx.fillRect(0, 0, w, h);

    bctx.save();
    bctx.globalCompositeOperation = BLEND_MAP_TO_CANVAS[activeSolidFill.blendMode] || 'source-over';
    bctx.drawImage(fillTemp, 0, 0);
    bctx.restore();
  }

  // 4. Nếu có hiệu ứng Stroke (Viền layer trong Layer Effects) VÀ người dùng đã chỉnh sửa chữ/ảnh hoặc bật Stroke
  if (strokeSize > 0 && activeStroke.color) {
    const strokeTint = document.createElement('canvas');
    strokeTint.width = w;
    strokeTint.height = h;
    const sctx = strokeTint.getContext('2d');
    sctx.drawImage(baseTemp, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = psdColorToCss(activeStroke.color, activeStroke.opacity !== undefined ? activeStroke.opacity : 1);
    sctx.fillRect(0, 0, w, h);

    const steps = 16;
    for (let a = 0; a < steps; a++) {
      const ang = (a * 2 * Math.PI) / steps;
      const ox = Math.round(pad + Math.cos(ang) * strokeSize);
      const oy = Math.round(pad + Math.sin(ang) * strokeSize);
      octx.drawImage(strokeTint, ox, oy);
    }
  }

  octx.drawImage(baseTemp, pad, pad);
  return { canvas: out, pad };
}

// Chuyển đổi mặt nạ Grayscale của Photoshop thành kênh Alpha chuẩn để cắt Layer
function applyMaskToLayerCanvas(layerCanvas, layerLeft, layerTop, mask) {
  if (!mask || !mask.canvas) return;
  const w = layerCanvas.width;
  const h = layerCanvas.height;

  const maskAlphaCanvas = getMaskAlphaCanvas(mask);
  const mLeft = (mask.left || 0) - layerLeft;
  const mTop = (mask.top || 0) - layerTop;
  const mW = mask.canvas.width;
  const mH = mask.canvas.height;

  const fullMask = document.createElement('canvas');
  fullMask.width = w;
  fullMask.height = h;
  const fmCtx = fullMask.getContext('2d');

  // Nếu defaultColor === 255 (mặc định trắng = hiện ngoài vùng mask)
  if (mask.defaultColor === 255) {
    fmCtx.fillStyle = 'rgba(0,0,0,1)';
    fmCtx.fillRect(0, 0, w, h);
    fmCtx.clearRect(mLeft, mTop, mW, mH);
  }
  fmCtx.drawImage(maskAlphaCanvas, mLeft, mTop);

  const lctx = layerCanvas.getContext('2d');
  lctx.save();
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(fullMask, 0, 0);
  lctx.restore();
}

function applyLayerMaskToFullCanvas(fullCanvas, mask) {
  applyMaskToLayerCanvas(fullCanvas, 0, 0, mask);
}

function getMaskAlphaCanvas(mask) {
  if (mask._cachedAlphaCanvas) return mask._cachedAlphaCanvas;
  const mc = mask.canvas;
  const out = document.createElement('canvas');
  out.width = mc.width;
  out.height = mc.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(mc, 0, 0);
  try {
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imgData.data;
    // Trong Photoshop, Layer Mask lưu giá trị độ sáng (R=G=B) quy định độ đục (255 = hiện, 0 = ẩn)
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = Math.round((d[i] * d[i + 3]) / 255);
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (e) {}
  mask._cachedAlphaCanvas = out;
  return out;
}

function psdColorToCss(col, alpha) {
  if (!col) return `rgba(0,0,0,${alpha !== undefined ? alpha : 1})`;
  const r = Math.round(col.r !== undefined ? col.r : 0);
  const g = Math.round(col.g !== undefined ? col.g : 0);
  const b = Math.round(col.b !== undefined ? col.b : 0);
  const a = alpha !== undefined ? alpha : (col.a !== undefined ? col.a / 255 : 1);
  return `rgba(${r},${g},${b},${a})`;
}

function psdColorToHex(col) {
  if (!col) return '#ffffff';
  const r = Math.max(0, Math.min(255, Math.round(col.r || 0))).toString(16).padStart(2, '0');
  const g = Math.max(0, Math.min(255, Math.round(col.g || 0))).toString(16).padStart(2, '0');
  const b = Math.max(0, Math.min(255, Math.round(col.b || 0))).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function hexToPsdColor(hex) {
  const clean = (hex || '#000000').replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0
  };
}

// ============================================================================
// TƯƠNG TÁC CHUỘT & CẢM ỨNG ĐA ĐIỂM (TOUCH / PINCH-TO-ZOOM CHO TABLET & MOBILE)
// ============================================================================
function initCanvasInteractions() {
  const viewport = document.getElementById('canvasViewport');

  viewport.addEventListener('wheel', (e) => {
    if (!currentPsd) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoomBy(factor);
  }, { passive: false });

  // Chuột trên máy tính
  viewport.addEventListener('mousedown', (e) => {
    if (!currentPsd) return;
    startPointerInteraction(e.clientX, e.clientY);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingCanvas) return;
    movePointerInteraction(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', () => {
    endPointerInteraction();
  });

  // Cảm ứng trên Điện thoại & Tablet (1 ngón chọn/kéo, 2 ngón Pinch-to-Zoom)
  viewport.addEventListener('touchstart', (e) => {
    if (!currentPsd) return;
    if (e.touches.length === 2) {
      isDraggingCanvas = false;
      lastPinchDist = getTouchDistance(e.touches[0], e.touches[1]);
    } else if (e.touches.length === 1) {
      startPointerInteraction(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  viewport.addEventListener('touchmove', (e) => {
    if (!currentPsd) return;
    e.preventDefault();
    if (e.touches.length === 2) {
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      if (lastPinchDist > 0) {
        const ratio = dist / lastPinchDist;
        zoomBy(ratio);
      }
      lastPinchDist = dist;
    } else if (e.touches.length === 1 && isDraggingCanvas) {
      movePointerInteraction(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  viewport.addEventListener('touchend', () => {
    lastPinchDist = 0;
    endPointerInteraction();
  });
}

function getTouchDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.hypot(dx, dy);
}

function startPointerInteraction(clientX, clientY) {
  const viewport = document.getElementById('canvasViewport');
  isDraggingCanvas = true;
  dragStartX = clientX;
  dragStartY = clientY;

  const mainCanvas = document.getElementById('mainCanvas');
  const rect = mainCanvas.getBoundingClientRect();
  const docX = (clientX - rect.left) / zoomLevel;
  const docY = (clientY - rect.top) / zoomLevel;

  if (document.getElementById('chkAutoPickLayer').checked &&
      docX >= 0 && docX <= currentPsd.width && docY >= 0 && docY <= currentPsd.height) {
    const picked = pickTopmostVisibleLayerAt(docX, docY);
    if (picked && picked._uid !== selectedLayerId) {
      selectLayer(picked._uid);
      setStatus(`Đã chọn Layer "${picked.name}" tại (${Math.round(docX)}, ${Math.round(docY)}).`);
    }
  }

  const moveLayerMode = document.getElementById('chkMoveLayerMode').checked;
  const selLayer = findLayerById(selectedLayerId);
  if (moveLayerMode && selLayer && !selLayer.children) {
    pushUndoState(`Di chuyển Layer "${selLayer.name}"`);
    layerStartLeft = selLayer.left || 0;
    layerStartTop = selLayer.top || 0;
  } else {
    viewport.classList.add('dragging');
  }
}

function movePointerInteraction(clientX, clientY) {
  const dx = clientX - dragStartX;
  const dy = clientY - dragStartY;

  const moveLayerMode = document.getElementById('chkMoveLayerMode').checked;
  const selLayer = findLayerById(selectedLayerId);

  if (moveLayerMode && selLayer && !selLayer.children) {
    const w = (selLayer.right || 0) - (selLayer.left || 0);
    const h = (selLayer.bottom || 0) - (selLayer.top || 0);
    const newLeft = Math.round(layerStartLeft + dx / zoomLevel);
    const newTop = Math.round(layerStartTop + dy / zoomLevel);
    selLayer.left = newLeft;
    selLayer.top = newTop;
    selLayer.right = newLeft + w;
    selLayer.bottom = newTop + h;
    document.getElementById('inpLayerLeft').value = newLeft;
    document.getElementById('inpLayerTop').value = newTop;
    renderComposite();
  } else {
    panX += dx;
    panY += dy;
    dragStartX = clientX;
    dragStartY = clientY;
    applyViewportTransform();
  }
}

function endPointerInteraction() {
  isDraggingCanvas = false;
  const viewport = document.getElementById('canvasViewport');
  if (viewport) viewport.classList.remove('dragging');
}

function toggleMoveLayerMode() {
  const moveMode = document.getElementById('chkMoveLayerMode').checked;
  document.getElementById('canvasViewport').classList.toggle('move-layer-mode', moveMode);
}

function pickTopmostVisibleLayerAt(docX, docY) {
  for (const layer of flatLayers) {
    if (layer.children) continue;
    if (!isLayerEffectivelyVisible(layer)) continue;
    const l = layer.left || 0;
    const t = layer.top || 0;
    const r = layer.right || 0;
    const b = layer.bottom || 0;
    if (docX >= l && docX <= r && docY >= t && docY <= b) {
      if (layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
        try {
          const localX = Math.floor((docX - l) * (layer.canvas.width / Math.max(1, r - l)));
          const localY = Math.floor((docY - t) * (layer.canvas.height / Math.max(1, b - t)));
          const pixel = layer.canvas.getContext('2d').getImageData(localX, localY, 1, 1).data;
          if (pixel[3] > 10) return layer;
        } catch (err) {
          return layer;
        }
      } else {
        return layer;
      }
    }
  }
  return null;
}

function isLayerEffectivelyVisible(layer) {
  let cur = layer;
  while (cur && cur !== currentPsd) {
    if (cur.hidden) return false;
    cur = cur._parent;
  }
  return true;
}

// ============================================================================
// CẬP NHẬT THÔNG TIN TÀI LIỆU & DANH SÁCH CÂY LAYER
// ============================================================================
function getLayerKind(layer) {
  if (layer.children) return 'group';
  if (layer.placedLayer) return 'smart';
  if (layer.text) return 'text';
  if (layer.vectorMask || layer.vectorFill || layer.vectorStroke || layer.solidColorFill) return 'shape';
  return 'pixel';
}

function getLayerBadgeInfo(kind) {
  switch (kind) {
    case 'group': return { label: 'Group', cls: 'badge-group', icon: '📁' };
    case 'smart': return { label: 'Smart Object', cls: 'badge-smart', icon: '📦' };
    case 'text':  return { label: 'Text', cls: 'badge-text', icon: '🔤' };
    case 'shape': return { label: 'Shape/Vector', cls: 'badge-shape', icon: '✒️' };
    default:      return { label: 'Pixel', cls: 'badge-pixel', icon: '🖼️' };
  }
}

function hasActiveEffects(layer) {
  if (!layer.effects || layer.effects.disabled) return false;
  const fx = layer.effects;
  return Boolean(
    (fx.dropShadow && fx.dropShadow.length) ||
    (fx.stroke && fx.stroke.length) ||
    (fx.outerGlow && fx.outerGlow.enabled !== false) ||
    (fx.solidFill && fx.solidFill.length) ||
    (fx.gradientOverlay && fx.gradientOverlay.length) ||
    (fx.bevel && fx.bevel.enabled !== false)
  );
}

function rebuildFlatLayers() {
  flatLayers = [];
  if (!currentPsd || !currentPsd.children) return;
  function traverseTopDown(children, parentNode, depth) {
    for (let i = children.length - 1; i >= 0; i--) {
      const item = children[i];
      item._parent = parentNode;
      item._depth = depth;
      flatLayers.push(item);
      if (item.children && item.children.length > 0) {
        traverseTopDown(item.children, item, depth + 1);
      }
    }
  }
  traverseTopDown(currentPsd.children, currentPsd, 0);
  document.getElementById('layerCountHeader').textContent = flatLayers.length;
  const mobCount = document.getElementById('mobLayerCount');
  if (mobCount) mobCount.textContent = flatLayers.length;
}

function updateDocumentSummaryUI(fileName, fileSize) {
  rebuildFlatLayers();
  let groups = 0, smarts = 0, texts = 0, pixels = 0, shapes = 0, hidden = 0, fxCount = 0;
  for (const l of flatLayers) {
    const k = getLayerKind(l);
    if (k === 'group') groups++;
    else if (k === 'smart') smarts++;
    else if (k === 'text') texts++;
    else if (k === 'shape') shapes++;
    else pixels++;
    if (l.hidden) hidden++;
    if (hasActiveEffects(l)) fxCount++;
  }

  document.getElementById('docName').textContent = fileName;
  document.getElementById('docDimensions').textContent = `${currentPsd.width} × ${currentPsd.height} px`;
  document.getElementById('docFileSize').textContent = formatBytes(fileSize);

  const modeName = COLOR_MODES[currentPsd.colorMode] || `Mode ${currentPsd.colorMode}`;
  const bpc = currentPsd.bitsPerChannel || 8;
  const ch = currentPsd.channels || 3;
  document.getElementById('docColorMode').textContent = `${modeName} (${bpc}-bit, ${ch} kênh)`;

  let dpiText = '72 PPI (Mặc định)';
  if (currentPsd.imageResources && currentPsd.imageResources.resolutionInfo) {
    const res = currentPsd.imageResources.resolutionInfo;
    const hRes = Math.round(res.horizontalResolution || 72);
    const cmW = ((currentPsd.width / hRes) * 2.54).toFixed(1);
    const cmH = ((currentPsd.height / hRes) * 2.54).toFixed(1);
    dpiText = `${hRes} PPI (~${cmW} × ${cmH} cm)`;
  }
  document.getElementById('docResolution').textContent = dpiText;

  document.getElementById('docLayerStats').innerHTML =
    `Tổng: <strong>${flatLayers.length}</strong> mục ` +
    `(${pixels} Ảnh, ${smarts} Smart Object, ${texts} Chữ, ${shapes} Vector, ${groups} Group, ${fxCount} có Hiệu ứng FX, ${hidden} đang ẩn)`;
}

function renderLayerTree() {
  const container = document.getElementById('layerListContainer');
  if (!currentPsd) return;

  const keyword = (document.getElementById('searchLayerInput').value || '').trim().toLowerCase();
  const filterType = document.getElementById('filterLayerType').value;

  container.innerHTML = '';

  for (const layer of flatLayers) {
    const kind = getLayerKind(layer);
    const badge = getLayerBadgeInfo(kind);
    const nameStr = layer.name || '(Không tên)';
    const textStr = (layer.text && layer.text.text) ? layer.text.text : '';

    if (filterType !== 'all' && kind !== filterType) continue;
    if (keyword && !nameStr.toLowerCase().includes(keyword) && !textStr.toLowerCase().includes(keyword)) {
      continue;
    }

    const row = document.createElement('div');
    row.className = 'layer-item' + (layer._uid === selectedLayerId ? ' active' : '');
    row.style.paddingLeft = `${8 + layer._depth * 14}px`;
    row.onclick = () => selectLayer(layer._uid);

    const visBtn = document.createElement('button');
    visBtn.className = 'layer-vis-btn' + (layer.hidden ? ' hidden-layer' : '');
    visBtn.innerHTML = layer.hidden ? '🚫' : '👁';
    visBtn.title = layer.hidden ? 'Bật hiển thị Layer này' : 'Ẩn Layer này';
    visBtn.onclick = (e) => {
      e.stopPropagation();
      pushUndoState(`Ẩn/Hiện Layer "${layer.name}"`);
      layer.hidden = !layer.hidden;
      renderLayerTree();
      renderComposite();
      updateDocumentSummaryUI(currentFileName, currentFileSize);
    };
    row.appendChild(visBtn);

    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    if (layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
      try {
        const img = document.createElement('img');
        img.src = createSmallThumbDataUrl(layer.canvas);
        thumb.appendChild(img);
      } catch (err) {
        thumb.textContent = badge.icon;
      }
    } else {
      thumb.textContent = badge.icon;
    }
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'layer-info';

    const title = document.createElement('div');
    title.className = 'layer-name';
    title.textContent = nameStr;
    info.appendChild(title);

    const w = Math.max(0, (layer.right || 0) - (layer.left || 0));
    const h = Math.max(0, (layer.bottom || 0) - (layer.top || 0));
    const opPct = Math.round((typeof layer.opacity === 'number' ? layer.opacity : 1) * 100);
    const hasFx = hasActiveEffects(layer);
    const hasMask = Boolean(layer.mask && layer.mask.canvas);

    const meta = document.createElement('div');
    meta.className = 'layer-meta';
    meta.innerHTML = `
      <span class="badge ${badge.cls}">${badge.label}</span>
      ${hasFx ? '<span class="badge badge-fx" title="Layer có Hiệu ứng (Layer Style / Effects)">fx</span>' : ''}
      ${hasMask ? '<span class="badge badge-pixel" title="Layer có Mặt nạ (Layer Mask)">🎭Mask</span>' : ''}
      ${layer.clipping ? '<span class="badge badge-smart" title="Clipping Mask">⤵Clip</span>' : ''}
      <span>${w > 0 ? `${w}×${h}` : ''}</span>
      <span>${opPct}%</span>
    `;
    info.appendChild(meta);

    row.appendChild(info);
    container.appendChild(row);
  }
}

function createSmallThumbDataUrl(sourceCanvas) {
  if (sourceCanvas._cachedThumbUrl) return sourceCanvas._cachedThumbUrl;
  const tc = document.createElement('canvas');
  const maxDim = 48;
  const scale = Math.min(1, maxDim / Math.max(sourceCanvas.width, sourceCanvas.height));
  tc.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  tc.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  tc.getContext('2d').drawImage(sourceCanvas, 0, 0, tc.width, tc.height);
  sourceCanvas._cachedThumbUrl = tc.toDataURL();
  return sourceCanvas._cachedThumbUrl;
}

// ============================================================================
// CHỌN LAYER, CHỈNH SỬA FONT TEXT, LAYER EFFECTS, THAY ẢNH & XÓA LAYER
// ============================================================================
function findLayerById(uid) {
  return flatLayers.find(l => l._uid === uid) || null;
}

function extractTextPropertiesFromPsdLayer(layer) {
  const result = {
    text: (layer.text && layer.text.text) ? layer.text.text : '',
    fontName: 'Be Vietnam Pro',
    originalPsdFont: '',
    fontSize: 48,
    fillColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 0
  };
  if (!layer.text) return result;

  const st = layer.text.style || (layer.text.styleRuns && layer.text.styleRuns[0] && layer.text.styleRuns[0].style) || {};
  if (st.font && st.font.name) {
    result.originalPsdFont = st.font.name;
  }

  // Tính cỡ chữ thực tế sau khi nhân ma trận biến đổi (transform) của Text Layer trong PSD
  let rawSize = st.fontSize || 48;
  if (layer.text.transform && layer.text.transform.length >= 4) {
    const scaleY = Math.hypot(layer.text.transform[2], layer.text.transform[3]);
    if (scaleY > 0.01) rawSize = rawSize * scaleY;
  }
  result.fontSize = Math.max(8, Math.min(600, Math.round(rawSize)));

  if (st.fillColor) {
    result.fillColor = psdColorToHex(st.fillColor);
  }
  if (st.strokeColor) {
    result.strokeColor = psdColorToHex(st.strokeColor);
  }
  return result;
}

function selectLayer(uid) {
  selectedLayerId = uid;
  renderLayerTree();

  const layer = findLayerById(uid);
  const card = document.getElementById('selectedLayerCard');
  if (!layer) {
    card.style.display = 'none';
    updateSelectionBox();
    return;
  }

  card.style.display = 'block';
  const kind = getLayerKind(layer);
  const badge = getLayerBadgeInfo(kind);
  const badgeEl = document.getElementById('selLayerTypeBadge');
  badgeEl.className = `badge ${badge.cls}`;
  badgeEl.textContent = badge.label;

  document.getElementById('inpLayerName').value = layer.name || '';
  document.getElementById('inpLayerOpacity').value = Math.round((typeof layer.opacity === 'number' ? layer.opacity : 1) * 100);
  document.getElementById('inpLayerBlend').value = layer.blendMode || 'normal';
  document.getElementById('chkLayerClipping').checked = Boolean(layer.clipping);

  const left = layer.left || 0;
  const top = layer.top || 0;
  const width = Math.max(0, (layer.right || 0) - left);
  const height = Math.max(0, (layer.bottom || 0) - top);

  document.getElementById('inpLayerLeft').value = left;
  document.getElementById('inpLayerTop').value = top;
  document.getElementById('inpLayerWidth').value = width;
  document.getElementById('inpLayerHeight').value = height;

  // Xem trước riêng Layer
  const previewBox = document.getElementById('selLayerPreviewBox');
  previewBox.innerHTML = '';
  if (layer.canvas && layer.canvas.width > 0 && layer.canvas.height > 0) {
    const img = document.createElement('img');
    img.src = layer.canvas.toDataURL();
    previewBox.appendChild(img);
  } else if (layer.children) {
    previewBox.innerHTML = `<span style="font-size:12px; color:#d97706; font-weight:600;">📁 Nhóm chứa ${layer.children.length} layer con</span>`;
  } else {
    previewBox.innerHTML = `<span style="font-size:12px; color:var(--text-secondary)">Layer không chứa ảnh điểm riêng</span>`;
  }

  // Bảng chỉnh sửa Text & Font
  const textEditBox = document.getElementById('textEditBox');
  if (layer.text && typeof layer.text.text === 'string') {
    textEditBox.style.display = 'block';
    const tp = extractTextPropertiesFromPsdLayer(layer);
    document.getElementById('inpLayerText').value = tp.text;
    document.getElementById('inpTextSize').value = tp.fontSize;
    document.getElementById('inpTextColor').value = tp.fillColor;
    document.getElementById('origPsdFontLabel').textContent = tp.originalPsdFont
      ? `Font gốc trong PSD: "${tp.originalPsdFont}" (Đang giữ nguyên ảnh chữ gốc chuẩn Photoshop cho đến khi bạn bấm Cập nhật)`
      : `Đang giữ nguyên ảnh chữ gốc từ Photoshop`;
  } else {
    textEditBox.style.display = 'none';
  }

  // Bảng chỉnh sửa Hiệu ứng Layer (Layer Effects: Drop Shadow & Stroke)
  populateEffectsUI(layer);

  // Thông tin Smart Object
  const smartBox = document.getElementById('smartObjectInfoBox');
  if (layer.placedLayer) {
    smartBox.style.display = 'block';
    const pl = layer.placedLayer;
    const lf = layer._linkedFile;
    document.getElementById('smartObjectDetails').innerHTML = `
      <div>• ID liên kết: <code>${pl.id || 'N/A'}</code></div>
      <div>• Loại: <strong>${pl.type || 'Placed Layer'}</strong></div>
      ${pl.width && pl.height ? `<div>• Kích thước gốc: <strong>${pl.width} × ${pl.height} px</strong></div>` : ''}
      ${lf ? `<div>• File nhúng: <strong>${lf.name || 'Embedded Object'}</strong> (${formatBytes(lf.data ? lf.data.byteLength : 0)})</div>` : ''}
    `;
  } else {
    smartBox.style.display = 'none';
  }

  if (document.getElementById('chkSoloMode').checked) {
    renderComposite();
  } else {
    updateSelectionBox();
  }
}

function populateEffectsUI(layer) {
  const fx = layer.effects || {};
  const ds = (fx.dropShadow && fx.dropShadow.length > 0) ? fx.dropShadow[0] : null;
  const st = (fx.stroke && fx.stroke.length > 0) ? fx.stroke[0] : null;

  document.getElementById('chkFxDropShadow').checked = Boolean(ds && ds.enabled !== false);
  document.getElementById('inpFxShadowBlur').value = (ds && ds.size && ds.size.value !== undefined) ? ds.size.value : 8;
  document.getElementById('inpFxShadowDist').value = (ds && ds.distance && ds.distance.value !== undefined) ? ds.distance.value : 5;
  document.getElementById('inpFxShadowColor').value = (ds && ds.color) ? psdColorToHex(ds.color) : '#000000';

  document.getElementById('chkFxStroke').checked = Boolean(st && st.enabled !== false);
  document.getElementById('inpFxStrokeSize').value = (st && st.size && st.size.value !== undefined) ? st.size.value : 3;
  document.getElementById('inpFxStrokeColor').value = (st && st.color) ? psdColorToHex(st.color) : '#000000';
}

function updateSelectedLayerEffects() {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;

  if (!layer.effects) layer.effects = {};
  layer.effects.disabled = false;

  const useShadow = document.getElementById('chkFxDropShadow').checked;
  const shadowBlur = parseInt(document.getElementById('inpFxShadowBlur').value, 10) || 0;
  const shadowDist = parseInt(document.getElementById('inpFxShadowDist').value, 10) || 0;
  const shadowHex = document.getElementById('inpFxShadowColor').value || '#000000';

  layer.effects.dropShadow = [{
    enabled: useShadow,
    size: { units: 'Pixels', value: shadowBlur },
    distance: { units: 'Pixels', value: shadowDist },
    angle: 120,
    opacity: 0.75,
    color: hexToPsdColor(shadowHex)
  }];

  const useStroke = document.getElementById('chkFxStroke').checked;
  const strokeSize = parseInt(document.getElementById('inpFxStrokeSize').value, 10) || 0;
  const strokeHex = document.getElementById('inpFxStrokeColor').value || '#000000';

  layer.effects.stroke = [{
    enabled: useStroke,
    size: { units: 'Pixels', value: strokeSize },
    position: 'outside',
    opacity: 1,
    color: hexToPsdColor(strokeHex)
  }];

  renderLayerTree();
  renderComposite();
}

// Khôi phục hoàn toàn Bitmap gốc & Hiệu ứng gốc từ file PSD cho Layer đang chọn
function restoreOriginalLayerFromPsd() {
  const layer = findLayerById(selectedLayerId);
  if (!layer || !layer._originalPsdCanvas) {
    alert('Layer này không có bản sao gốc hoặc chưa từng bị thay đổi.');
    return;
  }
  pushUndoState(`Khôi phục gốc Layer "${layer.name}"`);
  const restored = document.createElement('canvas');
  restored.width = layer._originalPsdCanvas.width;
  restored.height = layer._originalPsdCanvas.height;
  restored.getContext('2d').drawImage(layer._originalPsdCanvas, 0, 0);
  layer.canvas = restored;
  if (layer._originalBounds) {
    layer.left = layer._originalBounds.left;
    layer.top = layer._originalBounds.top;
    layer.right = layer._originalBounds.right;
    layer.bottom = layer._originalBounds.bottom;
  }
  selectLayer(layer._uid);
  renderLayerTree();
  renderComposite();
  setStatus(`Đã khôi phục hình ảnh & font gốc từ PSD cho Layer "${layer.name}".`);
}

function updateSelectionBox() {
  const box = document.getElementById('selectionBox');
  const show = document.getElementById('chkShowBounds').checked;
  const layer = findLayerById(selectedLayerId);

  if (!show || !layer || layer.children) {
    box.style.display = 'none';
    return;
  }

  const left = layer.left || 0;
  const top = layer.top || 0;
  const w = Math.max(0, (layer.right || 0) - left);
  const h = Math.max(0, (layer.bottom || 0) - top);

  if (w <= 0 || h <= 0) {
    box.style.display = 'none';
    return;
  }

  box.style.display = 'block';
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  document.getElementById('selectionLabel').textContent = `${layer.name || 'Layer'} (${w}×${h})`;
}

function updateSelectedLayerProps() {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;

  layer.name = document.getElementById('inpLayerName').value;
  const opVal = parseFloat(document.getElementById('inpLayerOpacity').value);
  if (!isNaN(opVal)) {
    layer.opacity = Math.max(0, Math.min(100, opVal)) / 100;
  }
  layer.blendMode = document.getElementById('inpLayerBlend').value;
  layer.clipping = document.getElementById('chkLayerClipping').checked;

  renderLayerTree();
  renderComposite();
}

function updateSelectedLayerPosition() {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;
  pushUndoState(`Đổi tọa độ Layer "${layer.name}"`);

  const oldW = (layer.right || 0) - (layer.left || 0);
  const oldH = (layer.bottom || 0) - (layer.top || 0);
  const newLeft = parseInt(document.getElementById('inpLayerLeft').value, 10) || 0;
  const newTop = parseInt(document.getElementById('inpLayerTop').value, 10) || 0;

  layer.left = newLeft;
  layer.top = newTop;
  layer.right = newLeft + oldW;
  layer.bottom = newTop + oldH;

  renderComposite();
}

function resizeSelectedLayer() {
  const layer = findLayerById(selectedLayerId);
  if (!layer || !layer.canvas) return;
  pushUndoState(`Đổi kích thước Layer "${layer.name}"`);

  const newW = Math.max(1, parseInt(document.getElementById('inpLayerWidth').value, 10) || 1);
  const newH = Math.max(1, parseInt(document.getElementById('inpLayerHeight').value, 10) || 1);

  const newCanvas = document.createElement('canvas');
  newCanvas.width = newW;
  newCanvas.height = newH;
  newCanvas.getContext('2d').drawImage(layer.canvas, 0, 0, newW, newH);

  layer.canvas = newCanvas;
  layer.right = (layer.left || 0) + newW;
  layer.bottom = (layer.top || 0) + newH;

  selectLayer(layer._uid);
  renderComposite();
}

function duplicateSelectedLayer() {
  const layer = findLayerById(selectedLayerId);
  if (!layer || layer.children) {
    alert('Vui lòng chọn một Layer hình ảnh/văn bản để nhân bản.');
    return;
  }
  pushUndoState(`Nhân bản Layer "${layer.name}"`);
  const parentList = (layer._parent && layer._parent.children) ? layer._parent.children : currentPsd.children;
  const idx = parentList.indexOf(layer);
  if (idx === -1) return;

  let clonedCanvas = null;
  if (layer.canvas) {
    clonedCanvas = document.createElement('canvas');
    clonedCanvas.width = layer.canvas.width;
    clonedCanvas.height = layer.canvas.height;
    clonedCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);
  }

  const copy = {
    _uid: nextUid++,
    name: (layer.name || 'Layer') + ' (Bản sao)',
    left: (layer.left || 0) + 20,
    top: (layer.top || 0) + 20,
    right: (layer.right || 0) + 20,
    bottom: (layer.bottom || 0) + 20,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    hidden: false,
    canvas: clonedCanvas,
    effects: layer.effects ? JSON.parse(JSON.stringify(layer.effects)) : undefined,
    text: layer.text ? JSON.parse(JSON.stringify(layer.text)) : undefined,
    _depth: layer._depth,
    _parent: layer._parent
  };

  parentList.splice(idx + 1, 0, copy);
  updateDocumentSummaryUI(currentFileName, currentFileSize);
  selectLayer(copy._uid);
  renderLayerTree();
  renderComposite();
  setStatus(`Đã nhân bản Layer "${layer.name}".`);
}

function triggerReplaceLayerImage() {
  if (!findLayerById(selectedLayerId)) {
    alert('Vui lòng chọn một Layer ở danh sách trước khi thay thế.');
    return;
  }
  document.getElementById('replaceImageInput').click();
}

async function handleReplaceSelectedLayerWithImage(file) {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;

  try {
    pushUndoState(`Thay thế ảnh Layer "${layer.name}"`);
    const img = await blobToImage(file);
    const fitMode = document.getElementById('replaceFitMode').value;

    const oldLeft = layer.left || 0;
    const oldTop = layer.top || 0;
    const oldW = Math.max(1, (layer.right || currentPsd.width) - oldLeft);
    const oldH = Math.max(1, (layer.bottom || currentPsd.height) - oldTop);

    let targetW = oldW;
    let targetH = oldH;
    let drawX = 0, drawY = 0, drawW = oldW, drawH = oldH;

    if (fitMode === 'original') {
      targetW = img.naturalWidth;
      targetH = img.naturalHeight;
      drawW = targetW;
      drawH = targetH;
    } else if (fitMode === 'contain') {
      const scale = Math.min(oldW / img.naturalWidth, oldH / img.naturalHeight);
      drawW = Math.round(img.naturalWidth * scale);
      drawH = Math.round(img.naturalHeight * scale);
      drawX = Math.round((oldW - drawW) / 2);
      drawY = Math.round((oldH - drawH) / 2);
    } else if (fitMode === 'cover') {
      const scale = Math.max(oldW / img.naturalWidth, oldH / img.naturalHeight);
      drawW = Math.round(img.naturalWidth * scale);
      drawH = Math.round(img.naturalHeight * scale);
      drawX = Math.round((oldW - drawW) / 2);
      drawY = Math.round((oldH - drawH) / 2);
    }

    const newCanvas = document.createElement('canvas');
    newCanvas.width = targetW;
    newCanvas.height = targetH;
    const ctx = newCanvas.getContext('2d');
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    layer.canvas = newCanvas;
    layer.right = oldLeft + targetW;
    layer.bottom = oldTop + targetH;
    layer.hidden = false;

    if (layer.text) delete layer.text;

    if (layer._linkedFile) {
      const pngBlob = await new Promise(res => newCanvas.toBlob(res, 'image/png'));
      layer._linkedFile.data = new Uint8Array(await pngBlob.arrayBuffer());
      layer._linkedFile._decodedCanvas = newCanvas;
    }

    selectLayer(layer._uid);
    renderLayerTree();
    renderComposite();
    setStatus(`Đã thay thế nội dung Layer "${layer.name}" bằng ảnh "${file.name}" (${targetW}×${targetH} px).`);
  } catch (err) {
    alert('Không thể đọc file ảnh thay thế: ' + err.message);
  }
}

async function handleAddNewImageLayer(file) {
  if (!currentPsd) return;
  try {
    pushUndoState(`Thêm Layer ảnh "${file.name}"`);
    const img = await blobToImage(file);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);

    const left = Math.round((currentPsd.width - c.width) / 2);
    const top = Math.round((currentPsd.height - c.height) / 2);

    const newLayer = {
      _uid: nextUid++,
      name: file.name.replace(/\.[^.]+$/, ''),
      left: left,
      top: top,
      right: left + c.width,
      bottom: top + c.height,
      opacity: 1,
      blendMode: 'normal',
      hidden: false,
      canvas: c,
      _depth: 0,
      _parent: currentPsd
    };

    currentPsd.children.push(newLayer);
    updateDocumentSummaryUI(currentFileName, currentFileSize);
    selectLayer(newLayer._uid);
    renderLayerTree();
    renderComposite();
    setStatus(`Đã thêm Layer mới "${newLayer.name}" (${c.width}×${c.height} px).`);
  } catch (err) {
    alert('Lỗi khi thêm ảnh: ' + err.message);
  }
}

function addNewTextLayer() {
  if (!currentPsd) return;
  const textContent = prompt('Nhập nội dung chữ tiếng Việt cho Layer mới:', 'Văn bản thiết kế');
  if (!textContent) return;
  pushUndoState(`Thêm Layer chữ "${textContent}"`);

  const fontSize = Math.max(28, Math.round(currentPsd.width * 0.04));
  const c = renderRichTextToCanvas(textContent, 'Be Vietnam Pro', fontSize, '700', '#ffffff', '#000000', 0);
  const left = Math.round((currentPsd.width - c.width) / 2);
  const top = Math.round((currentPsd.height - c.height) / 2);

  const newLayer = {
    _uid: nextUid++,
    name: textContent.slice(0, 30),
    left: left,
    top: top,
    right: left + c.width,
    bottom: top + c.height,
    opacity: 1,
    blendMode: 'normal',
    hidden: false,
    canvas: c,
    text: { text: textContent },
    _depth: 0,
    _parent: currentPsd
  };

  currentPsd.children.push(newLayer);
  updateDocumentSummaryUI(currentFileName, currentFileSize);
  selectLayer(newLayer._uid);
  renderLayerTree();
  renderComposite();
  setStatus(`Đã thêm Layer chữ "${newLayer.name}".`);
}

function applyTextToSelectedLayer() {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;
  pushUndoState(`Cập nhật chữ Layer "${layer.name}"`);

  const textVal = document.getElementById('inpLayerText').value || '';
  const fontFamily = document.getElementById('inpTextFont').value || 'Be Vietnam Pro';
  const fontWeight = document.getElementById('inpTextWeight').value || '700';
  const fontSize = parseInt(document.getElementById('inpTextSize').value, 10) || 48;
  const color = document.getElementById('inpTextColor').value || '#ffffff';
  const strokeColor = document.getElementById('inpTextOutlineColor').value || '#000000';
  const strokeWidth = parseInt(document.getElementById('inpTextOutlineWidth').value, 10) || 0;

  const c = renderRichTextToCanvas(textVal, fontFamily, fontSize, fontWeight, color, strokeColor, strokeWidth);
  layer.canvas = c;
  layer.right = (layer.left || 0) + c.width;
  layer.bottom = (layer.top || 0) + c.height;
  layer.name = textVal.split('\n')[0].slice(0, 32) || layer.name;
  if (!layer.text) layer.text = {};
  layer.text.text = textVal;
  if (!layer.text.style) layer.text.style = {};
  layer.text.style.fontSize = fontSize;
  layer.text.style.fillColor = hexToPsdColor(color);

  selectLayer(layer._uid);
  renderLayerTree();
  renderComposite();
  setStatus(`Đã render văn bản mới với font "${fontFamily}" cho Layer "${layer.name}".`);
}

function renderRichTextToCanvas(text, fontFamily, fontSize, fontWeight, fillColor, strokeColor, strokeWidth) {
  const lines = text.split(/\r?\n/);
  const temp = document.createElement('canvas');
  const tctx = temp.getContext('2d');
  const fontSpec = `${fontWeight} ${fontSize}px "${fontFamily}", "Be Vietnam Pro", "Segoe UI", Arial, sans-serif`;
  tctx.font = fontSpec;

  let maxW = 10;
  for (const line of lines) {
    const m = tctx.measureText(line);
    if (m.width > maxW) maxW = m.width;
  }

  const pad = Math.max(12, strokeWidth * 2 + 8);
  const lineHeight = Math.round(fontSize * 1.3);
  const c = document.createElement('canvas');
  c.width = Math.ceil(maxW + pad * 2);
  c.height = Math.ceil(lines.length * lineHeight + pad * 2);

  const ctx = c.getContext('2d');
  ctx.font = fontSpec;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  lines.forEach((line, idx) => {
    const x = pad;
    const y = pad + idx * lineHeight;
    if (strokeWidth > 0) {
      ctx.lineWidth = strokeWidth * 2;
      ctx.strokeStyle = strokeColor;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(line, x, y);
  });
  return c;
}

function deleteSelectedLayer() {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;

  const parentList = (layer._parent && layer._parent.children) ? layer._parent.children : currentPsd.children;
  const idx = parentList.indexOf(layer);
  if (idx === -1) return;

  pushUndoState(`Xóa Layer "${layer.name}"`);
  const deletedName = layer.name || 'Layer';
  parentList.splice(idx, 1);
  selectedLayerId = null;

  updateDocumentSummaryUI(currentFileName, currentFileSize);
  renderLayerTree();
  renderComposite();

  if (flatLayers.length > 0) {
    selectLayer(flatLayers[0]._uid);
  } else {
    document.getElementById('selectedLayerCard').style.display = 'none';
  }

  setStatus(`Đã xóa Layer "${deletedName}" (Nhấn Ctrl+Z hoặc nút Hoàn tác nếu cần khôi phục).`);
}

function moveSelectedLayer(direction) {
  const layer = findLayerById(selectedLayerId);
  if (!layer) return;
  const parentList = (layer._parent && layer._parent.children) ? layer._parent.children : currentPsd.children;
  const idx = parentList.indexOf(layer);
  if (idx === -1) return;

  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= parentList.length) return;

  pushUndoState(`Đổi thứ tự Layer "${layer.name}"`);
  const temp = parentList[idx];
  parentList[idx] = parentList[targetIdx];
  parentList[targetIdx] = temp;

  rebuildFlatLayers();
  renderLayerTree();
  renderComposite();
  setStatus(`Đã thay đổi thứ tự Layer "${layer.name}".`);
}

function toggleAllLayers(visible) {
  if (!currentPsd) return;
  pushUndoState(visible ? 'Hiện tất cả Layer' : 'Ẩn tất cả Layer');
  for (const l of flatLayers) {
    l.hidden = !visible;
  }
  updateDocumentSummaryUI(currentFileName, currentFileSize);
  renderLayerTree();
  renderComposite();
}

// ============================================================================
// XUẤT FILE PNG, JPG, TẢI RIÊNG LAYER & LƯU FILE .PSD CHUẨN
// ============================================================================
function exportFullImage(format) {
  if (!currentPsd) return;
  renderComposite();
  const mainCanvas = document.getElementById('mainCanvas');
  const baseName = currentFileName.replace(/\.[^.]+$/, '');

  if (format === 'png') {
    mainCanvas.toBlob((blob) => {
      triggerDownloadBlob(blob, `${baseName}_edited.png`);
      setStatus(`Đã xuất file ảnh PNG "${baseName}_edited.png" thành công!`);
    }, 'image/png');
  }
}

function openJpgExportModal() {
  if (!currentPsd) return;
  document.getElementById('jpgModal').classList.add('open');
}

function confirmExportJPG() {
  if (!currentPsd) return;
  renderComposite();
  const mainCanvas = document.getElementById('mainCanvas');
  const quality = (parseInt(document.getElementById('jpgQualitySlider').value, 10) || 92) / 100;
  const bgColor = document.getElementById('jpgBgColor').value || '#ffffff';

  const outCanvas = document.createElement('canvas');
  outCanvas.width = mainCanvas.width;
  outCanvas.height = mainCanvas.height;
  const octx = outCanvas.getContext('2d');
  octx.fillStyle = bgColor;
  octx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  octx.drawImage(mainCanvas, 0, 0);

  const baseName = currentFileName.replace(/\.[^.]+$/, '');
  outCanvas.toBlob((blob) => {
    triggerDownloadBlob(blob, `${baseName}_edited.jpg`);
    closeModal('jpgModal');
    setStatus(`Đã xuất file ảnh JPG "${baseName}_edited.jpg" (Chất lượng ${Math.round(quality * 100)}%)!`);
  }, 'image/jpeg', quality);
}

function exportSelectedLayerPNG() {
  const layer = findLayerById(selectedLayerId);
  if (!layer || !layer.canvas) {
    alert('Layer đang chọn là thư mục hoặc không có hình ảnh riêng để xuất.');
    return;
  }
  const safeName = (layer.name || 'layer').replace(/[\\/:*?"<>|]/g, '_');
  layer.canvas.toBlob((blob) => {
    triggerDownloadBlob(blob, `${safeName}.png`);
    setStatus(`Đã tải riêng Layer "${layer.name}" dưới dạng PNG.`);
  }, 'image/png');
}

function saveAsPSD() {
  if (!currentPsd) return;
  setStatus('Đang đóng gói cấu trúc Layer, Smart Object, Hiệu ứng và tạo file .PSD...');

  setTimeout(() => {
    try {
      renderComposite();
      currentPsd.canvas = document.getElementById('mainCanvas');

      function sanitizeForWrite(children) {
        if (!children) return;
        for (const item of children) {
          if (item.canvas && !item.children) {
            delete item.imageData;
          }
          if (item.children) sanitizeForWrite(item.children);
        }
      }
      sanitizeForWrite(currentPsd.children);

      const psdArrayBuffer = agPsd.writePsd(currentPsd, {
        generateThumbnail: true,
        noBackground: true
      });

      const blob = new Blob([psdArrayBuffer], { type: 'application/octet-stream' });
      const baseName = currentFileName.replace(/\.[^.]+$/, '');
      triggerDownloadBlob(blob, `${baseName}_edited.psd`);
      setStatus(`Đã lưu file "${baseName}_edited.psd" (${formatBytes(blob.size)}) thành công!`);
    } catch (err) {
      console.error('Lỗi khi ghi PSD:', err);
      alert('Có lỗi khi tạo file PSD: ' + (err.message || err));
      setStatus('Lỗi khi lưu PSD: ' + (err.message || err));
    }
  }, 50);
}

function triggerDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

// ============================================================================
// BÁO CÁO PHÂN TÍCH CẤU TRÚC PSD CHI TIẾT
// ============================================================================
function openStructureReport() {
  if (!currentPsd) return;
  const lines = [];
  lines.push('================================================================================');
  lines.push(`BÁO CÁO PHÂN TÍCH CẤU TRÚC FILE PHOTOSHOP (.PSD)`);
  lines.push('================================================================================');
  lines.push(`• Tên file           : ${currentFileName}`);
  lines.push(`• Dung lượng         : ${formatBytes(currentFileSize)} (${currentFileSize.toLocaleString()} bytes)`);
  lines.push(`• Kích thước         : ${currentPsd.width} × ${currentPsd.height} px`);
  lines.push(`• Hệ màu             : ${COLOR_MODES[currentPsd.colorMode] || currentPsd.colorMode} (${currentPsd.bitsPerChannel || 8}-bit, ${currentPsd.channels || 3} kênh)`);
  lines.push(`• Tổng số mục Layer  : ${flatLayers.length}`);
  if (currentPsd.linkedFiles && currentPsd.linkedFiles.length > 0) {
    lines.push(`• File Smart Object  : ${currentPsd.linkedFiles.length} file nhúng (Embedded Smart Objects)`);
    currentPsd.linkedFiles.forEach((lf, idx) => {
      lines.push(`   [${idx + 1}] "${lf.name || 'SmartObject'}" (ID: ${lf.id || 'N/A'}, Loại: ${lf.type || 'N/A'}, Dung lượng: ${formatBytes(lf.data ? lf.data.byteLength : 0)})`);
    });
  }
  lines.push('');
  lines.push('--------------------------------------------------------------------------------');
  lines.push('CÂY CẤU TRÚC LAYER (Từ trên xuống dưới theo thứ tự hiển thị Photoshop):');
  lines.push('--------------------------------------------------------------------------------');

  for (const l of flatLayers) {
    const indent = '  '.repeat(l._depth || 0);
    const vis = l.hidden ? '[ẨN]  ' : '[HIỆN]';
    const kind = getLayerBadgeInfo(getLayerKind(l)).label.toUpperCase();
    const w = Math.max(0, (l.right || 0) - (l.left || 0));
    const h = Math.max(0, (l.bottom || 0) - (l.top || 0));
    const op = Math.round((typeof l.opacity === 'number' ? l.opacity : 1) * 100);
    const fxInfo = hasActiveEffects(l) ? ' | [Có Hiệu ứng FX]' : '';
    const maskInfo = (l.mask && l.mask.canvas) ? ' | [Có Layer Mask]' : '';
    const clipInfo = l.clipping ? ' | [Clipping Mask]' : '';
    const tp = extractTextPropertiesFromPsdLayer(l);
    const textInfo = (l.text && l.text.text) ? ` | Font: "${tp.originalPsdFont || 'Default'}" (${tp.fontSize}px) | Chữ: "${l.text.text.replace(/\r?\n/g, ' ')}"` : '';
    lines.push(`${indent}${vis} [${kind}] "${l.name || ''}" — Tọa độ:(${l.left || 0}, ${l.top || 0}), Kích thước:${w}×${h}px, Blend:${l.blendMode || 'normal'}, Opacity:${op}%${fxInfo}${maskInfo}${clipInfo}${textInfo}`);
  }

  document.getElementById('reportContent').textContent = lines.join('\n');
  document.getElementById('reportModal').classList.add('open');
}

function copyReportText() {
  const text = document.getElementById('reportContent').textContent;
  navigator.clipboard.writeText(text);
  setStatus('Đã sao chép báo cáo cấu trúc PSD vào bộ nhớ tạm!');
}

function downloadReportFile() {
  const text = document.getElementById('reportContent').textContent;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const baseName = currentFileName.replace(/\.[^.]+$/, '');
  triggerDownloadBlob(blob, `Cau_truc_${baseName}.txt`);
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// ============================================================================
// THU PHÓNG & DỰ PHÒNG BINARY PARSER
// ============================================================================
function applyViewportTransform() {
  const wrapper = document.getElementById('canvasWrapper');
  wrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
  document.getElementById('zoomLabel').textContent = `${Math.round(zoomLevel * 100)}%`;
}

function setZoom(newZoom) {
  zoomLevel = Math.max(0.02, Math.min(8, newZoom));
  applyViewportTransform();
}

function zoomBy(factor) {
  setZoom(zoomLevel * factor);
}

function fitCanvasToScreen() {
  if (!currentPsd) return;
  const viewport = document.getElementById('canvasViewport');
  const vw = Math.max(200, viewport.clientWidth - 40);
  const vh = Math.max(200, viewport.clientHeight - 40);
  const scaleX = vw / currentPsd.width;
  const scaleY = vh / currentPsd.height;
  zoomLevel = Math.max(0.02, Math.min(1.5, Math.min(scaleX, scaleY)));
  panX = 0;
  panY = 0;
  applyViewportTransform();
}

function parsePsdBinaryFallback(buffer) {
  const dv = new DataView(buffer);
  let pos = 0;
  function readAscii(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(pos + i));
    pos += len;
    return s;
  }
  const sig = readAscii(4);
  if (sig !== '8BPS') throw new Error('Không phải file Photoshop hợp lệ (Chữ ký: ' + sig + ')');
  const version = dv.getUint16(pos, false); pos += 2;
  const isPsb = (version === 2);
  pos += 6;
  const channels = dv.getUint16(pos, false); pos += 2;
  const height = dv.getUint32(pos, false); pos += 4;
  const width = dv.getUint32(pos, false); pos += 4;
  const bitsPerChannel = dv.getUint16(pos, false); pos += 2;
  const colorMode = dv.getUint16(pos, false); pos += 2;
  const colorDataLen = dv.getUint32(pos, false); pos += 4 + colorDataLen;
  const imgResLen = dv.getUint32(pos, false); pos += 4 + imgResLen;
  const layerMaskLen = isPsb ? Number(dv.getBigUint64(pos, false)) : dv.getUint32(pos, false);
  pos += isPsb ? 8 : 4;
  const flatRecords = [];
  if (layerMaskLen > 0) {
    const layerInfoLen = isPsb ? Number(dv.getBigUint64(pos, false)) : dv.getUint32(pos, false);
    pos += isPsb ? 8 : 4;
    if (layerInfoLen > 0) {
      const rawCount = dv.getInt16(pos, false); pos += 2;
      const layerCount = Math.abs(rawCount);
      for (let i = 0; i < layerCount; i++) {
        const top = dv.getInt32(pos, false); pos += 4;
        const left = dv.getInt32(pos, false); pos += 4;
        const bottom = dv.getInt32(pos, false); pos += 4;
        const right = dv.getInt32(pos, false); pos += 4;
        const numCh = dv.getUint16(pos, false); pos += 2;
        for (let c = 0; c < numCh; c++) pos += 2 + (isPsb ? 8 : 4);
        pos += 4; readAscii(4);
        const opacity = dv.getUint8(pos++) / 255;
        const clipping = dv.getUint8(pos++) !== 0;
        const flags = dv.getUint8(pos++);
        const hidden = (flags & 2) !== 0;
        pos++;
        const extraLen = dv.getUint32(pos, false); pos += 4;
        const extraEnd = pos + extraLen;
        const maskLen = dv.getUint32(pos, false); pos += 4 + maskLen;
        const brLen = dv.getUint32(pos, false); pos += 4 + brLen;
        const nameLen = dv.getUint8(pos);
        let name = readAscii(1 + nameLen).substring(1);
        pos += (4 - ((1 + nameLen) % 4)) % 4;
        let sectionType = 0, placedLayer = null, textObj = null;
        while (pos + 12 <= extraEnd) {
          const aSig = readAscii(4);
          if (aSig !== '8BIM' && aSig !== '8B64') break;
          const aKey = readAscii(4);
          const aLen = dv.getUint32(pos, false); pos += 4;
          const aStart = pos;
          if (aKey === 'luni' && aLen >= 4) {
            const uLen = dv.getUint32(pos, false); pos += 4;
            let uStr = '';
            for (let u = 0; u < uLen && pos + 2 <= aStart + aLen; u++) {
              const ch = dv.getUint16(pos, false); pos += 2;
              if (ch !== 0) uStr += String.fromCharCode(ch);
            }
            if (uStr) name = uStr;
          } else if ((aKey === 'lsct' || aKey === 'lsdk') && aLen >= 4) {
            sectionType = dv.getInt32(pos, false);
          } else if (aKey === 'SoLd' || aKey === 'PlLd') {
            placedLayer = { id: 'SmartObject', type: 'raster' };
          } else if (aKey === 'TySh') {
            textObj = { text: name };
          }
          pos = aStart + aLen;
        }
        pos = extraEnd;
        flatRecords.push({ name, top, left, bottom, right, opacity, blendMode: 'normal', hidden, clipping, sectionType, placedLayer, text: textObj });
      }
    }
  }
  const rootChildren = [];
  const stack = [rootChildren];
  for (let i = flatRecords.length - 1; i >= 0; i--) {
    const r = flatRecords[i];
    if (r.sectionType === 1 || r.sectionType === 2) {
      const grp = { name: r.name, hidden: r.hidden, opacity: r.opacity, blendMode: 'normal', children: [] };
      stack[stack.length - 1].unshift(grp);
      stack.push(grp.children);
    } else if (r.sectionType === 3) {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].unshift(r);
    }
  }
  return { width, height, channels, bitsPerChannel, colorMode, children: rootChildren };
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setStatus(msg) {
  const el = document.getElementById('statusText');
  if (el) el.textContent = msg;
}
