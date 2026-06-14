/**
 * KessanTracker - 決算発表記録アプリ
 * メインアプリケーションロジック
 */

// ========================================
// Constants
// ========================================
const DB_NAME = 'KessanTrackerDB';
const DB_VERSION = 1;
const STORE_NAME = 'records';

// ========================================
// Analytics Engine - 自動判定ロジック
// ========================================
const Analytics = {
  /**
   * 前期比%からトレンド矢印を判定
   * @param {number|null} yoy - 前期同期比（%）
   * @returns {{arrow: string, label: string, class: string}}
   */
  getTrend(yoy) {
    if (yoy == null || isNaN(yoy)) return { arrow: '—', label: '—', class: '' };
    if (yoy >= 50)  return { arrow: '↑↑', label: '大幅増', class: 'val-positive' };
    if (yoy >= 20)  return { arrow: '↑',  label: '増益',   class: 'val-positive' };
    if (yoy >= 5)   return { arrow: '↗',  label: '微増',   class: 'val-positive' };
    if (yoy >= -5)  return { arrow: '→',  label: '横ばい', class: '' };
    if (yoy >= -20) return { arrow: '↘',  label: '微減',   class: 'val-negative' };
    if (yoy >= -50) return { arrow: '↓',  label: '減益',   class: 'val-negative' };
    return             { arrow: '↓↓', label: '大幅減', class: 'val-negative' };
  },

  /**
   * 四半期と進捗率から進捗ペースを判定
   * @param {string} quarter - "1Q" | "2Q" | "3Q" | "本決算"
   * @param {number|null} progress - 進捗率（%）
   * @returns {{label: string, class: string, score: number}}
   */
  getPace(quarter, progress) {
    if (progress == null || isNaN(progress)) return { label: '—', class: '', score: 0 };

    const benchmarks = { '1Q': 25, '2Q': 50, '3Q': 75, '本決算': 100 };
    const benchmark = benchmarks[quarter];
    if (!benchmark) return { label: '—', class: '', score: 0 };

    const diff = progress - benchmark;

    if (diff >= 10)  return { label: '大幅上振れ', class: 'val-positive', score: 2 };
    if (diff >= 3)   return { label: '上振れ',     class: 'val-positive', score: 1 };
    if (diff >= -3)  return { label: '標準',       class: '',             score: 0 };
    if (diff >= -10) return { label: '下振れ',     class: 'val-negative', score: -1 };
    return               { label: '大幅下振れ', class: 'val-negative', score: -2 };
  },

  /**
   * 総合シグナルを計算
   * YoY% + 進捗ペース + 通期修正を複合的に評価
   * @param {object} record - 決算レコード
   * @returns {{label: string, emoji: string, class: string, value: string, score: number}}
   */
  getSignal(record) {
    let score = 0;

    // 1. YoY%からのスコア (-3 ~ +3)
    const yoy = record.yoy;
    if (yoy != null && !isNaN(yoy)) {
      if (yoy >= 50)       score += 3;
      else if (yoy >= 20)  score += 2;
      else if (yoy >= 5)   score += 1;
      else if (yoy >= -5)  score += 0;
      else if (yoy >= -20) score -= 1;
      else if (yoy >= -50) score -= 2;
      else                 score -= 3;
    }

    // 2. 進捗ペースからのスコア (-2 ~ +2)
    const pace = this.getPace(record.quarter, record.progress);
    score += pace.score;

    // 3. 通期予想修正からのスコア (-2 ~ +2)
    switch (record.revision) {
      case 'up':   score += 2; break;
      case 'hold': score += 0; break;
      case 'down': score -= 2; break;
      default:     score += 0; break;
    }

    // 4. 配当方針からのスコア (-2 ~ +2)
    switch (record.dividendStatus) {
      case 'up':   score += 2; break;
      case 'down': score -= 2; break;
      case 'none': score -= 1; break;
      default:     score += 0; break;
    }

    // 5. 自社株買いからのスコア (0 ~ +1)
    if (record.buyback === 'yes') {
      score += 1;
    }

    // 6. 評価からのボーナス (-1 ~ +1)
    switch (record.rating) {
      case '◎': score += 1; break;
      case '×': score -= 1; break;
    }

    // スコアをシグナルに変換 (合計: -10 ~ +11)
    if (score >= 5)  return { label: '強気',     emoji: '🟢', class: 'val-positive', value: 'strong-buy', score };
    if (score >= 2)  return { label: 'やや強気', emoji: '🔵', class: 'val-positive', value: 'buy',        score };
    if (score >= -1) return { label: '中立',     emoji: '⚪', class: '',             value: 'neutral',    score };
    if (score >= -4) return { label: 'やや弱気', emoji: '🟠', class: 'val-negative', value: 'sell',       score };
    return                   { label: '弱気',     emoji: '🔴', class: 'val-negative', value: 'strong-sell', score };
  },

  /**
   * レコードに解析結果を付与
   */
  enrichRecord(record) {
    record._trend = this.getTrend(record.yoy);
    record._pace = this.getPace(record.quarter, record.progress);
    record._signal = this.getSignal(record);
    return record;
  }
};

// ========================================
// IndexedDB Manager
// ========================================
class DB {
  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('code', 'code', { unique: false });
          store.createIndex('date', 'date', { unique: false });
        }
      };
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });
  }

  static async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async add(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.add(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async update(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(record);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  static async delete(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async clear() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async importAll(records) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      records.forEach(r => {
        const clean = { ...r };
        delete clean.id; // let autoIncrement assign new IDs
        store.add(clean);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ========================================
// App State
// ========================================
let allRecords = [];
let currentSort = { key: 'date', dir: 'desc' };
let currentDetailId = null;

// ========================================
// DOM References
// ========================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  tableBody: $('#tableBody'),
  emptyState: $('#emptyState'),
  recordCount: $('#recordCount'),
  searchInput: $('#searchInput'),
  filterQuarter: $('#filterQuarter'),
  filterRating: $('#filterRating'),
  filterSignal: $('#filterSignal'),

  // Input modal
  inputModal: $('#inputModal'),
  modalTitle: $('#modalTitle'),
  editId: $('#editId'),
  inputCode: $('#inputCode'),
  stockNameDisplay: $('#stockNameDisplay'),
  suggestionList: $('#suggestionList'),
  inputFiscalYear: $('#inputFiscalYear'),
  inputFiscalMonth: $('#inputFiscalMonth'),
  inputDate: $('#inputDate'),
  quarterGroup: $('#quarterGroup'),
  ratingGroup: $('#ratingGroup'),
  profitTypeGroup: $('#profitTypeGroup'),
  inputProfit: $('#inputProfit'),
  inputYoY: $('#inputYoY'),
  inputRevenue: $('#inputRevenue'),
  inputProgress: $('#inputProgress'),
  revisionGroup: $('#revisionGroup'),
  dividendStatusGroup: $('#dividendStatusGroup'),
  inputDividendValue: $('#inputDividendValue'),
  buybackGroup: $('#buybackGroup'),
  inputMemo: $('#inputMemo'),

  // AI Bulk Input
  aiInputText: $('#aiInputText'),
  btnCopyPrompt: $('#btnCopyPrompt'),
  btnApplyAiInput: $('#btnApplyAiInput'),

  // Detail overlay
  detailOverlay: $('#detailOverlay'),
  detailCode: $('#detailCode'),
  detailName: $('#detailName'),
  detailGrid: $('#detailGrid'),
  detailHistoryBody: $('#detailHistoryBody'),
  detailMemo: $('#detailMemo'),
  detailMemoSection: $('#detailMemoSection'),

  // Export/Import modal
  exportModal: $('#exportModal'),
  exportModalTitle: $('#exportModalTitle'),
  exportContent: $('#exportContent'),
  importContent: $('#importContent'),
  exportTextarea: $('#exportTextarea'),
  importTextarea: $('#importTextarea'),
  btnCopyExport: $('#btnCopyExport'),
  btnDoImport: $('#btnDoImport'),

  // Confirm
  confirmOverlay: $('#confirmOverlay'),
  confirmMessage: $('#confirmMessage'),

  // Toast
  toast: $('#toast'),
};

// ========================================
// Initialization
// ========================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadRecords();
  setupEventListeners();
  setDefaultFormValues();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});

async function loadRecords() {
  try {
    allRecords = await DB.getAll();
    allRecords.forEach(r => Analytics.enrichRecord(r));
    renderTable();
  } catch (e) {
    console.error('Failed to load records:', e);
  }
}

function setDefaultFormValues() {
  const now = new Date();
  dom.inputDate.value = formatDateInput(now);
  dom.inputFiscalYear.value = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
}

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '—';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

// ========================================
// Event Listeners
// ========================================
function setupEventListeners() {
  // FAB
  $('#fabAdd').addEventListener('click', openAddModal);

  // Modal close
  $('#modalClose').addEventListener('click', closeInputModal);
  $('#btnCancelForm').addEventListener('click', closeInputModal);
  dom.inputModal.addEventListener('click', (e) => {
    if (e.target === dom.inputModal) closeInputModal();
  });

  // Save
  $('#btnSaveForm').addEventListener('click', saveRecord);

  // Stock code input
  dom.inputCode.addEventListener('input', onCodeInput);
  dom.inputCode.addEventListener('focus', onCodeInput);
  dom.inputCode.addEventListener('blur', () => {
    setTimeout(() => dom.suggestionList.classList.remove('active'), 200);
  });

  // Quarter buttons
  dom.quarterGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.quarter-btn');
    if (!btn) return;
    dom.quarterGroup.querySelectorAll('.quarter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Rating buttons
  dom.ratingGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.rating-btn');
    if (!btn) return;
    dom.ratingGroup.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Profit type toggle
  dom.profitTypeGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-option');
    if (!btn) return;
    dom.profitTypeGroup.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Revision buttons
  dom.revisionGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.revision-btn');
    if (!btn) return;
    dom.revisionGroup.querySelectorAll('.revision-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Dividend Status buttons
  dom.dividendStatusGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.div-status-btn');
    if (!btn) return;
    dom.dividendStatusGroup.querySelectorAll('.div-status-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // Buyback buttons
  dom.buybackGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.buyback-btn');
    if (!btn) return;
    dom.buybackGroup.querySelectorAll('.buyback-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // AI Bulk Input Actions
  dom.btnCopyPrompt.addEventListener('click', copyPromptTemplate);
  dom.btnApplyAiInput.addEventListener('click', applyAiInput);

  // Table sort
  $$('.data-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => handleSort(th.dataset.sort));
  });

  // Filters
  dom.searchInput.addEventListener('input', renderTable);
  dom.filterQuarter.addEventListener('change', renderTable);
  dom.filterRating.addEventListener('change', renderTable);
  dom.filterSignal.addEventListener('change', renderTable);

  // Detail overlay
  $('#detailClose').addEventListener('click', closeDetail);
  dom.detailOverlay.addEventListener('click', (e) => {
    if (e.target === dom.detailOverlay) closeDetail();
  });
  $('#btnDetailEdit').addEventListener('click', () => {
    closeDetail();
    const rec = allRecords.find(r => r.id === currentDetailId);
    if (rec) openEditModal(rec);
  });
  $('#btnDetailDelete').addEventListener('click', () => {
    showConfirm('この決算データを削除しますか？', async () => {
      await DB.delete(currentDetailId);
      closeDetail();
      await loadRecords();
      showToast('削除しました');
    });
  });

  // Confirm dialog
  $('#btnConfirmCancel').addEventListener('click', closeConfirm);
  dom.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === dom.confirmOverlay) closeConfirm();
  });

  // Export
  $('#btnExport').addEventListener('click', openExportModal);
  $('#btnImport').addEventListener('click', openImportModal);
  $('#exportModalClose').addEventListener('click', closeExportModal);
  $('#btnExportClose').addEventListener('click', closeExportModal);
  dom.exportModal.addEventListener('click', (e) => {
    if (e.target === dom.exportModal) closeExportModal();
  });
  dom.btnCopyExport.addEventListener('click', copyExport);
  dom.btnDoImport.addEventListener('click', doImport);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dom.confirmOverlay.classList.contains('active')) closeConfirm();
      else if (dom.detailOverlay.classList.contains('active')) closeDetail();
      else if (dom.inputModal.classList.contains('active')) closeInputModal();
      else if (dom.exportModal.classList.contains('active')) closeExportModal();
    }
  });
}

// ========================================
// Stock Code Input
// ========================================
function onCodeInput() {
  const val = dom.inputCode.value.trim();

  // Show stock name
  if (val.length === 4) {
    const name = lookupStock(val);
    if (name) {
      dom.stockNameDisplay.textContent = name;
      dom.stockNameDisplay.className = 'stock-name-display';
    } else {
      dom.stockNameDisplay.textContent = '銘柄が見つかりません（手動入力可）';
      dom.stockNameDisplay.className = 'stock-name-display not-found';
    }
    dom.suggestionList.classList.remove('active');
  } else if (val.length > 0) {
    dom.stockNameDisplay.textContent = '4桁のコードを入力...';
    dom.stockNameDisplay.className = 'stock-name-display empty';

    // Show suggestions
    const results = searchStocks(val);
    if (results.length > 0) {
      dom.suggestionList.innerHTML = results.map(r =>
        `<div class="suggestion-item" data-code="${r.code}">
          <span class="suggestion-code">${r.code}</span>
          <span class="suggestion-name">${r.name}</span>
        </div>`
      ).join('');
      dom.suggestionList.classList.add('active');

      // Click handler for suggestions
      dom.suggestionList.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const code = item.dataset.code;
          dom.inputCode.value = code;
          onCodeInput();
        });
      });
    } else {
      dom.suggestionList.classList.remove('active');
    }
  } else {
    dom.stockNameDisplay.textContent = 'コードを入力してください';
    dom.stockNameDisplay.className = 'stock-name-display empty';
    dom.suggestionList.classList.remove('active');
  }
}

// ========================================
// Modal Management
// ========================================
function openAddModal() {
  resetForm();
  dom.modalTitle.textContent = '決算データ入力';
  dom.inputModal.classList.add('active');
  // モーダル内スクロール位置をリセット
  const modalBody = dom.inputModal.querySelector('.modal-body');
  if (modalBody) modalBody.scrollTop = 0;
  dom.inputCode.focus();
}

function openEditModal(record) {
  resetForm();
  dom.modalTitle.textContent = '決算データ編集';
  dom.editId.value = record.id;

  // Fill form
  dom.inputCode.value = record.code || '';
  onCodeInput();
  dom.inputFiscalYear.value = record.fiscalYear || '';
  dom.inputFiscalMonth.value = record.fiscalMonth || '3';
  dom.inputDate.value = record.date || '';

  // Quarter
  dom.quarterGroup.querySelectorAll('.quarter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === record.quarter);
  });

  // Rating
  dom.ratingGroup.querySelectorAll('.rating-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === record.rating);
  });

  // Profit type
  dom.profitTypeGroup.querySelectorAll('.toggle-option').forEach(b => {
    b.classList.toggle('active', b.dataset.value === record.profitType);
  });

  dom.inputProfit.value = record.profit ?? '';
  dom.inputYoY.value = record.yoy ?? '';
  dom.inputRevenue.value = record.revenue ?? '';
  dom.inputProgress.value = record.progress ?? '';

  // Revision
  dom.revisionGroup.querySelectorAll('.revision-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === record.revision);
  });

  // Dividend Status
  dom.dividendStatusGroup.querySelectorAll('.div-status-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (record.dividendStatus || 'hold'));
  });

  dom.inputDividendValue.value = record.dividendValue ?? '';

  // Buyback
  dom.buybackGroup.querySelectorAll('.buyback-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (record.buyback || 'no'));
  });

  dom.inputMemo.value = record.memo || '';

  dom.inputModal.classList.add('active');
  // モーダル内スクロール位置をリセット
  const modalBody = dom.inputModal.querySelector('.modal-body');
  if (modalBody) modalBody.scrollTop = 0;
}

function closeInputModal() {
  dom.inputModal.classList.remove('active');
}

function resetForm() {
  dom.editId.value = '';
  dom.inputCode.value = '';
  dom.stockNameDisplay.textContent = 'コードを入力してください';
  dom.stockNameDisplay.className = 'stock-name-display empty';
  dom.suggestionList.classList.remove('active');

  const now = new Date();
  dom.inputFiscalYear.value = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  dom.inputFiscalMonth.value = '3';
  dom.inputDate.value = formatDateInput(now);

  dom.quarterGroup.querySelectorAll('.quarter-btn').forEach(b => b.classList.remove('active'));
  dom.quarterGroup.querySelector('[data-value="本決算"]').classList.add('active');

  dom.ratingGroup.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('active'));

  dom.profitTypeGroup.querySelectorAll('.toggle-option').forEach(b => b.classList.remove('active'));
  dom.profitTypeGroup.querySelector('[data-value="経常"]').classList.add('active');

  dom.inputProfit.value = '';
  dom.inputYoY.value = '';
  dom.inputRevenue.value = '';
  dom.inputProgress.value = '';

  dom.revisionGroup.querySelectorAll('.revision-btn').forEach(b => b.classList.remove('active'));
  dom.revisionGroup.querySelector('[data-value="hold"]').classList.add('active');

  dom.dividendStatusGroup.querySelectorAll('.div-status-btn').forEach(b => b.classList.remove('active'));
  dom.dividendStatusGroup.querySelector('[data-value="hold"]').classList.add('active');

  dom.inputDividendValue.value = '';

  dom.buybackGroup.querySelectorAll('.buyback-btn').forEach(b => b.classList.remove('active'));
  dom.buybackGroup.querySelector('[data-value="no"]').classList.add('active');

  dom.inputMemo.value = '';
  dom.aiInputText.value = '';
  const details = $('.ai-input-details');
  if (details) details.removeAttribute('open');
}

// ========================================
// Save Record
// ========================================
async function saveRecord() {
  const code = dom.inputCode.value.trim();
  if (!code || code.length !== 4) {
    showToast('⚠️ 銘柄コードを4桁で入力してください');
    dom.inputCode.focus();
    return;
  }

  const record = {
    code,
    name: lookupStock(code) || code,
    fiscalYear: parseInt(dom.inputFiscalYear.value) || new Date().getFullYear(),
    fiscalMonth: parseInt(dom.inputFiscalMonth.value) || 3,
    date: dom.inputDate.value,
    quarter: getActiveValue(dom.quarterGroup, '.quarter-btn'),
    rating: getActiveValue(dom.ratingGroup, '.rating-btn') || '',
    profitType: getActiveValue(dom.profitTypeGroup, '.toggle-option'),
    profit: parseFloatOrNull(dom.inputProfit.value),
    yoy: parseFloatOrNull(dom.inputYoY.value),
    revenue: parseFloatOrNull(dom.inputRevenue.value),
    progress: parseFloatOrNull(dom.inputProgress.value),
    revision: getActiveValue(dom.revisionGroup, '.revision-btn'),
    dividendStatus: getActiveValue(dom.dividendStatusGroup, '.div-status-btn') || 'hold',
    dividendValue: parseFloatOrNull(dom.inputDividendValue.value),
    buyback: getActiveValue(dom.buybackGroup, '.buyback-btn') || 'no',
    memo: dom.inputMemo.value.trim(),
    updatedAt: new Date().toISOString(),
  };

  const editId = dom.editId.value;

  try {
    if (editId) {
      record.id = parseInt(editId);
      await DB.update(record);
      showToast('✅ 更新しました');
    } else {
      record.createdAt = new Date().toISOString();
      await DB.add(record);
      showToast('✅ 保存しました');
    }

    closeInputModal();
    await loadRecords();
  } catch (e) {
    console.error('Save error:', e);
    showToast('⚠️ 保存に失敗しました');
  }
}

function getActiveValue(container, selector) {
  const active = container.querySelector(`${selector}.active`);
  return active ? active.dataset.value : '';
}

function parseFloatOrNull(val) {
  if (val === '' || val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ========================================
// Rendering
// ========================================
function renderTable() {
  const filtered = getFilteredRecords();
  const sorted = getSortedRecords(filtered);

  dom.recordCount.textContent = `${filtered.length}件`;
  dom.emptyState.style.display = sorted.length === 0 ? 'block' : 'none';

  dom.tableBody.innerHTML = sorted.map(r => {
    const trend = r._trend || Analytics.getTrend(r.yoy);
    const pace = r._pace || Analytics.getPace(r.quarter, r.progress);
    const signal = r._signal || Analytics.getSignal(r);

    const profitClass = (r.profit != null && r.profit < 0) ? 'val-negative' : (r.profit != null && r.profit > 0) ? 'val-positive' : '';
    const yoyClass = trend.class;

    const ratingMap = {
      '◎': 'rating-excellent',
      '○': 'rating-good',
      '△': 'rating-fair',
      '×': 'rating-poor',
    };

    const revisionLabels = {
      'up':   { text: '上方↑', class: 'revision-up' },
      'hold': { text: '据置→', class: 'revision-hold' },
      'down': { text: '下方↓', class: 'revision-down' },
      'none': { text: '未発表', class: 'revision-none' },
    };
    const rev = revisionLabels[r.revision] || { text: '—', class: '' };

    const quarterClass = r.quarter === '本決算' ? 'q-final' : '';

    return `<tr data-id="${r.id}">
      <td>${r.rating ? `<span class="rating-badge ${ratingMap[r.rating] || ''}">${r.rating}</span>` : '<span style="color:var(--color-text-tertiary)">—</span>'}</td>
      <td class="col-code">${r.code}</td>
      <td class="col-name" title="${r.name}">${r.name}</td>
      <td class="col-date">${r.fiscalYear}.${String(r.fiscalMonth).padStart(2,'0')}期</td>
      <td class="col-quarter"><span class="quarter-chip ${quarterClass}">${r.quarter || '—'}</span></td>
      <td class="col-date">${formatDateDisplay(r.date)}</td>
      <td class="${yoyClass}" title="${trend.label}" style="text-align:center;font-size:1.1rem;font-weight:700;">${trend.arrow}</td>
      <td class="col-number ${profitClass}">${r.profit != null ? r.profit.toLocaleString() : '—'}<br><span class="profit-type-label">${r.profitType || ''}</span></td>
      <td class="col-number ${yoyClass}">${r.yoy != null ? (r.yoy >= 0 ? '+' : '') + r.yoy.toFixed(1) + '%' : '—'}</td>
      <td class="col-number">${r.revenue != null ? r.revenue.toLocaleString() : '—'}</td>
      <td class="col-number">${r.progress != null ? r.progress.toFixed(1) + '%' : '—'}</td>
      <td class="${pace.class}" style="font-size:var(--font-size-xs);font-weight:600;white-space:nowrap;">${pace.label}</td>
      <td><span class="revision-badge ${rev.class}">${rev.text}</span></td>
      <td style="white-space:nowrap;font-size:var(--font-size-xs);font-weight:600;" class="${signal.class}" title="スコア: ${signal.score}">${signal.emoji} ${signal.label}</td>
      <td>${r.memo ? '<span class="memo-indicator"><span class="memo-dot"></span>有</span>' : ''}</td>
    </tr>`;
  }).join('');

  // Row click to open detail
  dom.tableBody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = parseInt(tr.dataset.id);
      const rec = allRecords.find(r => r.id === id);
      if (rec) openDetail(rec);
    });
  });

  // Update sort headers
  $$('.data-table th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === currentSort.key);
    const icon = th.querySelector('.sort-icon');
    if (icon) {
      icon.textContent = (th.dataset.sort === currentSort.key && currentSort.dir === 'asc') ? '▲' : '▼';
    }
  });
}

function getFilteredRecords() {
  const search = dom.searchInput.value.trim().toLowerCase();
  const qFilter = dom.filterQuarter.value;
  const rFilter = dom.filterRating.value;
  const sFilter = dom.filterSignal.value;

  return allRecords.filter(r => {
    if (search && !r.code.includes(search) && !r.name.toLowerCase().includes(search)) return false;
    if (qFilter && r.quarter !== qFilter) return false;
    if (rFilter && r.rating !== rFilter) return false;
    if (sFilter && r._signal && r._signal.value !== sFilter) return false;
    return true;
  });
}

function getSortedRecords(records) {
  const { key, dir } = currentSort;
  const mult = dir === 'asc' ? 1 : -1;

  return [...records].sort((a, b) => {
    let va, vb;

    switch (key) {
      case 'code':     va = a.code; vb = b.code; break;
      case 'name':     va = a.name; vb = b.name; break;
      case 'period':   va = `${a.fiscalYear}.${a.fiscalMonth}`; vb = `${b.fiscalYear}.${b.fiscalMonth}`; break;
      case 'quarter':  va = quarterOrder(a.quarter); vb = quarterOrder(b.quarter); return (va - vb) * mult;
      case 'date':     va = a.date || ''; vb = b.date || ''; break;
      case 'profit':   va = a.profit ?? -Infinity; vb = b.profit ?? -Infinity; return (va - vb) * mult;
      case 'yoy':      va = a.yoy ?? -Infinity; vb = b.yoy ?? -Infinity; return (va - vb) * mult;
      case 'revenue':  va = a.revenue ?? -Infinity; vb = b.revenue ?? -Infinity; return (va - vb) * mult;
      case 'progress': va = a.progress ?? -Infinity; vb = b.progress ?? -Infinity; return (va - vb) * mult;
      case 'rating':   va = ratingOrder(a.rating); vb = ratingOrder(b.rating); return (va - vb) * mult;
      case 'trend':    va = a.yoy ?? -Infinity; vb = b.yoy ?? -Infinity; return (va - vb) * mult;
      case 'pace':     va = a._pace?.score ?? 0; vb = b._pace?.score ?? 0; return (va - vb) * mult;
      case 'revision': va = revisionOrder(a.revision); vb = revisionOrder(b.revision); return (va - vb) * mult;
      case 'signal':   va = a._signal?.score ?? 0; vb = b._signal?.score ?? 0; return (va - vb) * mult;
      default:         va = a.date || ''; vb = b.date || ''; break;
    }

    if (typeof va === 'string') return va.localeCompare(vb) * mult;
    return (va - vb) * mult;
  });
}

function quarterOrder(q) {
  const map = { '1Q': 1, '2Q': 2, '3Q': 3, '本決算': 4 };
  return map[q] || 0;
}

function ratingOrder(r) {
  const map = { '◎': 4, '○': 3, '△': 2, '×': 1 };
  return map[r] || 0;
}

function revisionOrder(r) {
  const map = { 'up': 3, 'hold': 2, 'down': 1, 'none': 0 };
  return map[r] || 0;
}

function handleSort(key) {
  if (currentSort.key === key) {
    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.key = key;
    currentSort.dir = 'desc';
  }
  renderTable();
}

// ========================================
// Detail Panel
// ========================================
function openDetail(record) {
  currentDetailId = record.id;

  dom.detailCode.textContent = record.code;
  dom.detailName.textContent = record.name;

  const trend = record._trend || Analytics.getTrend(record.yoy);
  const pace = record._pace || Analytics.getPace(record.quarter, record.progress);
  const signal = record._signal || Analytics.getSignal(record);

  const revisionLabels = {
    'up': '上方修正↑', 'hold': '据え置き→', 'down': '下方修正↓', 'none': '未発表',
  };

  const divLabels = {
    'up': '増配＋', 'hold': '据置→', 'down': '減配－', 'none': '無配', 'unknown': '非開示'
  };

  const items = [
    { label: '決算期', value: `${record.fiscalYear}.${String(record.fiscalMonth).padStart(2,'0')}期` },
    { label: '四半期', value: record.quarter || '—' },
    { label: '発表日', value: formatDateDisplay(record.date) },
    { label: '評価', value: record.rating || '—' },
    { label: `${record.profitType || '経常'}損益`, value: record.profit != null ? `${record.profit.toLocaleString()} 億円` : '—', class: record.profit < 0 ? 'val-negative' : record.profit > 0 ? 'val-positive' : '' },
    { label: '前年比', value: record.yoy != null ? `${record.yoy >= 0 ? '+' : ''}${record.yoy.toFixed(1)}%  ${trend.arrow}` : '—', class: trend.class },
    { label: '売上高', value: record.revenue != null ? `${record.revenue.toLocaleString()} 億円` : '—' },
    { label: '進捗率', value: record.progress != null ? `${record.progress.toFixed(1)}%` : '—' },
    { label: '進捗ペース', value: pace.label, class: pace.class },
    { label: '通期予想', value: revisionLabels[record.revision] || '—' },
    { label: '配当方針', value: `${divLabels[record.dividendStatus] || '—'}${record.dividendValue ? ` (${record.dividendValue}円)` : ''}`, class: record.dividendStatus === 'up' ? 'val-positive' : record.dividendStatus === 'down' ? 'val-negative' : '' },
    { label: '自社株買い', value: record.buyback === 'yes' ? '発表有' : '無/発表無', class: record.buyback === 'yes' ? 'val-positive' : '' },
    { label: '総合シグナル', value: `${signal.emoji} ${signal.label}（スコア: ${signal.score}）`, class: signal.class },
  ];

  dom.detailGrid.innerHTML = items.map(item =>
    `<div class="detail-item">
      <div class="detail-item-label">${item.label}</div>
      <div class="detail-item-value ${item.class || ''}">${item.value}</div>
    </div>`
  ).join('');

  if (record.memo) {
    dom.detailMemoSection.style.display = 'block';
    dom.detailMemo.textContent = record.memo;
  } else {
    dom.detailMemoSection.style.display = 'none';
  }

  // 同一銘柄の履歴を抽出して描画
  const historyRecords = allRecords.filter(r => r.code === record.code);
  const quarterWeights = { '1Q': 1, '2Q': 2, '3Q': 3, '本決算': 4 };
  historyRecords.sort((a, b) => {
    if (a.fiscalYear !== b.fiscalYear) return a.fiscalYear - b.fiscalYear;
    if (a.fiscalMonth !== b.fiscalMonth) return a.fiscalMonth - b.fiscalMonth;
    const wa = quarterWeights[a.quarter] || 0;
    const wb = quarterWeights[b.quarter] || 0;
    return wa - wb;
  });

  dom.detailHistoryBody.innerHTML = historyRecords.map(r => {
    const t = r._trend || Analytics.getTrend(r.yoy);
    const s = r._signal || Analytics.getSignal(r);
    const divLab = divLabels[r.dividendStatus] || '—';
    
    let divCls = '';
    if (r.dividendStatus === 'up') divCls = 'val-positive';
    if (r.dividendStatus === 'down') divCls = 'val-negative';

    return `<tr>
      <td style="font-weight:600">${r.fiscalYear}.${String(r.fiscalMonth).padStart(2,'0')}</td>
      <td><span class="quarter-chip ${r.quarter === '本決算' ? 'q-final' : ''}" style="font-size:10px; padding:1px 6px;">${r.quarter || '—'}</span></td>
      <td style="text-align:right">${r.revenue != null ? r.revenue.toLocaleString() : '—'}</td>
      <td style="text-align:right" class="${r.profit < 0 ? 'val-negative' : r.profit > 0 ? 'val-positive' : ''}">${r.profit != null ? r.profit.toLocaleString() : '—'}</td>
      <td style="text-align:right" class="${t.class}">${r.yoy != null ? (r.yoy >= 0 ? '+' : '') + r.yoy.toFixed(1) + '%' : '—'}</td>
      <td style="text-align:right">${r.progress != null ? r.progress.toFixed(1) + '%' : '—'}</td>
      <td class="${divCls}">${divLab}${r.dividendValue ? `(${r.dividendValue}円)` : ''}</td>
      <td>${r.buyback === 'yes' ? '<span class="val-positive" style="font-weight:700;">有</span>' : '無'}</td>
      <td style="white-space:nowrap; font-weight:600;" class="${s.class}">${s.emoji} ${s.label}</td>
    </tr>`;
  }).join('');

  dom.detailOverlay.classList.add('active');
}

function closeDetail() {
  dom.detailOverlay.classList.remove('active');
  currentDetailId = null;
}

// ========================================
// Export / Import
// ========================================
function openExportModal() {
  dom.exportModalTitle.textContent = 'データエクスポート';
  dom.exportContent.style.display = 'block';
  dom.importContent.style.display = 'none';
  dom.btnCopyExport.style.display = 'inline-flex';
  dom.btnDoImport.style.display = 'none';

  // Export only essential fields
  const exportData = allRecords.map(r => {
    const { _trend, _pace, _signal, ...clean } = r;
    return clean;
  });
  dom.exportTextarea.value = JSON.stringify(exportData, null, 2);
  dom.exportModal.classList.add('active');
}

function openImportModal() {
  dom.exportModalTitle.textContent = 'データインポート';
  dom.exportContent.style.display = 'none';
  dom.importContent.style.display = 'block';
  dom.btnCopyExport.style.display = 'none';
  dom.btnDoImport.style.display = 'inline-flex';
  dom.importTextarea.value = '';
  dom.exportModal.classList.add('active');
}

function closeExportModal() {
  dom.exportModal.classList.remove('active');
}

function copyExport() {
  dom.exportTextarea.select();
  navigator.clipboard.writeText(dom.exportTextarea.value).then(() => {
    showToast('📋 クリップボードにコピーしました');
  }).catch(() => {
    document.execCommand('copy');
    showToast('📋 コピーしました');
  });
}

async function doImport() {
  const text = dom.importTextarea.value.trim();
  if (!text) {
    showToast('⚠️ データを貼り付けてください');
    return;
  }

  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Invalid format');

    showConfirm(`${data.length}件のデータをインポートします。\n既存データは全て上書きされます。よろしいですか？`, async () => {
      await DB.importAll(data);
      closeExportModal();
      await loadRecords();
      showToast(`✅ ${data.length}件をインポートしました`);
    });
  } catch (e) {
    showToast('⚠️ JSONの形式が正しくありません');
  }
}

// ========================================
// Confirm Dialog
// ========================================
let confirmCallback = null;

function showConfirm(message, callback) {
  dom.confirmMessage.textContent = message;
  confirmCallback = callback;
  dom.confirmOverlay.classList.add('active');

  $('#btnConfirmOk').onclick = () => {
    closeConfirm();
    if (confirmCallback) confirmCallback();
  };
}

function closeConfirm() {
  dom.confirmOverlay.classList.remove('active');
  confirmCallback = null;
}

// ========================================
// Toast
// ========================================
let toastTimer = null;

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('show');
  }, 2500);
}

// ========================================
// AI Bulk Input Actions
// ========================================
function copyPromptTemplate() {
  const prompt = `株探の決算速報記事から、以下の項目を抽出して出力してください。数値は必ず「億円」単位の数値部分のみ（またはパーセントの数値部分のみ）にしてください。不明な項目は「不明」または空欄にしてください。

【出力フォーマット】
コード: 4桁の銘柄コード
決算期: 例「2025年3月期」や「2025.3」
四半期: 「1Q」「2Q」「3Q」「本決算」のいずれか
発表日: YYYY-MM-DD 形式
評価: 記事全体のトーンから「◎（絶好調・サプライズ）」「○（好調・順調）」「△（普通・横ばい）」「×（悪い・下方）」のいずれか
損益区分: 「経常」または「最終」
損益: 利益（または赤字）の額（億円）
前年比: 前年同期比の増減率（%）
売上高: 売上高の額（億円）
進捗率: 通期計画に対する進捗率（%）
予想修正: 「up（上方修正有）」「hold（据え置き）」「down（下方修正有）」「none（未発表）」のいずれか
配当方針: 「up（増配発表有）」「hold（据え置き）」「down（減配発表有）」「none（無配）」「unknown（非開示）」のいずれか
年間配当: 年間配当金（円）
自社株買い: 「yes（発表有）」または「no（無し）」
メモ: 決算の要約や注目ポイント（30字〜100字程度）

【記事本文】
[ここに株探の記事本文を貼り付ける]`;

  navigator.clipboard.writeText(prompt).then(() => {
    showToast('📋 プロンプトをコピーしました');
  }).catch(() => {
    showToast('⚠️ コピーに失敗しました');
  });
}

function applyAiInput() {
  const text = dom.aiInputText.value.trim();
  if (!text) {
    showToast('⚠️ AIの出力テキストを貼り付けてください');
    return;
  }

  let parsed = null;

  // 1. Try parsing as JSON (including embedded in markdown block)
  try {
    const matchJson = text.match(/\{[\s\S]*\}/);
    if (matchJson) {
      parsed = JSON.parse(matchJson[0]);
    } else {
      parsed = JSON.parse(text);
    }
  } catch (e) {
    // 2. Try fallback parsing as Key-Value text
    parsed = parseTextToRecord(text);
  }

  if (parsed && (parsed.code || parsed.name)) {
    fillFormWithData(parsed);
    showToast('⚡ データを自動入力しました');
    dom.aiInputText.value = '';
    const details = $('.ai-input-details');
    if (details) details.removeAttribute('open');
  } else {
    showToast('⚠️ 解析できませんでした。形式を確認してください。');
  }
}

function parseTextToRecord(text) {
  const lines = text.split('\n');
  const record = {};
  
  const getNum = (v) => {
    // Strip emojis and other symbols, keep numbers and minus signs
    const cleaned = v.replace(/[^\d.-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  };

  lines.forEach(line => {
    const parts = line.split(/[:：]/);
    if (parts.length < 2) return;
    const key = parts[0].trim();
    const val = parts.slice(1).join(':').trim();

    if (key.includes('コード') || key.includes('銘柄コード')) {
      const match = val.match(/\d{4}/);
      if (match) record.code = match[0];
    } else if (key.includes('決算期')) {
      const matchY = val.match(/(\d{4})/);
      const matchM = val.match(/[.年](\d{1,2})/);
      if (matchY) record.fiscalYear = parseInt(matchY[1]);
      if (matchM) record.fiscalMonth = parseInt(matchM[1]);
    } else if (key.includes('四半期') || key.includes('該当四半期')) {
      if (val.includes('1Q')) record.quarter = '1Q';
      else if (val.includes('2Q') || val.includes('中間')) record.quarter = '2Q';
      else if (val.includes('3Q')) record.quarter = '3Q';
      else if (val.includes('本決算') || val.includes('4Q')) record.quarter = '本決算';
    } else if (key.includes('発表日')) {
      const match = val.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
      if (match) {
        record.date = `${match[1]}-${String(match[2]).padStart(2,'0')}-${String(match[3]).padStart(2,'0')}`;
      } else {
        record.date = val;
      }
    } else if (key.includes('評価')) {
      if (val.includes('◎')) record.rating = '◎';
      else if (val.includes('○') || val.includes('〇') || val.includes('良好')) record.rating = '○';
      else if (val.includes('△')) record.rating = '△';
      else if (val.includes('×') || val.includes('✕')) record.rating = '×';
    } else if (key.includes('損益区分')) {
      if (val.includes('最終')) record.profitType = '最終';
      else if (val.includes('経常')) record.profitType = '経常';
    } else if (key.includes('損益') && !key.includes('区分')) {
      record.profit = getNum(val);
    } else if (key.includes('前年比') || key.includes('同期比') || key.includes('YoY')) {
      record.yoy = getNum(val);
    } else if (key.includes('売上')) {
      record.revenue = getNum(val);
    } else if (key.includes('進捗')) {
      record.progress = getNum(val);
    } else if (key.includes('予想修正') || key.includes('修正')) {
      if (val.includes('up') || val.includes('上方')) record.revision = 'up';
      else if (val.includes('down') || val.includes('下方')) record.revision = 'down';
      else if (val.includes('hold') || val.includes('据置') || val.includes('維持')) record.revision = 'hold';
      else if (val.includes('none') || val.includes('未発表')) record.revision = 'none';
    } else if (key.includes('配当方針') || key.includes('配当修正')) {
      if (val.includes('up') || val.includes('増配')) record.dividendStatus = 'up';
      else if (val.includes('down') || val.includes('減配')) record.dividendStatus = 'down';
      else if (val.includes('hold') || val.includes('据置') || val.includes('維持')) record.dividendStatus = 'hold';
      else if (val.includes('none') || val.includes('無配')) record.dividendStatus = 'none';
      else if (val.includes('unknown') || val.includes('非開示')) record.dividendStatus = 'unknown';
    } else if (key.includes('配当金') || key.includes('配当額') || key.includes('年間配当')) {
      record.dividendValue = getNum(val);
    } else if (key.includes('自社株買い') || key.includes('自社株')) {
      if (val.includes('有') || val.includes('発表') || val.includes('yes') || val.includes('あり')) record.buyback = 'yes';
      else record.buyback = 'no';
    } else if (key.includes('メモ')) {
      record.memo = val;
    }
  });

  return record;
}

function fillFormWithData(data) {
  if (data.code) {
    dom.inputCode.value = data.code;
    onCodeInput();
  }
  if (data.fiscalYear) dom.inputFiscalYear.value = data.fiscalYear;
  if (data.fiscalMonth) dom.inputFiscalMonth.value = data.fiscalMonth;
  if (data.date) dom.inputDate.value = data.date;
  
  if (data.quarter) {
    dom.quarterGroup.querySelectorAll('.quarter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.quarter);
    });
  }
  
  if (data.rating) {
    dom.ratingGroup.querySelectorAll('.rating-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.rating);
    });
  }
  
  if (data.profitType) {
    dom.profitTypeGroup.querySelectorAll('.toggle-option').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.profitType);
    });
  }
  
  if (data.profit !== undefined && data.profit !== null) dom.inputProfit.value = data.profit;
  if (data.yoy !== undefined && data.yoy !== null) dom.inputYoY.value = data.yoy;
  if (data.revenue !== undefined && data.revenue !== null) dom.inputRevenue.value = data.revenue;
  if (data.progress !== undefined && data.progress !== null) dom.inputProgress.value = data.progress;
  
  if (data.revision) {
    dom.revisionGroup.querySelectorAll('.revision-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.revision);
    });
  }
  
  if (data.dividendStatus) {
    dom.dividendStatusGroup.querySelectorAll('.div-status-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.dividendStatus);
    });
  }
  
  if (data.dividendValue !== undefined && data.dividendValue !== null) dom.inputDividendValue.value = data.dividendValue;
  
  if (data.buyback) {
    dom.buybackGroup.querySelectorAll('.buyback-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === data.buyback);
    });
  }
  
  if (data.memo) dom.inputMemo.value = data.memo;
}
