// Nav
document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    const view = btn.dataset.view;
    if (view === 'sources') loadSources();
    if (view === 'admin') loadAdminPanel();
  });
});

// Badge
async function updateBadge() {
  try {
    const res = await fetch('/api/articles/unseen-count');
    const { count } = await res.json();
    const badge = document.getElementById('unseen-badge');
    const tabBadge = document.getElementById('unread-tab-badge');
    badge.textContent = count;
    badge.classList.toggle('visible', count > 0);
    tabBadge.textContent = count;
    tabBadge.classList.toggle('visible', count > 0);
  } catch {}
}

// Articles
function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function renderEmptyArticles() {
  const container = document.getElementById('articles-list');
  try {
    const res = await fetch('/api/sources');
    const sources = await res.json();
    if (!sources.length) {
      container.innerHTML = '<div class="empty"><strong>No articles yet</strong><p>Add a source to get started.</p></div>';
    } else {
      container.innerHTML = '<div class="empty"><strong>All caught up</strong><p>No new articles right now. Check back later.</p></div>';
    }
  } catch {
    container.innerHTML = '<div class="empty"><strong>No articles</strong></div>';
  }
}

function renderArticles(articles) {
  const container = document.getElementById('articles-list');
  if (!articles.length) {
    renderEmptyArticles();
    return;
  }

  window._articleAnalysis = window._articleAnalysis ?? {};
  articles.forEach(a => {
    if (a.analysis_notes) window._articleAnalysis[a.id] = { name: a.title ?? a.url, notes: a.analysis_notes };
  });

  container.innerHTML = articles.map(a => {
    const dismissed = !a.is_relevant;
    const aiFiltered = dismissed && !a.user_dismissed;
    return [
      '<div class="article-card" id="article-' + a.id + '" style="' + (a.source_color ? 'background:' + escHtml(a.source_color) + ';' : '') + (!a.seen ? 'border-color:var(--accent);' : (a.source_color ? 'border-color:' + escHtml(a.source_color) + ';' : '')) + '">',
        // top-right icon cluster
        '<div class="card-top-actions">',
          ((activeArticleTab === 'all' && a.seen) || a.analysis_notes) ? [
            '<div style="position:relative">',
              '<button class="card-icon-btn" title="More options" onclick="toggleCardMenu(' + a.id + ', event)"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="2.5" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="7" cy="11.5" r="1.3"/></svg></button>',
              '<div class="card-menu-dropdown" id="card-menu-' + a.id + '">',
                (activeArticleTab === 'all' && a.seen) ? '<button class="card-menu-item" onclick="closeCardMenu(' + a.id + '); markUnseen(' + a.id + ')">Mark as unseen</button>' : '',
                a.analysis_notes ? '<button class="card-menu-item" onclick="closeCardMenu(' + a.id + '); openAiAnalysis(' + a.id + ', \'article\')">AI log</button>' : '',
              '</div>',
            '</div>',
          ].join('') : '',
          dismissed ? '' : '<button class="card-icon-btn dismiss" title="Not interested" onclick="openDismissModal(' + a.id + ')"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg></button>',
        '</div>',
        // meta + title
        '<div class="article-meta">',
          '<span class="source-tag">' + escHtml(a.source_name ?? 'Unknown') + '</span>',
          '<span class="article-date">' + formatDate(a.published_at ?? a.fetched_at) + '</span>',
        '</div>',
        '<h2 class="article-title" style="padding-right:4rem"><a href="' + escHtml(a.url) + '" target="_blank" rel="noopener" onclick="markSeen(' + a.id + ')">' + escHtml(a.title ?? a.url) + '</a></h2>',
        // AI filter reason or user-dismissed banner
        aiFiltered ? '<div class="ai-filter-reason"><span>Filtered by AI' + (a.relevance_reason ? ': ' + escHtml(a.relevance_reason) : '') + '</span><button class="btn" onclick="restoreArticle(' + a.id + ')">Restore</button></div>' : '',
        dismissed && !aiFiltered ? '<div class="dismissed-banner"><span>✕ Not interested' + (a.feedback_reason ? ' — ' + escHtml(a.feedback_reason) : '') + '</span><button class="btn" onclick="restoreArticle(' + a.id + ')">Restore</button></div>' : '',
        // body
        '<div class="article-body">',
          a.image_url ? '<img class="article-image" src="' + escHtml(a.image_url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '',
          a.summary ? '<p class="article-summary">' + escHtml(a.summary) + '</p>' : '',
        '</div>',
      '</div>',
    ].join('');
  }).join('');
}

let activeArticleTab = 'unread';
let currentPage = 0;
const PAGE_SIZE = 10;

function renderPagination(hasNext) {
  const el = document.getElementById('articles-pagination');
  if (currentPage === 0 && !hasNext) { el.innerHTML = ''; return; }
  el.innerHTML = [
    '<button class="btn" onclick="goPage(-1)"' + (currentPage === 0 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="9,2 4,7 9,12"/></svg> Prev</button>',
    '<span>Page ' + (currentPage + 1) + '</span>',
    '<button class="btn" onclick="goPage(1)"' + (!hasNext ? ' disabled' : '') + '>Next <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="5,2 10,7 5,12"/></svg></button>',
  ].join('');
}

window.goPage = function(delta) {
  currentPage = Math.max(0, currentPage + delta);
  loadArticles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

async function loadArticles() {
  const params = new URLSearchParams({ limit: PAGE_SIZE + 1, offset: currentPage * PAGE_SIZE });
  if (activeArticleTab === 'unread') {
    params.set('read', 'unread');
    params.set('relevance', 'relevant');
  } else {
    params.set('read', document.getElementById('filter-read').value);
    params.set('relevance', document.getElementById('filter-relevance').value);
  }
  try {
    const res = await fetch('/api/articles?' + params);
    const all = await res.json();
    const hasNext = all.length > PAGE_SIZE;
    renderArticles(hasNext ? all.slice(0, PAGE_SIZE) : all);
    renderPagination(hasNext);
  } catch {
    document.getElementById('articles-list').innerHTML = '<div class="empty"><strong>Failed to load articles</strong></div>';
  }
}

document.querySelectorAll('.sub-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeArticleTab = btn.dataset.tab;
    currentPage = 0;
    const onAll = activeArticleTab === 'all';
    const toggleBtn = document.getElementById('filter-toggle-btn');
    toggleBtn.style.display = onAll ? 'flex' : 'none';
    if (!onAll) {
      document.getElementById('all-filters').classList.remove('open');
      toggleBtn.classList.remove('active');
    }
    loadArticles();
  });
});

document.getElementById('filter-toggle-btn').addEventListener('click', () => {
  const panel = document.getElementById('all-filters');
  const btn = document.getElementById('filter-toggle-btn');
  const open = panel.classList.toggle('open');
  btn.classList.toggle('active', open);
});

document.getElementById('filter-read').addEventListener('change', () => { currentPage = 0; loadArticles(); });
document.getElementById('filter-relevance').addEventListener('change', () => { currentPage = 0; loadArticles(); });

// Card kebab menu
function toggleCardMenu(id, e) {
  e.stopPropagation();
  const menu = document.getElementById('card-menu-' + id);
  const isOpen = menu.classList.contains('open');
  document.querySelectorAll('.card-menu-dropdown.open').forEach(m => m.classList.remove('open'));
  if (!isOpen) menu.classList.add('open');
}

function closeCardMenu(id) {
  document.getElementById('card-menu-' + id)?.classList.remove('open');
}

document.addEventListener('click', () => {
  document.querySelectorAll('.card-menu-dropdown.open').forEach(m => m.classList.remove('open'));
});

async function markSeen(id) {
  await fetch(`/api/articles/${id}/seen`, { method: 'POST' });
  updateBadge();
  if (activeArticleTab === 'unread') {
    document.getElementById(`article-${id}`)?.remove();
  } else {
    loadArticles();
  }
}

async function markUnseen(id) {
  await fetch(`/api/articles/${id}/unseen`, { method: 'POST' });
  loadArticles();
  updateBadge();
}

// Dismiss modal
let dismissingArticleId = null;
const dismissModal = document.getElementById('dismiss-modal');

function openDismissModal(id) {
  dismissingArticleId = id;
  document.getElementById('dismiss-reason-input').value = '';
  dismissModal.classList.add('open');
}

document.getElementById('dismiss-cancel-btn').addEventListener('click', () => {
  dismissModal.classList.remove('open');
  dismissingArticleId = null;
});

dismissModal.addEventListener('click', e => { if (e.target === dismissModal) { dismissModal.classList.remove('open'); dismissingArticleId = null; } });

document.getElementById('dismiss-confirm-btn').addEventListener('click', async () => {
  if (!dismissingArticleId) return;
  const reason = document.getElementById('dismiss-reason-input').value.trim();
  await fetch(`/api/articles/${dismissingArticleId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || null }),
  });
  dismissModal.classList.remove('open');
  document.getElementById(`article-${dismissingArticleId}`)?.remove();
  dismissingArticleId = null;
  updateBadge();
});

// Also allow Enter key in reason input
document.getElementById('dismiss-reason-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('dismiss-confirm-btn').click();
});

async function restoreArticle(id) {
  await fetch(`/api/articles/${id}/restore`, { method: 'POST' });
  loadArticles();
  updateBadge();
}

document.getElementById('wipe-articles-btn').addEventListener('click', async () => {
  if (!confirm('Delete all articles? This cannot be undone.')) return;
  await fetch('/api/articles', { method: 'DELETE' });
  loadArticles();
  updateBadge();
});

document.getElementById('wipe-sources-btn').addEventListener('click', async () => {
  if (!confirm('Delete all sources and their articles? This cannot be undone.')) return;
  await fetch('/api/sources', { method: 'DELETE' });
  loadSources();
  updateBadge();
});

document.getElementById('fetch-btn').addEventListener('click', async () => {
  const btn = document.getElementById('fetch-btn');
  btn.disabled = true;

  try {
    await fetch('/api/fetch', { method: 'POST' });
  } catch {
    btn.textContent = 'Fetch now';
    btn.disabled = false;
    return;
  }

  // Poll every 4s until the count stops growing, then stop.
  // Give up after 3 minutes.
  let lastCount = -1;
  let stable = 0;
  const deadline = Date.now() + 3 * 60 * 1000;

  const poll = setInterval(async () => {
    const res = await fetch('/api/articles/unseen-count');
    const { count } = await res.json();
    btn.textContent = `Fetching… (${count} new)`;

    if (count !== lastCount) {
      lastCount = count;
      stable = 0;
      loadArticles();
      updateBadge();
    } else {
      stable++;
    }

    if (stable >= 3 || Date.now() > deadline) {
      clearInterval(poll);
      loadArticles();
      updateBadge();
      btn.textContent = 'Fetch now';
      btn.disabled = false;
    }
  }, 4000);
});

function startFetchPolling() {
  loadSources();
  updateBadge();

  // Poll every 5s for up to 3 minutes, refreshing articles on every tick.
  // AI classification per article takes several seconds, so we keep going
  // until the article count has been stable for 4 consecutive polls.
  let lastCount = -1;
  let stable = 0;
  const deadline = Date.now() + 3 * 60 * 1000;

  const poll = setInterval(async () => {
    try {
      const res = await fetch('/api/articles/unseen-count');
      const { count } = await res.json();
      loadArticles();
      updateBadge();

      if (count === lastCount) { stable++; } else { stable = 0; lastCount = count; }

      if (stable >= 4 || Date.now() > deadline) clearInterval(poll);
    } catch {
      clearInterval(poll);
    }
  }, 5000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const aiAnalysisModal = document.getElementById('ai-analysis-modal');
document.getElementById('close-ai-analysis-btn').addEventListener('click', () => aiAnalysisModal.classList.remove('open'));
aiAnalysisModal.addEventListener('click', e => { if (e.target === aiAnalysisModal) aiAnalysisModal.classList.remove('open'); });

function openAiAnalysis(id, type) {
  const entry = type === 'article'
    ? window._articleAnalysis?.[id]
    : window._sourceAnalysis?.[id];
  if (!entry) return;
  document.getElementById('ai-analysis-title').textContent = 'AI Log — ' + entry.name;
  const body = document.getElementById('ai-analysis-body');
  try {
    const log = JSON.parse(entry.notes);
    body.innerHTML = [
      '<div class="ai-log-step"><strong>Prompt sent</strong><pre>' + escHtml(log.prompt ?? '—') + '</pre></div>',
      '<div class="ai-log-step"><strong>Response</strong><pre>' + escHtml(log.raw_response ?? '—') + '</pre></div>',
    ].join('');
  } catch {
    body.innerHTML = '<pre>' + escHtml(entry.notes) + '</pre>';
  }
  aiAnalysisModal.classList.add('open');
}

// Sources
let loadedSources = [];

async function loadSources() {
  try {
    const res = await fetch('/api/sources');
    const sources = await res.json();
    loadedSources = sources;
    const container = document.getElementById('sources-list');
    if (!sources.length) {
      container.innerHTML = '<div class="empty"><strong>No sources yet</strong><p>Add a source to get started.</p></div>';
      return;
    }
    container.innerHTML = sources.map(s => [
      '<div class="source-card" id="source-' + s.id + '" onclick="handleSourceCardClick(event,' + s.id + ')" style="cursor:pointer' + (s.color ? ';background:' + s.color + ';border-color:' + s.color : '') + '">',
        '<div class="source-info">',
          '<div class="source-name">' + escHtml(s.name ?? s.url) + '</div>',
          '<div class="source-url">' + escHtml(s.url) + ' <span class="source-badge">' + s.fetch_type.toUpperCase() + '</span></div>',
        '</div>',
        '<div class="source-card-actions">',
          s.analysis_notes ? [
            '<div style="position:relative">',
              '<button class="card-icon-btn" title="More options" onclick="event.stopPropagation(); toggleCardMenu(\'s' + s.id + '\', event)"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="2.5" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="7" cy="11.5" r="1.3"/></svg></button>',
              '<div class="card-menu-dropdown" id="card-menu-s' + s.id + '">',
                '<button class="card-menu-item" onclick="closeCardMenu(\'s' + s.id + '\'); openAiAnalysis(' + s.id + ', \'source\')">AI log</button>',
              '</div>',
            '</div>',
          ].join('') : '',
          '<button class="card-icon-btn" title="' + (s.active ? 'Pause' : 'Resume') + '" onclick="event.stopPropagation(); toggleSource(' + s.id + ',' + s.active + ')">'
+ (s.active
  ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="2" width="3.5" height="10" rx="1"/><rect x="8.5" y="2" width="3.5" height="10" rx="1"/></svg>'
  : '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><polygon points="2,1 13,7 2,13"/></svg>')
+ '</button>',
          '<button class="card-icon-btn dismiss" title="Delete" onclick="event.stopPropagation(); deleteSource(' + s.id + ')"><svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/></svg></button>',
        '</div>',
      '</div>',
    ].join('')).join('');

    // Cache analysis notes by source id for the modal
    window._sourceAnalysis = {};
    sources.forEach(s => { if (s.analysis_notes) window._sourceAnalysis[s.id] = { name: s.name ?? s.url, notes: s.analysis_notes }; });
  } catch {}
}

function handleSourceCardClick(e, id) {
  if (e.target.closest('button')) return;
  openEditModal(id);
}

async function toggleSource(id, currentActive) {
  await fetch(`/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !currentActive }),
  });
  loadSources();
}

let deletingSourceId = null;
const deleteSourceModal = document.getElementById('delete-source-modal');

function deleteSource(id) {
  deletingSourceId = id;
  deleteSourceModal.classList.add('open');
}

document.getElementById('delete-source-cancel-btn').addEventListener('click', () => {
  deleteSourceModal.classList.remove('open');
  deletingSourceId = null;
});

deleteSourceModal.addEventListener('click', e => {
  if (e.target === deleteSourceModal) { deleteSourceModal.classList.remove('open'); deletingSourceId = null; }
});

document.getElementById('delete-source-confirm-btn').addEventListener('click', async () => {
  if (!deletingSourceId) return;
  await fetch(`/api/sources/${deletingSourceId}`, { method: 'DELETE' });
  deleteSourceModal.classList.remove('open');
  deletingSourceId = null;
  loadSources();
  updateBadge();
});

// Add source modal
const modal = document.getElementById('add-source-modal');
let lastAnalysis = null;
document.getElementById('add-source-btn').addEventListener('click', () => modal.classList.add('open'));
document.getElementById('cancel-source-btn').addEventListener('click', () => { modal.classList.remove('open'); resetModal(); });

function validateAddSourceForm() {
  const url = document.getElementById('source-url-input').value.trim();
  const type = document.getElementById('source-type-select').value;
  const feedUrl = document.getElementById('source-feed-url-input').value.trim();
  const selector = document.getElementById('source-selector-input').value.trim();
  const errEl = document.getElementById('source-url-error');
  const isDuplicate = url && loadedSources.some(s => s.url === url);
  errEl.textContent = isDuplicate ? 'This source has already been added' : '';
  const ok = url && type && (type === 'rss' ? feedUrl : selector) && !isDuplicate;
  document.getElementById('save-source-btn').disabled = !ok;
}

document.getElementById('source-url-input').addEventListener('input', validateAddSourceForm);
document.getElementById('source-feed-url-input').addEventListener('input', validateAddSourceForm);
document.getElementById('source-selector-input').addEventListener('input', validateAddSourceForm);

document.getElementById('source-type-select').addEventListener('change', (e) => {
  const type = e.target.value;
  const isHtml = type === 'html';
  const isRss = type === 'rss';
  document.getElementById('feed-url-row').style.display = isRss ? '' : 'none';
  document.getElementById('selector-row').style.display = isHtml ? '' : 'none';
  document.getElementById('date-selector-row').style.display = isHtml ? '' : 'none';
  document.getElementById('image-selector-row').style.display = isHtml ? '' : 'none';
  validateAddSourceForm();
});

function resetModal() {
  document.getElementById('source-url-input').value = '';
  document.getElementById('source-name-input').value = '';
  document.getElementById('source-feed-url-input').value = '';
  document.getElementById('source-selector-input').value = '';
  document.getElementById('source-date-selector-input').value = '';
  document.getElementById('source-image-selector-input').value = '';
  document.getElementById('source-max-age-select').value = '1';
  document.getElementById('source-type-select').value = '';
  document.getElementById('feed-url-row').style.display = 'none';
  document.getElementById('selector-row').style.display = 'none';
  document.getElementById('date-selector-row').style.display = 'none';
  document.getElementById('image-selector-row').style.display = 'none';
  document.getElementById('save-source-btn').disabled = true;
  lastAnalysis = null;
  addSourceColor = null;
  renderSwatches('add-color-swatches', null, v => { addSourceColor = v; });
}

document.getElementById('analyze-btn').addEventListener('click', async () => {
  const url = document.getElementById('source-url-input').value.trim();
  if (!url) return;
  const spinner = document.getElementById('analyze-spinner');
  spinner.classList.add('visible');
  try {
    const res = await fetch('/api/sources/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    lastAnalysis = data;

    if (data.name) document.getElementById('source-name-input').value = data.name;
    if (data.has_rss) {
      document.getElementById('source-type-select').value = 'rss';
      document.getElementById('source-feed-url-input').value = data.feed_url ?? '';
      document.getElementById('feed-url-row').style.display = '';
      document.getElementById('selector-row').style.display = 'none';
    } else {
      document.getElementById('source-type-select').value = 'html';
      document.getElementById('source-selector-input').value = data.selector ?? '';
      document.getElementById('source-date-selector-input').value = data.date_selector ?? '';
      document.getElementById('source-image-selector-input').value = data.image_selector ?? '';
      document.getElementById('feed-url-row').style.display = 'none';
      document.getElementById('selector-row').style.display = '';
      document.getElementById('date-selector-row').style.display = '';
      document.getElementById('image-selector-row').style.display = '';
    }
    validateAddSourceForm();
  } catch {
    alert('Failed to analyze URL');
  } finally {
    spinner.classList.remove('visible');
  }
});

document.getElementById('save-source-btn').addEventListener('click', async () => {
  const url = document.getElementById('source-url-input').value.trim();
  const name = document.getElementById('source-name-input').value.trim();
  const fetch_type = document.getElementById('source-type-select').value;
  const feed_url = document.getElementById('source-feed-url-input').value.trim();
  const selector = document.getElementById('source-selector-input').value.trim();
  const date_selector = document.getElementById('source-date-selector-input').value.trim();
  const image_selector = document.getElementById('source-image-selector-input').value.trim();
  const max_age_days = Number(document.getElementById('source-max-age-select').value);
  if (!url) { alert('URL is required'); return; }

  try {
    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name: name || null, fetch_type, feed_url: feed_url || null, selector: selector || null, date_selector: date_selector || null, image_selector: image_selector || null, max_age_days, color: addSourceColor, analysis_notes: lastAnalysis?._log ? JSON.stringify(lastAnalysis._log) : null }),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('source-url-error').textContent = data.error ?? 'Failed to add source';
      return;
    }
    modal.classList.remove('open');
    resetModal();
    loadSources();
    startFetchPolling();
  } catch {
    document.getElementById('source-url-error').textContent = 'Failed to add source';
  }
});

// Edit source modal
let editingSourceId = null;
const editModal = document.getElementById('edit-source-modal');

document.getElementById('edit-source-type').addEventListener('change', (e) => {
  const html = e.target.value === 'html';
  document.getElementById('edit-feed-url-row').style.display = html ? 'none' : '';
  document.getElementById('edit-selector-row').style.display = html ? '' : 'none';
  document.getElementById('edit-date-selector-row').style.display = html ? '' : 'none';
  document.getElementById('edit-image-selector-row').style.display = html ? '' : 'none';
});

async function openEditModal(id) {
  const res = await fetch('/api/sources');
  const sources = await res.json();
  const s = sources.find(x => x.id === id);
  if (!s) return;
  editingSourceId = id;
  document.getElementById('edit-source-name').value = s.name ?? '';
  document.getElementById('edit-source-type').value = s.fetch_type;
  document.getElementById('edit-source-feed-url').value = s.feed_url ?? '';
  document.getElementById('edit-source-selector').value = s.selector ?? '';
  document.getElementById('edit-source-date-selector').value = s.date_selector ?? '';
  document.getElementById('edit-source-image-selector').value = s.image_selector ?? '';
  document.getElementById('edit-source-max-age').value = String(s.max_age_days ?? 1);
  editSourceColor = s.color ?? null;
  renderSwatches('edit-color-swatches', editSourceColor, v => { editSourceColor = v; });
  const html = s.fetch_type === 'html';
  document.getElementById('edit-feed-url-row').style.display = html ? 'none' : '';
  document.getElementById('edit-selector-row').style.display = html ? '' : 'none';
  document.getElementById('edit-date-selector-row').style.display = html ? '' : 'none';
  document.getElementById('edit-image-selector-row').style.display = html ? '' : 'none';
  editModal.classList.add('open');
}

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  editModal.classList.remove('open');
  editingSourceId = null;
});

document.getElementById('save-edit-btn').addEventListener('click', async () => {
  const name = document.getElementById('edit-source-name').value.trim();
  const fetch_type = document.getElementById('edit-source-type').value;
  const feed_url = document.getElementById('edit-source-feed-url').value.trim();
  const selector = document.getElementById('edit-source-selector').value.trim();
  const date_selector = document.getElementById('edit-source-date-selector').value.trim();
  const image_selector = document.getElementById('edit-source-image-selector').value.trim();
  const max_age_days = Number(document.getElementById('edit-source-max-age').value);
  try {
    const res = await fetch(`/api/sources/${editingSourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || null, fetch_type, feed_url: feed_url || null, selector: selector || null, date_selector: date_selector || null, image_selector: image_selector || null, max_age_days, color: editSourceColor }),
    });
    if (!res.ok) throw new Error();
    editModal.classList.remove('open');
    editingSourceId = null;
    loadSources();
    loadArticles();
  } catch {
    alert('Failed to save source');
  }
});

// Color palette
const SOURCE_COLORS = [
  { value: '#ede9e3', label: 'Stone' },
  { value: '#dedad4', label: 'Pebble' },
  { value: '#ccc8c2', label: 'Slate' },
  { value: '#b8b4ae', label: 'Ash' },
  { value: '#fdf6e3', label: 'Sand' },
  { value: '#fde8d8', label: 'Peach' },
  { value: '#fad4c0', label: 'Apricot' },
  { value: '#fce4ec', label: 'Rose' },
  { value: '#f8d0dc', label: 'Blush' },
  { value: '#f3e5f5', label: 'Lavender' },
  { value: '#e8eaf6', label: 'Indigo' },
  { value: '#dce3f8', label: 'Periwinkle' },
  { value: '#e3f2fd', label: 'Sky' },
  { value: '#e0f7fa', label: 'Cyan' },
  { value: '#e8f5e9', label: 'Mint' },
  { value: '#d6eedd', label: 'Sage' },
  { value: '#f1f8e9', label: 'Lime' },
  { value: '#fffde7', label: 'Lemon' },
  { value: '#fff8e1', label: 'Cream' },
];

function renderSwatches(containerId, selectedColor, onSelect) {
  const container = document.getElementById(containerId);
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'color-swatch none' + (!selectedColor ? ' selected' : '');
  none.title = 'No color';
  none.addEventListener('click', () => { onSelect(null); renderSwatches(containerId, null, onSelect); });
  container.innerHTML = '';
  container.appendChild(none);
  SOURCE_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch' + (selectedColor === c.value ? ' selected' : '');
    btn.style.background = c.value;
    btn.title = c.label;
    btn.addEventListener('click', () => { onSelect(c.value); renderSwatches(containerId, c.value, onSelect); });
    container.appendChild(btn);
  });
}

let addSourceColor = null;
let editSourceColor = null;

renderSwatches('add-color-swatches', null, v => { addSourceColor = v; });
renderSwatches('edit-color-swatches', null, v => { editSourceColor = v; });

// ── Auth ──────────────────────────────────────────────────────────────────────

let currentUser = null;

function showAuthForm(which) {
  ['login', 'signup', 'pending', 'blocked'].forEach(f => {
    document.getElementById('auth-' + f + '-form').style.display = f === which ? '' : 'none';
  });
}

function showAuthOverlay(form = 'login') {
  showAuthForm(form);
  document.getElementById('auth-overlay').style.display = 'flex';
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none';
}

function applyUserRole(user) {
  currentUser = user;
  document.getElementById('header-username').textContent = user.username;
  document.getElementById('header-user').style.display = 'flex';
  if (user.role === 'admin') {
    document.getElementById('admin-nav-btn').style.display = '';
  }
}

async function initAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const { user } = await res.json();
    if (!user) { showAuthOverlay('login'); return; }
    if (user.blocked) { showAuthOverlay('blocked'); return; }
    if (!user.approved) { showAuthOverlay('pending'); return; }
    applyUserRole(user);
    hideAuthOverlay();
    loadArticles();
    updateBadge();
    setInterval(updateBadge, 5 * 60 * 1000);
  } catch { showAuthOverlay('login'); }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  err.textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'Account has been blocked') { showAuthForm('blocked'); return; }
      err.textContent = data.error;
      return;
    }
    applyUserRole(data.user);
    hideAuthOverlay();
    loadArticles();
    updateBadge();
    setInterval(updateBadge, 5 * 60 * 1000);
  } catch { err.textContent = 'Login failed. Try again.'; }
});

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('signup-btn').addEventListener('click', async () => {
  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const err = document.getElementById('signup-error');
  err.textContent = '';
  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error; return; }
    if (data.pending) { showAuthForm('pending'); return; }
    applyUserRole(data.user);
    hideAuthOverlay();
    loadArticles();
    updateBadge();
    setInterval(updateBadge, 5 * 60 * 1000);
  } catch { err.textContent = 'Signup failed. Try again.'; }
});

document.getElementById('signup-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('signup-btn').click();
});

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  document.getElementById('header-user').style.display = 'none';
  document.getElementById('admin-nav-btn').style.display = 'none';
  showAuthOverlay('login');
}

document.getElementById('logout-btn').addEventListener('click', doLogout);

// ── Admin panel ───────────────────────────────────────────────────────────────

document.querySelectorAll('[data-admin-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.adminTab;
    document.getElementById('admin-tab-management').style.display = tab === 'management' ? '' : 'none';
    document.getElementById('admin-tab-database').style.display = tab === 'database' ? '' : 'none';
    if (tab === 'database') loadAdminDatabase();
  });
});

async function loadAdminDatabase() {
  try {
    const [usersRes, sourcesRes, articlesRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/admin/sources'),
      fetch('/api/admin/articles'),
    ]);
    const [users, sources, articles] = await Promise.all([usersRes.json(), sourcesRes.json(), articlesRes.json()]);

    document.getElementById('db-users-count').textContent = '(' + users.length + ')';
    document.querySelector('#db-users-table tbody').innerHTML = users.map(u => {
      const status = u.blocked ? 'blocked' : u.approved ? 'approved' : 'pending';
      return '<tr><td>' + u.id + '</td><td>' + escHtml(u.username) + '</td><td>' + escHtml(u.role) + '</td><td>' + status + '</td><td>' + formatDate(u.created_at) + '</td></tr>';
    }).join('');

    document.getElementById('db-sources-count').textContent = '(' + sources.length + ')';
    document.querySelector('#db-sources-table tbody').innerHTML = sources.map(s =>
      '<tr><td>' + s.id + '</td><td>' + escHtml(s.username ?? '—') + '</td><td>' + escHtml(s.name ?? '—') + '</td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + escHtml(s.url) + '" target="_blank" rel="noopener">' + escHtml(s.url) + '</a></td>' +
      '<td>' + escHtml(s.fetch_type) + '</td><td>' + (s.active ? 'yes' : 'no') + '</td><td>' + formatDate(s.created_at) + '</td></tr>'
    ).join('');

    document.getElementById('db-articles-count').textContent = '(' + articles.length + (articles.length === 100 ? ', showing latest 100' : '') + ')';
    document.querySelector('#db-articles-table tbody').innerHTML = articles.map(a =>
      '<tr><td>' + a.id + '</td><td>' + escHtml(a.username ?? '—') + '</td><td>' + escHtml(a.source_name ?? '—') + '</td>' +
      '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="' + escHtml(a.url) + '" target="_blank" rel="noopener">' + escHtml(a.title ?? a.url) + '</a></td>' +
      '<td>' + (a.is_relevant ? 'yes' : 'no') + '</td><td>' + (a.seen ? 'yes' : 'no') + '</td><td>' + formatDate(a.fetched_at) + '</td></tr>'
    ).join('');
  } catch {}
}

async function loadAdminPanel() {
  // Settings
  try {
    const res = await fetch('/api/admin/settings');
    const { auto_approve } = await res.json();
    document.getElementById('auto-approve-toggle').checked = auto_approve;
  } catch {}

  // Users
  try {
    const res = await fetch('/api/admin/users');
    const users = await res.json();
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = users.map(u => {
      const isSelf = u.id === currentUser.id;
      const status = u.blocked ? 'blocked' : u.approved ? 'approved' : 'pending';
      const statusEl = '<span style="color:var(--muted)">' + status + '</span>';
      const roleEl = isSelf
        ? '<span style="color:var(--muted)">' + u.role + '</span>'
        : '<select onchange="updateUserRole(' + u.id + ', this.value)">'
            + '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>user</option>'
            + '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>'
            + '</select>';
      let actions = '';
      if (!isSelf) {
        if (!u.approved && !u.blocked) actions += '<button class="btn" onclick="approveUser(' + u.id + ')">Approve</button> ';
        if (!u.blocked) actions += '<button class="btn" style="color:var(--accent)" onclick="blockUser(' + u.id + ')">Block</button>';
        if (u.blocked)  actions += '<button class="btn" onclick="unblockUser(' + u.id + ')">Unblock</button>';
      }
      return '<tr><td>' + escHtml(u.username) + '</td><td>' + roleEl + '</td><td>' + statusEl + '</td><td>' + actions + '</td></tr>';
    }).join('');
  } catch {}
}

document.getElementById('auto-approve-toggle').addEventListener('change', async (e) => {
  await fetch('/api/admin/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto_approve: e.target.checked }),
  });
});

async function approveUser(id) {
  await fetch('/api/admin/users/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true, blocked: false }),
  });
  loadAdminPanel();
}

async function blockUser(id) {
  await fetch('/api/admin/users/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: true }),
  });
  loadAdminPanel();
}

async function unblockUser(id) {
  await fetch('/api/admin/users/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: false, approved: true }),
  });
  loadAdminPanel();
}

async function updateUserRole(id, role) {
  await fetch('/api/admin/users/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

// Init
initAuth();
