/**
 * 求职进度助手 - 应用逻辑
 * 设计约定：
 *   1. 所有 Modal 结构：Header / Scrollable Body / Fixed Footer
 *   2. 岗位字段由「当前状态」驱动动态显示
 *   3. 面试信息只在岗位中录入一次，面试页读取同一份数据
 *   4. 旧字段 (nextAction / nextActionDate / interviews) 读取时忽略，保留不删
 */

// ============================================
// 常量配置
// ============================================
const STORAGE_KEY = 'jobTrackerData';
const RESUME_KEY  = 'jobTrackerResumes';
const DB_NAME = 'JobTrackerDB';
const DB_VERSION = 1;
const RESUME_STORE = 'resumes';

const STATUS_ORDER = ['收藏','已投递','笔试/测评','一面','二面','终面','Offer','已拒绝','已结束'];
const INTERVIEW_STATUSES = ['一面','二面','终面'];
const ACTIVE_STATUSES = ['收藏','已投递','笔试/测评','一面','二面','终面','Offer'];
const RESUME_CATEGORIES = ['数据分析','商业分析','产品','运营','金融','咨询','技术','其他'];
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

// 状态 → badge
const STATUS_BADGE = (s) => `<span class="status-tag status-${s}">${s}</span>`;

// ============================================
// IndexedDB（简历文件）
// ============================================
let db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('浏览器不支持 IndexedDB')); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(RESUME_STORE)) {
                database.createObjectStore(RESUME_STORE, { keyPath: 'id' });
            }
        };
    });
}

function saveResumeFile(resumeId, file) {
    return new Promise((resolve, reject) => {
        if (!db) { reject(new Error('数据库未就绪')); return; }
        const tx = db.transaction([RESUME_STORE], 'readwrite');
        tx.objectStore(RESUME_STORE).put({ id: resumeId, fileName: file.name, fileType: file.type, fileSize: file.size, blob: file });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
}

function getResumeFile(resumeId) {
    return new Promise((resolve, reject) => {
        if (!db) { reject(new Error('数据库未就绪')); return; }
        const tx = db.transaction([RESUME_STORE], 'readonly');
        const req = tx.objectStore(RESUME_STORE).get(resumeId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

function deleteResumeFile(resumeId) {
    return new Promise(resolve => {
        if (!db) { resolve(); return; }
        const tx = db.transaction([RESUME_STORE], 'readwrite');
        tx.objectStore(RESUME_STORE).delete(resumeId);
        tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
    });
}

function clearResumeFiles() {
    return new Promise(resolve => {
        if (!db) { resolve(); return; }
        const tx = db.transaction([RESUME_STORE], 'readwrite');
        tx.objectStore(RESUME_STORE).clear();
        tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
    });
}

// ============================================
// 数据读写
// ============================================
function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try { const p = JSON.parse(raw); return p ?? fallback; }
    catch (e) { console.warn('数据解析失败，已使用默认值', e); return fallback; }
}

function getData() {
    const d = safeParse(localStorage.getItem(STORAGE_KEY), null);
    return (d && Array.isArray(d.jobs)) ? { ...d, jobs: d.jobs.map(normalizeJobHistory) } : { jobs: [] };
}

function saveData(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

function getResumes() {
    const list = safeParse(localStorage.getItem(RESUME_KEY), []);
    return Array.isArray(list) ? list : [];
}

function saveResumes(list) { localStorage.setItem(RESUME_KEY, JSON.stringify(list)); }

function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function getCurrentDate() {
    const d = new Date(), p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function nowISO() { return new Date().toISOString(); }

// Interview history is additive; the current interview remains a compatibility mirror.
function hasInterviewInfo(iv) {
    return !!(iv && (iv.date || iv.mode || iv.note || (iv.review && Object.values(iv.review).some(Boolean))));
}

function normalizeJobHistory(source) {
    const job = { ...source };
    const history = [];
    const mergeRecord = record => {
        if (!record || typeof record !== 'object') return;
        const stage = record.stage || '面试';
        const existing = history.find(iv => iv.stage === stage);
        const entry = {
            ...record, id: record.id || `${job.id}-interview-${stage}`,
            stage, date: record.date || '', mode: record.mode || '', note: record.note || '',
            review: record.review || null, createdAt: record.createdAt || job.createdAt || ''
        };
        if (existing) Object.assign(existing, entry, { id: existing.id, createdAt: existing.createdAt || entry.createdAt, review: entry.review || existing.review });
        else history.push(entry);
    };
    if (Array.isArray(job.interviewHistory)) job.interviewHistory.forEach(mergeRecord);
    const legacy = hasInterviewInfo(job.interview) ? job.interview : (job.interviewDate ? {
        date: job.interviewDate, mode: job.interviewMode || '', note: job.interviewNote || ''
    } : job.interview || null);
    if (hasInterviewInfo(legacy)) {
        // After Offer/closure, an unlabelled legacy interview keeps an unknown round.
        const stage = legacy.stage || (INTERVIEW_STATUSES.includes(job.status) ? job.status : '面试');
        if (!history.some(iv => iv.stage === stage)) mergeRecord({ ...legacy, stage });
    }
    job.interviewHistory = history;
    const current = history.find(iv => iv.stage === job.status);
    if (INTERVIEW_STATUSES.includes(job.status) && current) job.interview = { ...current };
    else if (legacy) job.interview = { ...legacy, stage: legacy.stage || (INTERVIEW_STATUSES.includes(job.status) ? job.status : '面试') };
    const offerInfo = job.offer && (job.offer.date || job.offer.replyDeadline || job.offer.salary);
    job.hasOffer = job.hasOffer === true || job.status === 'Offer' || !!offerInfo;
    job.hasApplied = job.hasApplied === true || !!job.applicationDate ||
        ['已投递', '笔试/测评', ...INTERVIEW_STATUSES, 'Offer'].includes(job.status) ||
        history.length > 0 || job.hasOffer || !!(job.assessment && (job.assessment.date || job.assessment.type));
    return job;
}

function upsertInterview(job, stage, info, recordId) {
    if (!Array.isArray(job.interviewHistory)) job.interviewHistory = [];
    const existing = (recordId && job.interviewHistory.find(iv => iv.id === recordId)) || job.interviewHistory.find(iv => iv.stage === stage);
    const entry = {
        date: '', mode: '', note: '', review: null,
        ...(existing || {}), ...info,
        id: existing ? existing.id : generateId(), stage,
        createdAt: existing ? existing.createdAt : nowISO()
    };
    if (existing) Object.assign(existing, entry);
    else job.interviewHistory.push(entry);
    job.hasApplied = true;
    if (stage === job.status || (job.interview && job.interview.stage === stage)) job.interview = { ...entry };
    return entry;
}

function syncJobMilestones(job) {
    if (['已投递', '笔试/测评', ...INTERVIEW_STATUSES, 'Offer'].includes(job.status) || job.applicationDate) job.hasApplied = true;
    if (job.status === 'Offer') { job.hasOffer = true; job.hasApplied = true; }
}

// ============================================
// 格式化工具
// ============================================
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth()+1}月${d.getDate()}日`;
}

function formatDateTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2,'0');
    return `${d.getMonth()+1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFileSize(bytes) {
    if (!bytes || bytes < 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function toDateOnly(value) { return value ? String(value).slice(0,10) : ''; }

function daysDiff(dateStr) {
    if (!dateStr) return Infinity;
    const target = new Date(toDateOnly(dateStr));
    if (isNaN(target.getTime())) return Infinity;
    const today = new Date(); today.setHours(0,0,0,0);
    target.setHours(0,0,0,0);
    return Math.round((target - today) / 86400000);
}

function relativeTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    const diff = daysDiff(toDateOnly(isoStr));
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff === -1) return '昨天';
    if (diff > 0) return `${diff} 天后`;
    return `${Math.abs(diff)} 天前`;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================
// Modal 基础设施
// ============================================
let activeModalId = null;

function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (!el) return;
    el.classList.remove('hidden');
    activeModalId = modalId;
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('hidden');
    if (activeModalId === modalId) activeModalId = null;
    if (!document.querySelector('.modal-overlay:not(.hidden)')) document.body.style.overflow = '';
}

// ============================================
// 页面导航
// ============================================
const RENDERERS = {};

function navigateTo(page) {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('hidden', p.id !== `page-${page}`);
    });
    if (typeof RENDERERS[page] === 'function') RENDERERS[page]();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => { e.preventDefault(); navigateTo(item.dataset.page); });
    });
    RENDERERS.dashboard = renderDashboard;
    RENDERERS.jobs = renderJobs;
    RENDERERS.schedule = renderSchedule;
    RENDERERS.interviews = renderInterviews;
    RENDERERS.resumes = renderResumes;
    RENDERERS.settings = () => {};
}

// ============================================
// Dashboard
// ============================================
function renderDashboard() {
    const jobs = getData().jobs;
    const total = jobs.length;
    const applied = jobs.filter(j => j.hasApplied === true).length;
    const interview = jobs.reduce((total, job) => total + job.interviewHistory.length, 0);
    const offer = jobs.filter(j => j.hasOffer === true).length;

    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-applied').textContent = applied;
    document.getElementById('stat-interview').textContent = interview;
    document.getElementById('stat-offer').textContent = offer;

    renderDashboardTodos(jobs);
    renderProgressOverview(jobs);
}

function collectScheduleItems(job) {
    const items = [];
    if (job.deadline) items.push({ date: job.deadline, label: '网申截止', badge: job.status, secondary: '网申截止', job });
    if (job.assessment && job.assessment.date) items.push({ date: job.assessment.date, label: '笔试/测评' + (job.assessment.type ? ` · ${job.assessment.type}` : ''), badge: '笔试/测评', secondary: job.assessment.type || '', job });
    if (job.interview && job.interview.date) items.push({ date: job.interview.date, label: `${job.status} · ${job.interview.mode || ''} ${job.interview.note || ''}`.trim(), badge: job.interview.stage || job.status, secondary: job.interview.mode || '', job });
    if (job.offer && job.offer.replyDeadline) items.push({ date: job.offer.replyDeadline, label: 'Offer 回复截止', badge: 'Offer', secondary: '回复截止', job });
    // 旧数据兼容
    if (job.nextActionDate) items.push({ date: job.nextActionDate, label: job.nextAction || '下一步', badge: job.status, secondary: job.nextAction || '', job });
    return items;
}

function dashboardEventSecondary(item) {
    let text = item.secondary || '';
    const stage = item.badge || item.job.status;
    if (stage) text = text.split(stage).join('');
    text = text.replace(/^[\s·/]+|[\s·/]+$/g, '').trim();
    const date = new Date(item.date);
    const time = /T\d{2}:\d{2}/.test(item.date) && !isNaN(date.getTime())
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
    return [text, time].filter(Boolean).join(' · ');
}

function renderDashboardTodos(jobs) {
    const container = document.getElementById('dashboard-todos');
    let items = [];
    jobs.forEach(job => { items = items.concat(collectScheduleItems(job)); });
    items = items.filter(i => i.date && !isNaN(new Date(i.date).getTime()))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (items.length === 0) {
        container.innerHTML = `
            <div class="empty-inline">
                <div class="empty-inline-art">${ART.coffeePlant}</div>
                <p>暂时没有待办事项，可以稍微放松一下。</p>
            </div>`;
        return;
    }

    container.innerHTML = items.slice(0, 6).map(item => {
        const secondary = dashboardEventSecondary(item);
        const diff = daysDiff(item.date);
        const overdue = diff < 0;
        const d = new Date(item.date);
        const dayText = isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}月${d.getDate()}日`;
        const subText = overdue ? '已完成'
            : diff === 0 ? '今天'
            : diff === 1 ? '明天'
            : `${diff} 天后`;

        return `
            <div class="todo-item ${overdue ? 'overdue' : ''}" data-job="${escapeHtml(item.job.id)}">
                <div class="todo-date-col">
                    <span class="todo-date">${dayText}</span>
                    <span class="todo-date-sub">${subText}</span>
                </div>
                <div class="todo-main">
                    <span class="todo-company">${escapeHtml(item.job.company)}</span>
                    <span class="todo-role">${escapeHtml(item.job.role)}</span>
                </div>
                <div class="todo-aside">
                    ${STATUS_BADGE(item.badge || item.job.status)}
                    ${secondary ? `<span class="todo-action" title="${escapeHtml(secondary)}">${escapeHtml(secondary)}</span>` : ''}
                </div>
            </div>`;
    }).join('');
}

function renderProgressOverview(jobs) {
    const container = document.getElementById('progress-overview');
    const count = s => jobs.filter(j => j.status === s).length;

    const stages = [
        { name: '收藏', value: count('收藏') },
        { name: '已投递', value: count('已投递') },
        { name: '笔试', value: count('笔试/测评') },
        { name: '面试', value: count('一面') + count('二面') + count('终面') },
        { name: 'Offer', value: count('Offer') }
    ];

    // 找到最后一个有数据的阶段，作为「当前」
    let currentIdx = -1;
    stages.forEach((s, i) => { if (s.value > 0) currentIdx = i; });

    const ended = count('已结束');
    const rejected = count('已拒绝');

    container.innerHTML = stages.map((s, i) => {
        const cls = i === currentIdx ? 'is-current' : (s.value > 0 ? 'is-filled' : '');
        return `
            <div class="pipe-stage ${cls}">
                <span class="pipe-dot"></span>
                <span class="pipe-text">
                    <span class="pipe-name">${s.name}</span>
                    <span class="pipe-count">${s.value}</span>
                </span>
            </div>`;
    }).join('') + `
        <div class="pipe-aside">
            <span>已结束 <b>${ended}</b></span>
            <span>已拒绝 <b>${rejected}</b></span>
        </div>`;
}

// ============================================
// 岗位列表
// ============================================
let currentSearch = '';
let currentStatusFilter = '';
let currentCityFilter = '';
let currentFavoriteOnly = false;

// Missing favorite fields in existing records are treated as false.
const FAVORITE_HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 00-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 00-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 000-7.6z"/></svg>';

function favoriteButton(job) {
    const favorite = job.favorite === true;
    const label = favorite ? '取消收藏' : '收藏岗位';
    return `<button type="button" class="favorite-btn${favorite ? ' is-favorite' : ''}" data-action="favorite" data-id="${escapeHtml(job.id)}" aria-pressed="${favorite}" aria-label="${label}" title="${label}">${FAVORITE_HEART}</button>`;
}

function toggleFavorite(jobId) {
    const data = getData();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;
    job.favorite = job.favorite !== true;
    saveData(data);
    renderJobs();
}

function renderJobs() {
    const allJobs = getData().jobs;
    updateCityOptions(allJobs);

    let jobs = allJobs.slice();
    if (currentSearch) {
        const q = currentSearch.trim().toLowerCase();
        if (q) jobs = jobs.filter(j => (j.company||'').toLowerCase().includes(q) || (j.role||'').toLowerCase().includes(q));
    }
    if (currentStatusFilter) {
        jobs = jobs.filter(j => currentStatusFilter === '面试' ? INTERVIEW_STATUSES.includes(j.status) : j.status === currentStatusFilter);
    }
    if (currentCityFilter) jobs = jobs.filter(j => j.city === currentCityFilter);
    if (currentFavoriteOnly) jobs = jobs.filter(j => j.favorite === true);
    jobs.sort((a, b) => String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));

    const container = document.getElementById('jobs-list');

    if (allJobs.length === 0) {
        container.innerHTML = emptyBlock(ART.listArrow, '还没有岗位记录', '添加你的第一个岗位，开始整理求职进度。',
            `<button class="btn btn-primary btn-sm" data-action="add-job">+ 添加岗位</button>`);
        return;
    }

    if (jobs.length === 0) {
        container.innerHTML = emptyBlock(ART.searchEmpty, '没有找到匹配的岗位', '尝试调整搜索或筛选条件', '');
        return;
    }

    container.innerHTML = `
        <div class="jobs-table-wrap">
            <table class="jobs-table">
                <thead>
                    <tr>
                        <th>公司</th>
                        <th>岗位</th>
                        <th>状态</th>
                        <th>城市</th>
                        <th>截止日期</th>
                        <th>简历</th>
                        <th>更新时间</th>
                        <th class="cell-mobile-meta"></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${jobs.map(job => {
                        const resume = job.resumeId ? getResumes().find(r => r.id === job.resumeId) : null;
                        const overdue = job.deadline && daysDiff(job.deadline) < 0;
                        const deadline = job.deadline ? formatDate(job.deadline) : '—';
                        const updatedAt = job.updatedAt ? relativeTime(job.updatedAt) : '—';
                        return `
                            <tr data-job="${escapeHtml(job.id)}">
                                <td><span class="table-company">${escapeHtml(job.company)}</span></td>
                                <td><span class="table-role">${escapeHtml(job.role)}</span></td>
                                <td>${STATUS_BADGE(job.status)}</td>
                                <td><span class="cell-muted">${escapeHtml(job.city || '—')}</span></td>
                                <td><span class="cell-sm${overdue ? ' is-overdue' : ''}">${deadline}</span></td>
                                <td><span class="cell-muted">${resume ? escapeHtml(resume.name) : '—'}</span></td>
                                <td><span class="cell-dim">${updatedAt}</span></td>
                                <td class="cell-mobile-meta">
                                    <span class="cell-muted">${escapeHtml(job.city || '未填写城市')}</span>
                                    <span class="cell-dot">·</span>
                                    <span class="cell-sm${overdue ? ' is-overdue' : ''}">${job.deadline ? '截止 ' + deadline : '未设截止'}</span>
                                </td>
                                <td>
                                    <div class="table-action">
                                        ${favoriteButton(job)}
                                        <button class="btn btn-text btn-sm" data-action="detail" data-id="${escapeHtml(job.id)}">查看</button>
                                        <button class="btn btn-text btn-sm" data-action="edit" data-id="${escapeHtml(job.id)}">编辑</button>
                                        ${ACTIVE_STATUSES.includes(job.status) && job.status !== 'Offer' ? `<button class="btn btn-secondary btn-sm" data-action="advance" data-id="${escapeHtml(job.id)}">下一阶段</button>` : ''}
                                        <button class="table-more-btn" data-id="${escapeHtml(job.id)}" title="更多操作">
                                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                                                <circle cx="7" cy="3" r="0.8" fill="currentColor" stroke="none"/>
                                                <circle cx="7" cy="7" r="0.8" fill="currentColor" stroke="none"/>
                                                <circle cx="7" cy="11" r="0.8" fill="currentColor" stroke="none"/>
                                            </svg>
                                        </button>
                                    </div>
                                </td>
                            </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;
}

/* ============================================
   Line-art illustrations
   One visual language: uniform --stroke,
   --ink line color, 1–2 pastel fills.
   ============================================ */
const ART = {
    // 面试空状态 — 椅子 + 日历
    chairCalendar: `
        <svg class="lineart empty-art" viewBox="0 0 116 96" role="img" aria-label="椅子与日历简笔画">
            <path class="ln-thin" d="M8 88h100"/>
            <path class="ln" d="M30 52V40c0-3 2-5 5-5h12c3 0 5 2 5 5v12"/>
            <path class="ln" d="M26 88V64c0-3 2-5 5-5h20c3 0 5 2 5 5v24"/>
            <path class="ln f-lav" d="M74 22h34a3 3 0 013 3v40H71V25a3 3 0 013-3z"/>
            <path class="ln" d="M71 36h40"/>
            <path class="ln" d="M81 22v-4M100 22v-4"/>
            <path class="ln" d="M80 44h6M92 44h6M80 54h6"/>
            <path class="ln-thin" d="M100 46l1.1 2.9 2.9 1.1-2.9 1.1L100 54l-1.1-2.9L96 50l2.9-1.1L100 46z"/>
        </svg>`,

    // 简历空状态 — 文件夹 + 纸张
    folderPaper: `
        <svg class="lineart empty-art" viewBox="0 0 116 96" role="img" aria-label="文件夹与纸张简笔画">
            <path class="ln-thin" d="M8 88h100"/>
            <path class="ln f-sage" d="M18 34a3 3 0 013-3h24l8 9h42a3 3 0 013 3v33H18z"/>
            <path class="ln" d="M32 52h50M32 60h38M32 68h44"/>
            <path class="ln" d="M62 20h24l10 10v18"/>
            <path class="ln" d="M62 20v12h12"/>
            <path class="ln-thin" d="M36 16l1.2 3.2 3.2 1.2-3.2 1.2L36 25l-1.2-3.2-3.2-1.2 3.2-1.2L36 16z"/>
        </svg>`,

    // 岗位空状态 — 简笔清单 + 箭头
    listArrow: `
        <svg class="lineart empty-art" viewBox="0 0 116 96" role="img" aria-label="清单与箭头简笔画">
            <path class="ln-thin" d="M8 88h100"/>
            <path class="ln f-lav" d="M22 20h50a3 3 0 013 3v54H22z"/>
            <path class="ln" d="M32 34h32M32 44h26M32 54h30"/>
            <path class="ln" d="M86 44h10M92 40l4 4-4 4"/>
            <path class="ln-thin" d="M92 18l1.2 3.2 3.2 1.2-3.2 1.2L92 27l-1.2-3.2-3.2-1.2 3.2-1.2L92 18z"/>
        </svg>`,

    // 日程空状态 — 日历 + 咖啡
    calendarCoffee: `
        <svg class="lineart empty-art" viewBox="0 0 116 96" role="img" aria-label="日历与咖啡杯简笔画">
            <path class="ln-thin" d="M8 88h100"/>
            <path class="ln f-butter" d="M18 24h52a3 3 0 013 3v44H18z"/>
            <path class="ln" d="M18 36h55M31 24v-5M56 24v-5"/>
            <path class="ln" d="M28 46h6M41 46h6M28 57h6M41 57h6"/>
            <path class="ln f-blush" d="M80 48h20v20a6 6 0 01-6 6h-8a6 6 0 01-6-6V48z"/>
            <path class="ln" d="M100 54h5a4 4 0 010 8h-5"/>
            <path class="ln-thin" d="M86 42c1.4-2.4 1.4-4.8 0-7.2M94 42c1.4-2.4 1.4-4.8 0-7.2"/>
        </svg>`,

    // 搜索无结果 — 放大镜
    searchEmpty: `
        <svg class="lineart empty-art" viewBox="0 0 116 96" role="img" aria-label="放大镜简笔画">
            <path class="ln-thin" d="M8 88h100"/>
            <circle class="ln f-lav" cx="52" cy="42" r="20"/>
            <path class="ln" d="M67 57l18 18"/>
            <path class="ln-thin" d="M44 42h16M52 34v16"/>
        </svg>`,

    // 接下来空状态 — 咖啡 + 小植物
    coffeePlant: `
        <svg class="lineart empty-art" viewBox="0 0 150 84" role="img" aria-label="咖啡杯与小植物简笔画">
            <path class="ln-thin" d="M8 76h134"/>
            <path class="ln f-blush" d="M34 40h34v22a8 8 0 01-8 8H42a8 8 0 01-8-8V40z"/>
            <path class="ln" d="M68 47h7a5 5 0 010 10h-7"/>
            <path class="ln-thin" d="M46 32c1.8-3 1.8-6 0-9M58 32c1.8-3 1.8-6 0-9"/>
            <path class="ln" d="M100 76V56"/>
            <path class="ln f-sage" d="M100 58c-8 0-13-5-13-11 7 0 13 4 13 11zM100 58c8 0 13-5 13-11-7 0-13 4-13 11z"/>
            <path class="ln" d="M92 76h16l-2 6H94l-2-6z"/>
        </svg>`
};

function emptyBlock(artSvg, title, desc, actionHtml) {
    return `
        <div class="empty-block">
            ${artSvg}
            <h4>${title}</h4>
            <p>${desc}</p>
            ${actionHtml || ''}
        </div>`;
}

function updateCityOptions(jobs) {
    const select = document.getElementById('filter-city');
    const cities = [...new Set(jobs.map(j => j.city).filter(Boolean))].sort();
    const current = currentCityFilter;
    select.innerHTML = '<option value="">全部城市</option>' + cities.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (current && cities.includes(current)) select.value = current;
    else currentCityFilter = '';
}

// ============================================
// 岗位表单：状态驱动
// ============================================
let editingJobId = null;
let submitting = false;

function onStatusChange() {
    const status = document.getElementById('status').value;
    applyStatusBlocks(status);
    if (editingJobId && INTERVIEW_STATUSES.includes(status)) {
        const job = getData().jobs.find(j => j.id === editingJobId);
        const iv = job ? job.interviewHistory.find(record => record.stage === status) || {} : {};
        document.getElementById('interviewDate').value = iv.date || '';
        document.getElementById('interviewMode').value = iv.mode || '';
        document.getElementById('interviewNote').value = iv.note || '';
    }
}

function applyStatusBlocks(status) {
    const showAssessment = status === '笔试/测评';
    const showInterview = INTERVIEW_STATUSES.includes(status);
    const showOffer = status === 'Offer';
    toggleBlock('block-assessment', showAssessment);
    toggleBlock('block-interview', showInterview);
    toggleBlock('block-offer', showOffer);
    if (showInterview) document.getElementById('interviewBlockTitle').textContent = `${status}安排`;
}

function toggleBlock(id, show) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !show);
}

function openAddModal() {
    editingJobId = null; submitting = false;
    document.getElementById('modal-title').textContent = '添加岗位';
    document.getElementById('job-submit-btn').textContent = '保存';
    document.getElementById('job-form').reset();
    applyStatusBlocks('已投递');
    setCollapse('more-info', 'collapse-arrow', false);
    updateResumeSelect();
    openModal('job-modal');
}

function openEditModal(jobId) {
    const job = getData().jobs.find(j => j.id === jobId);
    if (!job) return;
    const currentRound = job.interviewHistory.find(iv => iv.stage === job.status) || {};
    editingJobId = jobId; submitting = false;
    document.getElementById('modal-title').textContent = '编辑岗位';
    document.getElementById('job-submit-btn').textContent = '保存修改';
    document.getElementById('company').value = job.company || '';
    document.getElementById('role').value = job.role || '';
    document.getElementById('status').value = job.status || '已投递';
    document.getElementById('city').value = job.city || '';
    document.getElementById('salary').value = job.salary || '';
    document.getElementById('jobUrl').value = job.jobUrl || '';
    document.getElementById('deadline').value = toDateOnly(job.deadline);
    document.getElementById('applicationDate').value = toDateOnly(job.applicationDate);
    document.getElementById('notes').value = job.notes || '';
    document.getElementById('assessmentDate').value = (job.assessment && job.assessment.date) || '';
    document.getElementById('assessmentType').value = (job.assessment && job.assessment.type) || '';
    document.getElementById('interviewDate').value = currentRound.date || '';
    document.getElementById('interviewMode').value = currentRound.mode || '';
    document.getElementById('interviewNote').value = currentRound.note || '';
    document.getElementById('offerDate').value = toDateOnly(job.offer && job.offer.date);
    document.getElementById('offerDeadline').value = toDateOnly(job.offer && job.offer.replyDeadline);
    document.getElementById('offerSalary').value = (job.offer && job.offer.salary) || '';
    applyStatusBlocks(job.status || '已投递');
    setCollapse('more-info', 'collapse-arrow', true);
    updateResumeSelect(job.resumeId || '');
    openModal('job-modal');
}

function closeJobModal() { closeModal('job-modal'); editingJobId = null; }

function setCollapse(contentId, arrowId, expanded) {
    const content = document.getElementById(contentId);
    const arrow = document.getElementById(arrowId);
    if (content) content.classList.toggle('show', expanded);
    if (arrow) arrow.classList.toggle('collapsed', !expanded);
}

function toggleMoreInfo() {
    const content = document.getElementById('more-info');
    setCollapse('more-info', 'collapse-arrow', !content.classList.contains('show'));
}

function toggleReview() {
    const content = document.getElementById('review-section');
    setCollapse('review-section', 'review-arrow', !content.classList.contains('show'));
}

function updateResumeSelect(selectedId = '') {
    const select = document.getElementById('resumeId');
    const hint = document.getElementById('resume-hint');
    const resumes = getResumes();
    if (resumes.length === 0) {
        select.innerHTML = '<option value="">未指定</option>';
        select.disabled = true;
        hint.classList.remove('hidden');
        return;
    }
    select.disabled = false; hint.classList.add('hidden');
    select.innerHTML = '<option value="">未指定</option>' + resumes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}${r.category ? ' · '+escapeHtml(r.category) : ''}</option>`).join('');
    if (selectedId) select.value = selectedId;
}

function readJobForm() {
    const status = document.getElementById('status').value;
    const data = {
        company: document.getElementById('company').value.trim(),
        role: document.getElementById('role').value.trim(),
        status,
        city: document.getElementById('city').value.trim(),
        salary: document.getElementById('salary').value.trim(),
        jobUrl: document.getElementById('jobUrl').value.trim(),
        deadline: document.getElementById('deadline').value,
        applicationDate: document.getElementById('applicationDate').value,
        notes: document.getElementById('notes').value.trim(),
        resumeId: document.getElementById('resumeId').value || ''
    };
    data.assessment = null; data.interview = null; data.offer = null;
    if (status === '笔试/测评') data.assessment = { date: document.getElementById('assessmentDate').value||'', type: document.getElementById('assessmentType').value||'', note:'' };
    else if (INTERVIEW_STATUSES.includes(status)) data.interview = { date: document.getElementById('interviewDate').value||'', mode: document.getElementById('interviewMode').value||'', note: document.getElementById('interviewNote').value.trim() };
    else if (status === 'Offer') data.offer = { date: document.getElementById('offerDate').value||'', replyDeadline: document.getElementById('offerDeadline').value||'', salary: document.getElementById('offerSalary').value.trim() };
    return data;
}

function saveJob(formData) {
    if (submitting) return;
    submitting = true;
    const targetId = editingJobId;
    editingJobId = null;
    const data = getData();
    const now = nowISO();
    if (targetId) {
        const idx = data.jobs.findIndex(j => j.id === targetId);
        if (idx === -1) { submitting = false; return; }
        const previous = data.jobs[idx];
        // Editing basic fields must retain previously saved schedules and review.
        const assessment = formData.assessment ? { ...previous.assessment, ...formData.assessment } : previous.assessment || null;
        const round = previous.interviewHistory.find(iv => iv.stage === formData.status);
        const interview = formData.interview ? { ...(round || {}), ...formData.interview, stage: formData.status } : previous.interview || null;
        const offer = formData.offer ? { ...previous.offer, ...formData.offer } : previous.offer || null;
        const job = { ...previous, ...formData, assessment, interview, offer, updatedAt: now };
        if (formData.interview) upsertInterview(job, job.status, interview);
        syncJobMilestones(job);
        data.jobs[idx] = job;
    } else {
        const job = { id: generateId(), ...formData, favorite: false, interviewHistory: [], createdAt: now, updatedAt: now };
        if (formData.interview) upsertInterview(job, job.status, formData.interview);
        syncJobMilestones(job);
        data.jobs.push(job);
    }
    saveData(data);
    submitting = false;
    closeJobModal();
    refreshAll();
}

// ============================================
// 下一阶段
// ============================================
let advanceJobId = null, advanceTargetStatus = '';

function advanceStage(jobId) {
    const data = getData();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;
    const curIdx = STATUS_ORDER.indexOf(job.status);
    if (curIdx === -1) return;
    let nextIdx = curIdx + 1;
    while (nextIdx < STATUS_ORDER.length && (STATUS_ORDER[nextIdx] === '已拒绝' || STATUS_ORDER[nextIdx] === '已结束')) nextIdx++;
    if (nextIdx >= STATUS_ORDER.length) return;
    const target = STATUS_ORDER[nextIdx];
    if (target !== '笔试/测评' && !INTERVIEW_STATUSES.includes(target)) { applyStatus(jobId, target, {}); return; }
    advanceJobId = jobId; advanceTargetStatus = target;
    const isAsm = target === '笔试/测评';
    document.getElementById('advance-title').textContent = `进入「${target}」`;
    document.getElementById('advance-desc').textContent = isAsm ? '可以现在填写测评时间，也可以暂时跳过。' : '可以现在填写面试时间和形式，也可以暂时跳过。';
    document.getElementById('advanceDateLabel').textContent = isAsm ? '测评时间（可选）' : '面试时间（可选）';
    document.getElementById('advanceDate').value = '';
    document.getElementById('advanceModeGroup').classList.toggle('hidden', isAsm);
    document.getElementById('advanceMode').value = '';
    openModal('advance-modal');
}

function closeAdvanceModal() { closeModal('advance-modal'); advanceJobId = null; advanceTargetStatus = ''; }

function submitAdvance() {
    if (!advanceJobId || !advanceTargetStatus) return;
    const date = document.getElementById('advanceDate').value || '';
    const mode = document.getElementById('advanceMode').value || '';
    const id = advanceJobId;
    const targetStatus = advanceTargetStatus;
    closeAdvanceModal();
    applyStatus(id, targetStatus, { date, mode });
}

function advanceWithoutSchedule() {
    if (!advanceJobId || !advanceTargetStatus) return;
    const id = advanceJobId;
    const targetStatus = advanceTargetStatus;
    closeAdvanceModal();
    applyStatus(id, targetStatus, {});
}

function applyStatus(jobId, status, extra) {
    const data = getData();
    const job = data.jobs.find(j => j.id === jobId);
    if (!job) return;
    const isSkip = !extra.date && !extra.mode && !extra.type;
    job.status = status; job.updatedAt = nowISO();
    if (status === '笔试/测评') {
        if (!isSkip || !job.assessment) job.assessment = { date: extra.date||'', type: extra.type||'', note:'' };
    } else if (INTERVIEW_STATUSES.includes(status)) {
        const existing = job.interviewHistory.find(iv => iv.stage === status);
        const info = { ...(existing || { date: '', mode: '', note: '', review: null }) };
        if (!isSkip) Object.assign(info, { date: extra.date || '', mode: extra.mode || '', note: extra.note === undefined ? info.note : extra.note });
        upsertInterview(job, status, info);
    } else if (status === 'Offer') { if (!job.offer) job.offer = { date:'',replyDeadline:'',salary:'' }; }
    syncJobMilestones(job);
    saveData(data);
    refreshAll();
}

// ============================================
// 删除
// ============================================
let pendingDelete = null;

function confirmDelete(jobId) {
    const job = getData().jobs.find(j => j.id === jobId);
    if (!job) return;
    pendingDelete = { type:'job', id:jobId };
    document.getElementById('confirm-title').textContent = '删除岗位';
    document.getElementById('confirm-message').textContent = `确定要删除「${job.company} · ${job.role}」吗？此操作不可恢复。`;
    document.getElementById('confirm-delete-btn').textContent = '确认删除';
    openModal('confirm-modal');
}

function closeConfirmModal() { closeModal('confirm-modal'); pendingDelete = null; pendingImport = null; }

function executePendingDelete() {
    if (!pendingDelete) return;
    const { type, id } = pendingDelete;
    if (type === 'clear') { clearAllData(); pendingDelete = null; return; }
    if (type === 'job') {
        const data = getData();
        data.jobs = data.jobs.filter(j => j.id !== id);
        saveData(data);
    } else if (type === 'resume') {
        let resumes = getResumes().filter(r => r.id !== id);
        saveResumes(resumes);
        deleteResumeFile(id);
        const data = getData(); let changed = false;
        data.jobs.forEach(j => { if (j.resumeId === id) { j.resumeId = ''; changed = true; } });
        if (changed) saveData(data);
    }
    pendingDelete = null;
    closeConfirmModal();
    refreshAll();
}

function confirmDeleteResume(resumeId) {
    const resume = getResumes().find(r => r.id === resumeId);
    if (!resume) return;
    pendingDelete = { type:'resume', id:resumeId };
    document.getElementById('confirm-title').textContent = '删除简历';
    document.getElementById('confirm-message').textContent = `确定要删除「${resume.name}」吗？简历文件会一并删除，此操作不可恢复。`;
    document.getElementById('confirm-delete-btn').textContent = '确认删除';
    openModal('confirm-modal');
}

// ============================================
// 岗位详情
// ============================================
function openDetailModal(jobId) {
    const job = getData().jobs.find(j => j.id === jobId);
    if (!job) return;
    const resumes = getResumes();
    const resume = job.resumeId ? resumes.find(r => r.id === job.resumeId) : null;
    const infoItem = (label, value) => value ? `<div class="detail-item"><div class="label">${label}</div><div class="value">${value}</div></div>` : '';
    let scheduleHtml = '';
    if (job.assessment && (job.assessment.date || job.assessment.type)) {
        scheduleHtml += `<div class="detail-section"><h4>笔试 / 测评</h4><div class="detail-grid">${infoItem('测评时间', job.assessment.date ? formatDateTime(job.assessment.date) : '')}${infoItem('测评形式', job.assessment.type)}</div></div>`;
    }
    if (job.interview && (job.interview.date || job.interview.mode || job.interview.note)) {
        scheduleHtml += `<div class="detail-section"><h4>${job.status}安排</h4><div class="detail-grid">${infoItem('面试时间', job.interview.date ? formatDateTime(job.interview.date) : '')}${infoItem('面试形式', job.interview.mode)}${infoItem('面试备注', job.interview.note)}</div></div>`;
    }
    if (job.offer && (job.offer.date || job.offer.replyDeadline || job.offer.salary)) {
        scheduleHtml += `<div class="detail-section"><h4>Offer</h4><div class="detail-grid">${infoItem('Offer 日期', job.offer.date)}${infoItem('回复截止', job.offer.replyDeadline)}${infoItem('薪资', job.offer.salary)}</div></div>`;
    }
    if (job.interview && job.interview.review && Object.keys(job.interview.review).some(k => job.interview.review[k])) {
        const r = job.interview.review;
        const row = (label, value) => value ? `<div class="review-row"><div class="review-label">${label}</div><div class="review-text">${escapeHtml(value)}</div></div>` : '';
        scheduleHtml += `<div class="detail-section"><h4>面试复盘</h4><div class="review-box">${row('面试问题',r.questions)}${row('我的回答',r.answers)}${row('做得好的地方',r.good)}${row('需要改进',r.improve)}${row('备注',r.note)}</div></div>`;
    }
    const canAdvance = ACTIVE_STATUSES.includes(job.status) && job.status !== 'Offer';
    const canEditInterview = INTERVIEW_STATUSES.includes(job.status);
    document.getElementById('detail-content').innerHTML = `
        <div class="detail-head">
            <div>
                <div class="detail-company">${escapeHtml(job.company)}</div>
                <div class="detail-role">${escapeHtml(job.role)}</div>
            </div>
            ${STATUS_BADGE(job.status)}
        </div>
        <div class="detail-section">
            <h4>基本信息</h4>
            <div class="detail-grid">
                ${infoItem('城市', job.city)}
                ${infoItem('薪资', job.salary)}
                ${infoItem('投递日期', job.applicationDate)}
                ${infoItem('截止日期', job.deadline)}
                ${infoItem('投递简历', resume ? resume.name : '')}
            </div>
        </div>
        ${scheduleHtml}
        ${job.jobUrl ? `<div class="detail-section"><h4>岗位链接</h4><div class="detail-item span-2"><div class="value"><a href="${escapeHtml(job.jobUrl)}" target="_blank" rel="noopener">${escapeHtml(job.jobUrl)}</a></div></div></div>` : ''}
        ${job.notes ? `<div class="detail-section"><h4>备注</h4><div class="detail-item span-2"><div class="value pre-wrap">${escapeHtml(job.notes)}</div></div></div>` : ''}
        <div class="detail-actions">
            ${canAdvance ? `<button class="btn btn-secondary btn-sm" data-detail-action="advance" data-id="${escapeHtml(job.id)}">下一阶段</button>` : ''}
            ${canEditInterview ? `<button class="btn btn-secondary btn-sm" data-detail-action="interview" data-id="${escapeHtml(job.id)}">编辑面试 / 复盘</button>` : ''}
            <button class="btn btn-primary btn-sm" data-detail-action="edit" data-id="${escapeHtml(job.id)}">编辑</button>
            <button class="btn btn-danger-text btn-sm" data-detail-action="delete" data-id="${escapeHtml(job.id)}">删除</button>
        </div>`;
    openModal('detail-modal');
}

function closeDetailModal() { closeModal('detail-modal'); }

// ============================================
// 日程
// ============================================
function renderSchedule() {
    const jobs = getData().jobs;
    const container = document.getElementById('schedule-timeline');
    let items = [];
    jobs.forEach(job => { items = items.concat(collectScheduleItems(job)); });
    items = items.filter(i => i.date && !isNaN(new Date(i.date).getTime())).sort((a,b) => new Date(a.date) - new Date(b.date));

    if (items.length === 0) {
        container.innerHTML = emptyBlock(ART.calendarCoffee, '暂无日程安排', '当有截止日期、测评、面试或 Offer 回复日期时，会显示在这里。', '');
        return;
    }

    const groups = [
        { key:'overdue', title:'已完成', cls:'overdue', dot:'overdue', test: d => d < 0 },
        { key:'today',   title:'今天',    cls:'today',   dot:'today',   test: d => d === 0 },
        { key:'week',   title:'本周',    cls:'week',    dot:'week',    test: d => d > 0 && d <= 7 },
        { key:'future', title:'之后',    cls:'future',  dot:'future',  test: d => d > 7 }
    ];

    let html = '';
    groups.forEach(g => {
        const list = items.filter(i => g.test(daysDiff(i.date)));
        if (!list.length) return;
        html += `
            <div class="tl-group">
                <div class="tl-group-title">
                    <span class="tl-dot ${g.dot}"></span>
                    <span>${g.title}</span>
                    <span class="tl-count">${list.length}</span>
                </div>
                <div class="tl-items">
                    ${list.map(i => {
                        const d = daysDiff(i.date);
                        const overdue = d < 0;
                        const dateText = overdue ? '已完成' : formatDate(i.date);
                        return `
                            <div class="tl-item ${overdue ? 'overdue' : ''}" data-job="${escapeHtml(i.job.id)}">
                                <span class="tl-item-icon">
                                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3">
                                        <circle cx="7" cy="7" r="5.5"/>
                                        <path d="M7 4.5v3l2 1.5" stroke-linecap="round"/>
                                    </svg>
                                </span>
                                <div class="tl-item-main">
                                    <span class="tl-item-company">${escapeHtml(i.job.company)}</span>
                                    <span class="tl-item-sep">·</span>
                                    <span class="tl-item-role">${escapeHtml(i.job.role)}</span>
                                </div>
                                <span class="tl-item-label">${escapeHtml(i.label)}</span>
                                <span class="tl-item-date ${overdue ? 'overdue' : ''}">${dateText}</span>
                            </div>`;
                    }).join('')}
                </div>
            </div>`;
    });
    container.innerHTML = html;
}

// ============================================
// 面试页
// ============================================
function renderInterviews() {
    const container = document.getElementById('interviews-list');
    const records = getData().jobs.flatMap(job => job.interviewHistory.map(iv => ({ job, iv })));
    const now = Date.now();
    const timestamp = entry => new Date(entry.iv.date).getTime();
    const upcoming = records.filter(entry => !Number.isFinite(timestamp(entry)) || timestamp(entry) >= now)
        .sort((a, b) => (Number.isFinite(timestamp(a)) ? timestamp(a) : Infinity) - (Number.isFinite(timestamp(b)) ? timestamp(b) : Infinity));
    const past = records.filter(entry => Number.isFinite(timestamp(entry)) && timestamp(entry) < now)
        .sort((a, b) => timestamp(b) - timestamp(a));
    const card = ({ job, iv }) => {
        const hasReview = iv.review && Object.values(iv.review).some(Boolean);
        return `<div class="interview-card" data-id="${escapeHtml(job.id)}">
            <div class="interview-row">
                <div class="interview-row-main">
                    <div class="interview-company">${escapeHtml(job.company)}</div>
                    <div class="interview-role">${escapeHtml(job.role)}</div>
                </div>
                <div class="interview-stage">${STATUS_BADGE(iv.stage)}</div>
                <div class="interview-meta">
                    <span class="interview-date">${Number.isFinite(new Date(iv.date).getTime()) ? formatDateTime(iv.date) : '时间待定'}</span>
                    <span aria-hidden="true">·</span>
                    <span class="interview-mode">${escapeHtml(iv.mode || '形式待定')}</span>
                </div>
                <div class="interview-review-status"><span class="status-tag review-flag ${hasReview ? 'is-done' : ''}">${hasReview ? '已复盘' : '未复盘'}</span></div>
                <div class="interview-actions">
                    <button class="btn btn-text btn-sm" data-action="interview" data-id="${escapeHtml(job.id)}" data-interview-id="${escapeHtml(iv.id)}">${hasReview ? '查看复盘' : '添加复盘'} →</button>
                </div>
            </div>
            ${hasReview ? `<div class="review-box">${[
                ['面试问题', 'questions'], ['我的回答', 'answers'], ['做得好的地方', 'good'], ['需要改进', 'improve'], ['备注', 'note']
            ].filter(([, key]) => iv.review[key]).map(([label, key]) => `<div class="review-row"><div class="review-label">${label}</div><div class="review-text">${escapeHtml(iv.review[key])}</div></div>`).join('')}</div>` : ''}
        </div>`;
    };
    const section = (title, list, empty) => `<section class="interview-section">
        <h2 class="section-title">${title}</h2>
        <div class="interviews-list">${list.length ? list.map(card).join('') : `<p class="interview-section-empty">${empty}</p>`}</div>
    </section>`;
    container.innerHTML = section('即将进行', upcoming, '暂时没有即将进行的面试。') + section('过往面试', past, '还没有过往面试记录。');
}

// ============================================
// 简历
// ============================================
let currentResumeFilter = '';
let editingResumeId = null;
let currentResumeFile = null;

function renderResumes() {
    const resumes = getResumes();
    const filterContainer = document.getElementById('resume-filter');
    const listContainer = document.getElementById('resumes-list');

    const usedCategories = RESUME_CATEGORIES.filter(c => resumes.some(r => r.category === c));
    filterContainer.innerHTML = `
        <button class="chip-btn ${currentResumeFilter === '' ? 'active' : ''}" data-resume-filter="">全部</button>
        ${usedCategories.map(c => `<button class="chip-btn ${currentResumeFilter === c ? 'active' : ''}" data-resume-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}`;

    let list = resumes.slice();
    if (currentResumeFilter) list = list.filter(r => r.category === currentResumeFilter);
    list.sort((a,b) => String(b.createdAt||'').localeCompare(String(a.createdAt||'')));

    if (!resumes.length) {
        listContainer.innerHTML = emptyBlock(ART.folderPaper, '还没有简历', '添加你的第一份简历，添加岗位时可以直接选择投递版本。',
            `<button class="btn btn-primary btn-sm" data-action="add-resume">+ 添加简历</button>`);
        return;
    }

    if (!list.length) {
        listContainer.innerHTML = emptyBlock(ART.searchEmpty, '该分类下暂无简历', '选择其他分类看看', '');
        return;
    }

    listContainer.innerHTML = `
        <div class="resumes-table-wrap">
            <table class="resumes-table">
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>方向</th>
                        <th>文件</th>
                        <th>更新时间</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${list.map(r => `
                        <tr data-id="${escapeHtml(r.id)}">
                            <td>
                                <div class="resume-name-cell">
                                    <div class="resume-icon-sm">
                                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                                            <path d="M3 1h5.5l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z"/>
                                            <path d="M8.5 1v4h4"/>
                                        </svg>
                                    </div>
                                    <span class="resume-name-text">${escapeHtml(r.name)}</span>
                                </div>
                            </td>
                            <td><span class="resume-category">${escapeHtml(r.category || '未分类')}</span></td>
                            <td><span class="cell-dim">${r.fileName ? `${escapeHtml(r.fileName)} <span class="resume-file-size">${formatFileSize(r.fileSize)}</span>` : '未上传'}</span></td>
                            <td class="resume-date-cell">${r.createdAt ? relativeTime(r.createdAt) : '—'}</td>
                            <td>
                                <div class="table-action">
                                    ${r.fileName ? `<button class="btn btn-text btn-sm" data-action="download-resume" data-id="${escapeHtml(r.id)}">下载</button>` : ''}
                                    <button class="btn btn-text btn-sm" data-action="edit-resume" data-id="${escapeHtml(r.id)}">编辑</button>
                                    <button class="table-more-btn" data-id="${escapeHtml(r.id)}" title="更多操作">
                                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                                            <circle cx="7" cy="3" r="0.8" fill="currentColor" stroke="none"/>
                                            <circle cx="7" cy="7" r="0.8" fill="currentColor" stroke="none"/>
                                            <circle cx="7" cy="11" r="0.8" fill="currentColor" stroke="none"/>
                                        </svg>
                                    </button>
                                </div>
                            </td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

function openAddResumeModal() {
    editingResumeId = null; currentResumeFile = null; submitting = false;
    document.getElementById('resume-modal-title').textContent = '添加简历';
    document.getElementById('resume-submit-btn').textContent = '保存简历';
    document.getElementById('resume-form').reset();
    resetFileUI();
    openModal('resume-modal');
}

function openEditResumeModal(resumeId) {
    const resume = getResumes().find(r => r.id === resumeId);
    if (!resume) return;
    editingResumeId = resumeId; currentResumeFile = null; submitting = false;
    document.getElementById('resume-modal-title').textContent = '编辑简历';
    document.getElementById('resume-submit-btn').textContent = '保存修改';
    document.getElementById('resumeName').value = resume.name || '';
    document.getElementById('resumeCategory').value = resume.category || '';
    document.getElementById('resumeNotes').value = resume.notes || '';
    if (resume.fileName) showFileInfo(resume.fileName, resume.fileSize);
    else resetFileUI();
    openModal('resume-modal');
}

function closeResumeModal() { closeModal('resume-modal'); editingResumeId = null; currentResumeFile = null; resetFileUI(); }

function resetFileUI() {
    document.getElementById('file-info').classList.add('hidden');
    document.getElementById('file-upload-area').classList.remove('hidden');
    document.getElementById('resumeFile').value = '';
}

function showFileInfo(name, size) {
    document.getElementById('file-info').classList.remove('hidden');
    document.getElementById('file-upload-area').classList.add('hidden');
    document.querySelector('#file-info .file-name').textContent = name;
    document.querySelector('#file-info .file-size').textContent = formatFileSize(size);
}

async function saveResume(form, file) {
    if (submitting) return;
    submitting = true;
    const targetId = editingResumeId;
    editingResumeId = null;
    const resumes = getResumes();

    if (targetId) {
        const idx = resumes.findIndex(r => r.id === targetId);
        if (idx === -1) { submitting = false; return; }
        resumes[idx] = { ...resumes[idx], name: form.name, category: form.category, notes: form.notes };
        if (file) {
            try { await saveResumeFile(targetId, file); resumes[idx].fileName = file.name; resumes[idx].fileType = file.type; resumes[idx].fileSize = file.size; }
            catch (err) { console.error(err); alert('文件保存失败，简历信息已保存。'); }
        }
    } else {
        const id = generateId();
        const item = { id, name: form.name, category: form.category, notes: form.notes, createdAt: nowISO(), fileName: file ? file.name : '', fileType: file ? file.type : '', fileSize: file ? file.size : 0 };
        resumes.push(item);
        if (file) {
            try { await saveResumeFile(id, file); }
            catch (err) { console.error(err); alert('文件保存失败，简历信息已保存。'); }
        }
    }
    saveResumes(resumes);
    submitting = false;
    closeResumeModal();
    refreshAll();
}

async function downloadResume(resumeId) {
    try {
        const fd = await getResumeFile(resumeId);
        if (!fd || !fd.blob) { alert('未找到文件，请重新上传。'); return; }
        downloadBlob(fd.blob, fd.fileName);
    } catch (err) { console.error(err); alert('无法下载文件'); }
}

// ============================================
// 导入 / 导出
// ============================================
function exportBackup() {
    const backup = { version:2, exportDate: nowISO(), jobs: getData().jobs, resumes: getResumes() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
    downloadBlob(blob, `job-tracker-backup-${getCurrentDate()}.json`);
}

function importBackup(e) {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.target.result); }
        catch { alert('文件解析失败，请选择正确的 JSON 备份文件。'); return; }
        const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : (parsed.data && Array.isArray(parsed.data.jobs)) ? parsed.data.jobs : null;
        if (!jobs) { alert('文件格式不正确：未找到岗位数据。'); return; }
        const resumes = Array.isArray(parsed.resumes) ? parsed.resumes : (parsed.data && Array.isArray(parsed.data.resumes)) ? parsed.data.resumes : [];
        pendingImport = { jobs, resumes };
        document.getElementById('confirm-title').textContent = '导入备份';
        document.getElementById('confirm-message').textContent = `即将导入 ${jobs.length} 个岗位、${resumes.length} 份简历。确认后现有数据将被覆盖。`;
        document.getElementById('confirm-delete-btn').textContent = '确认导入';
        openModal('confirm-modal');
    };
    reader.readAsText(file);
}

let pendingImport = null;

function executeImport() {
    if (!pendingImport) return;
    saveData({ jobs: pendingImport.jobs });
    if (pendingImport.resumes.length) saveResumes(pendingImport.resumes);
    pendingImport = null;
    closeConfirmModal();
    refreshAll();
    navigateTo('dashboard');
}

function exportCSV() {
    const jobs = getData().jobs;
    if (!jobs.length) { alert('暂无岗位数据可导出。'); return; }
    const resumes = getResumes();
    const resumeName = id => { const r = resumes.find(x => x.id === id); return r ? r.name : ''; };
    const headers = ['公司','岗位','状态','城市','薪资','岗位链接','截止日期','投递日期','测评时间','测评形式','面试时间','面试形式','面试备注','Offer日期','回复截止','投递简历','备注','创建时间','收藏'];
    const rows = jobs.map(j => [
        j.company,j.role,j.status,j.city,j.salary,j.jobUrl,j.deadline,j.applicationDate,
        (j.assessment&&j.assessment.date)||'',(j.assessment&&j.assessment.type)||'',
        (j.interview&&j.interview.date)||'',(j.interview&&j.interview.mode)||'',(j.interview&&j.interview.note)||'',
        (j.offer&&j.offer.date)||'',(j.offer&&j.offer.replyDeadline)||'',resumeName(j.resumeId),
        (j.notes||'').replace(/\r?\n/g,' '),j.createdAt||'',j.favorite === true ? '是' : '否'
    ]);
    const esc = v => `"${String(v??'').replace(/"/g,'""')}"`;
    const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
    const blob = new Blob([String.fromCharCode(0xFEFF)+csv], { type:'text/csv;charset=utf-8;' });
    downloadBlob(blob, `job-tracker-${getCurrentDate()}.csv`);
}

async function clearAllData() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(RESUME_KEY);
    await clearResumeFiles();
    pendingDelete = null;
    closeConfirmModal();
    refreshAll();
    navigateTo('dashboard');
}

// ============================================
// 统一刷新
// ============================================
function refreshAll() {
    RENDERERS.dashboard && RENDERERS.dashboard();
    RENDERERS.jobs && RENDERERS.jobs();
    RENDERERS.schedule && RENDERERS.schedule();
    RENDERERS.interviews && RENDERERS.interviews();
    RENDERERS.resumes && RENDERERS.resumes();
}

// ============================================
// 事件绑定
// ============================================
function handleAction(action, id, interviewId) {
    switch (action) {
        case 'add-job': openAddModal(); break;
        case 'edit': openEditModal(id); break;
        case 'detail': openDetailModal(id); break;
        case 'advance': advanceStage(id); break;
        case 'delete': confirmDelete(id); break;
        case 'interview': openInterviewModal(id, interviewId); break;
        case 'add-resume': openAddResumeModal(); break;
        case 'edit-resume': openEditResumeModal(id); break;
        case 'delete-resume': confirmDeleteResume(id); break;
        case 'download-resume': downloadResume(id); break;
    }
}

function bindEvents() {
    // List containers: table rows + action buttons
    document.getElementById('jobs-list').addEventListener('click', e => {
        const heart = e.target.closest('[data-action="favorite"]');
        if (heart) {
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite(heart.dataset.id);
            return;
        }
        // ··· button opens the context dropdown (must run before row click)
        const more = e.target.closest('.table-more-btn');
        if (more) { e.stopPropagation(); showJobCtxDropdown(more, more.dataset.id); return; }
        const btn = e.target.closest('[data-action]');
        if (btn) { handleAction(btn.dataset.action, btn.dataset.id); return; }
        const row = e.target.closest('tr[data-job]');
        if (row) openDetailModal(row.dataset.job);
    });

    document.getElementById('resumes-list').addEventListener('click', e => {
        const more = e.target.closest('.table-more-btn');
        if (more) { e.stopPropagation(); showResumeCtxDropdown(more, more.dataset.id); return; }
        const btn = e.target.closest('[data-action]');
        if (btn) { handleAction(btn.dataset.action, btn.dataset.id); return; }
        const row = e.target.closest('tr[data-id]');
        if (row) openEditResumeModal(row.dataset.id);
    });

    // Interviews list
    document.getElementById('interviews-list').addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (btn) { e.stopPropagation(); handleAction(btn.dataset.action, btn.dataset.id, btn.dataset.interviewId); return; }
        const card = e.target.closest('[data-id]');
        if (card) openDetailModal(card.dataset.id);
    });

    // Close context dropdown on outside click
    // (skips the opener button itself, otherwise the dropdown closes instantly)
    document.addEventListener('click', e => {
        if (!activeCtx) return;
        if (e.target.closest('.ctx-dropdown') || e.target.closest('.table-more-btn')) return;
        closeAllDropdowns();
    });

    // Detail modal buttons
    document.getElementById('detail-content').addEventListener('click', e => {
        const btn = e.target.closest('[data-detail-action]');
        if (!btn) return;
        const id = btn.dataset.id, action = btn.dataset.detailAction;
        closeDetailModal();
        if (action === 'edit') openEditModal(id);
        else if (action === 'advance') advanceStage(id);
        else if (action === 'delete') confirmDelete(id);
        else if (action === 'interview') openInterviewModal(id);
    });

    // Dashboard / Schedule todos
    ['dashboard-todos','schedule-timeline'].forEach(id => {
        document.getElementById(id).addEventListener('click', e => {
            const row = e.target.closest('[data-job]');
            if (row) openDetailModal(row.dataset.job);
        });
    });

    // Resume filter tabs
    document.getElementById('resume-filter').addEventListener('click', e => {
        const btn = e.target.closest('[data-resume-filter]');
        if (!btn) return;
        currentResumeFilter = btn.dataset.resumeFilter;
        renderResumes();
    });

    // Add buttons (both dashboard and jobs page)
    document.getElementById('btn-add-job').addEventListener('click', () => openAddModal());
    document.getElementById('btn-add-job-dash').addEventListener('click', () => openAddModal());
    document.getElementById('btn-add-resume').addEventListener('click', () => openAddResumeModal());

    // Job filters
    document.getElementById('filter-favorite').addEventListener('click', e => {
        currentFavoriteOnly = !currentFavoriteOnly;
        e.currentTarget.classList.toggle('active', currentFavoriteOnly);
        e.currentTarget.setAttribute('aria-pressed', String(currentFavoriteOnly));
        renderJobs();
    });
    document.getElementById('search-input').addEventListener('input', e => { currentSearch = e.target.value; renderJobs(); });
    document.getElementById('filter-status').addEventListener('change', e => { currentStatusFilter = e.target.value; renderJobs(); });
    document.getElementById('filter-city').addEventListener('change', e => { currentCityFilter = e.target.value; renderJobs(); });

    // Job form
    document.getElementById('job-form').addEventListener('submit', e => {
        e.preventDefault();
        const company = document.getElementById('company').value.trim();
        const role = document.getElementById('role').value.trim();
        if (!company || !role) { alert('请填写公司名称和岗位名称'); return; }
        saveJob(readJobForm());
    });

    // Advance form
    document.getElementById('advance-form').addEventListener('submit', e => { e.preventDefault(); submitAdvance(); });

    // Interview form
    document.getElementById('interview-form').addEventListener('submit', e => { e.preventDefault(); saveInterview(); });

    // Resume form
    document.getElementById('resume-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('resumeName').value.trim();
        const category = document.getElementById('resumeCategory').value;
        if (!name) { alert('请填写简历名称'); return; }
        if (!category) { alert('请选择目标方向'); return; }
        await saveResume({ name, category, notes: document.getElementById('resumeNotes').value.trim() }, currentResumeFile);
    });

    // Resume file
    document.getElementById('resumeFile').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        if (!/\.(pdf|doc|docx)$/i.test(file.name)) { alert('只支持 PDF、DOC、DOCX 格式。'); e.target.value = ''; return; }
        if (file.size > MAX_FILE_SIZE) { alert('文件大小不能超过 8MB。'); e.target.value = ''; return; }
        currentResumeFile = file;
        showFileInfo(file.name, file.size);
    });

    // Confirm modal
    document.getElementById('confirm-delete-btn').addEventListener('click', () => {
        if (pendingImport) executeImport();
        else if (pendingDelete) executePendingDelete();
    });

    // Settings
    document.getElementById('btn-export').addEventListener('click', exportBackup);
    document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
    document.getElementById('import-file').addEventListener('change', importBackup);
    document.getElementById('btn-csv').addEventListener('click', exportCSV);
    document.getElementById('btn-clear').addEventListener('click', () => {
        document.getElementById('confirm-title').textContent = '清除全部数据';
        document.getElementById('confirm-message').textContent = '确定要清除所有岗位和简历数据吗？此操作不可恢复。';
        document.getElementById('confirm-delete-btn').textContent = '确认清除';
        pendingDelete = { type:'clear' };
        openModal('confirm-modal');
    });

    // Modal overlay click to close
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('mousedown', e => {
            if (e.target !== overlay) return;
            const id = overlay.id;
            if (id === 'confirm-modal') closeConfirmModal();
            else if (id === 'advance-modal') closeAdvanceModal();
            else if (id === 'job-modal') closeJobModal();
            else if (id === 'detail-modal') closeDetailModal();
            else if (id === 'interview-modal') closeInterviewModal();
            else if (id === 'resume-modal') closeResumeModal();
        });
    });

    // ESC to close
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !activeModalId) return;
        const id = activeModalId;
        if (id === 'confirm-modal') closeConfirmModal();
        else if (id === 'advance-modal') closeAdvanceModal();
        else if (id === 'job-modal') closeJobModal();
        else if (id === 'detail-modal') closeDetailModal();
        else if (id === 'interview-modal') closeInterviewModal();
        else if (id === 'resume-modal') closeResumeModal();
    });
}

// ============================================
// Context Dropdown helpers
// ============================================
let activeCtx = null;

function showJobCtxDropdown(btn, jobId) {
    closeAllDropdowns();
    const job = getData().jobs.find(j => j.id === jobId);
    if (!job) return;
    const canAdvance = ACTIVE_STATUSES.includes(job.status) && job.status !== 'Offer';
    const canInterview = INTERVIEW_STATUSES.includes(job.status);

    const dropdown = document.createElement('div');
    dropdown.className = 'ctx-dropdown open';
    dropdown.style.position = 'fixed';
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.innerHTML = `
        <button class="ctx-item" data-action="detail" data-id="${escapeHtml(jobId)}">查看</button>
        <button class="ctx-item" data-action="edit" data-id="${escapeHtml(jobId)}">编辑</button>
        ${canAdvance ? `<button class="ctx-item" data-action="advance" data-id="${escapeHtml(jobId)}">下一阶段</button>` : ''}
        ${canInterview ? `<button class="ctx-item" data-action="interview" data-id="${escapeHtml(jobId)}">编辑面试</button>` : ''}
        <button class="ctx-item danger" data-action="delete" data-id="${escapeHtml(jobId)}">删除</button>`;
    document.body.appendChild(dropdown);
    activeCtx = dropdown;

    dropdown.addEventListener('click', ev => {
        ev.stopPropagation();
        const item = ev.target.closest('[data-action]');
        if (item) { handleAction(item.dataset.action, item.dataset.id); closeAllDropdowns(); }
    });
}

function showResumeCtxDropdown(btn, resumeId) {
    closeAllDropdowns();
    const dropdown = document.createElement('div');
    dropdown.className = 'ctx-dropdown open';
    dropdown.style.position = 'fixed';
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.innerHTML = `
        <button class="ctx-item" data-action="edit-resume" data-id="${escapeHtml(resumeId)}">编辑</button>
        <button class="ctx-item" data-action="delete-resume" data-id="${escapeHtml(resumeId)}">删除</button>`;
    document.body.appendChild(dropdown);
    activeCtx = dropdown;
    dropdown.addEventListener('click', ev => {
        ev.stopPropagation();
        const item = ev.target.closest('[data-action]');
        if (item) { handleAction(item.dataset.action, item.dataset.id); closeAllDropdowns(); }
    });
}

function closeAllDropdowns() {
    if (activeCtx) { activeCtx.remove(); activeCtx = null; }
}

// ============================================
// 面试 Modal (复用)
// ============================================
let currentInterviewJobId = null;
let currentInterviewRecordId = null;
let currentInterviewStage = null;

function openInterviewModal(jobId, recordId) {
    const job = getData().jobs.find(j => j.id === jobId);
    if (!job) return;
    currentInterviewJobId = jobId;
    const record = recordId ? job.interviewHistory.find(iv => iv.id === recordId) : job.interviewHistory.find(iv => iv.stage === job.status);
    if (recordId && !record) return;
    currentInterviewRecordId = record ? record.id : null;
    currentInterviewStage = record ? record.stage : (INTERVIEW_STATUSES.includes(job.status) ? job.status : '面试');
    const iv = record || (job.interview && job.interview.stage === currentInterviewStage ? job.interview : {});
    const review = iv.review || {};
    document.getElementById('interview-modal-title').textContent = `${job.company} · ${currentInterviewStage}`;
    document.getElementById('mInterviewDate').value = iv.date || '';
    document.getElementById('mInterviewMode').value = iv.mode || '';
    document.getElementById('mInterviewNote').value = iv.note || '';
    document.getElementById('mReviewQuestions').value = review.questions || '';
    document.getElementById('mReviewAnswers').value = review.answers || '';
    document.getElementById('mReviewGood').value = review.good || '';
    document.getElementById('mReviewImprove').value = review.improve || '';
    document.getElementById('mReviewNote').value = review.note || '';
    const hasReview = Object.values(review).some(Boolean);
    setCollapse('review-section', 'review-arrow', hasReview);
    openModal('interview-modal');
}

function closeInterviewModal() { closeModal('interview-modal'); currentInterviewJobId = null; currentInterviewRecordId = null; currentInterviewStage = null; }

function saveInterview() {
    if (!currentInterviewJobId) return;
    const data = getData();
    const job = data.jobs.find(j => j.id === currentInterviewJobId);
    if (!job) return;
    const review = {
        questions: document.getElementById('mReviewQuestions').value.trim(),
        answers: document.getElementById('mReviewAnswers').value.trim(),
        good: document.getElementById('mReviewGood').value.trim(),
        improve: document.getElementById('mReviewImprove').value.trim(),
        note: document.getElementById('mReviewNote').value.trim()
    };
    const hasReview = Object.values(review).some(Boolean);
    upsertInterview(job, currentInterviewStage, {
        date: document.getElementById('mInterviewDate').value || '',
        mode: document.getElementById('mInterviewMode').value || '',
        note: document.getElementById('mInterviewNote').value.trim(),
        review: hasReview ? review : null
    }, currentInterviewRecordId);
    job.updatedAt = nowISO();
    saveData(data);
    closeInterviewModal();
    refreshAll();
}

// ============================================
// 初始化
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    try { await openDB(); }
    catch (err) { console.warn('IndexedDB 不可用，简历文件将无法保存。', err); }
    initNavigation();
    bindEvents();
    refreshAll();
});
