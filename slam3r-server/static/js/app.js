/**
 * 宿舍 3D 记忆 — 主应用逻辑
 * 三视图：模型列表（首页） / 上传重建 / 模型详情
 * 页面切换 + CRUD + 进度轮询
 */

import { PointCloudViewer } from './viewer.js';

// ── DOM 引用 ──
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// 导航
const navHomeBtn = $('navHomeBtn');
const navNewBtn = $('navNewBtn');
const navUserInfo = $('navUserInfo');
const navUsername = $('navUsername');
const navLogoutBtn = $('navLogoutBtn');

// 视图容器
const loginView = $('loginView');
const registerView = $('registerView');
const resetView = $('resetView');
const listView = $('listView');
const uploadView = $('uploadView');
const detailView = $('detailView');
const howToSection = $('howToSection');
const views = [loginView, registerView, resetView, listView, uploadView, detailView];

// 莫兰迪背景元素
const authBg = $('authBg');
const authDecoDots = $('authDecoDots');
const appBg = $('appBg');
const uploadBg = $('uploadBg');
const mainContent = $('mainContent');

// 登录/注册/重置
const loginUsername = $('loginUsername');
const loginPassword = $('loginPassword');
const loginBtn = $('loginBtn');
const loginError = $('loginError');
const registerNickname = $('registerNickname');
const registerUsername = $('registerUsername');
const registerPassword = $('registerPassword');
const registerConfirm = $('registerConfirm');
const registerBtn = $('registerBtn');
const registerError = $('registerError');
const navAvatar = $('navAvatar');
const avatarInput = $('avatarInput');
const navAvatarWrap = $('navAvatarWrap');
const authAvatar = $('authAvatar');
const authAvatarInput = $('authAvatarInput');
const authAvatarWrap = $('authAvatarWrap');
const authAvatarPlaceholder = $('authAvatarPlaceholder');
const regAvatar = $('regAvatar');
const regAvatarInput = $('regAvatarInput');
const regAvatarWrap = $('regAvatarWrap');
const regAvatarPlaceholder = $('regAvatarPlaceholder');
const resetUsername = $('resetUsername');
const resetPassword = $('resetPassword');
const resetConfirm = $('resetConfirm');
const resetBtn = $('resetBtn');
const resetError = $('resetError');
const resetSuccess = $('resetSuccess');
const gotoRegisterLink = $('gotoRegisterLink');
const gotoResetLink = $('gotoResetLink');
const gotoLoginFromRegister = $('gotoLoginFromRegister');
const gotoLoginFromReset = $('gotoLoginFromReset');

// 列表页
const modelGrid = $('modelGrid');
const skeletonLoading = $('skeletonLoading');
const emptyState = $('emptyState');
const listErrorState = $('listErrorState');
const listErrorMessage = $('listErrorMessage');
const modelCount = $('modelCount');
const emptyNewBtn = $('emptyNewBtn');
const listRetryBtn = $('listRetryBtn');

// 上传页
const backFromUpload = $('backFromUpload');
const uploadZone = $('uploadZone');
const fileInput = $('fileInput');
const previewArea = $('previewArea');
const videoPreview = $('videoPreview');
const fileName = $('fileName');
const fileSize = $('fileSize');
const startBtn = $('startBtn');
const changeFileBtn = $('changeFileBtn');

const progressSection = $('progressSection');
const progressFill = $('progressFill');
const progressPercent = $('progressPercent');
const progressStatus = $('progressStatus');
const progressSpinner = $('progressSpinner');
const streamViewer = $('streamViewer');
const streamViewerContainer = $('streamViewerContainer');

const resultSection = $('resultSection');
const viewerContainer = $('viewerContainer');
const viewerPlaceholder = $('viewerPlaceholder');
const downloadBtn = $('downloadBtn');
const gotoDetailBtn = $('gotoDetailBtn');

// 详情页
const backFromDetail = $('backFromDetail');
const detailLoading = $('detailLoading');
const detailError = $('detailError');
const detailErrorTitle = $('detailErrorTitle');
const detailErrorMessage = $('detailErrorMessage');
const detailRetryBtn = $('detailRetryBtn');
const detailContent = $('detailContent');
const detailViewerContainer = $('detailViewerContainer');
const detailViewerPlaceholder = $('detailViewerPlaceholder');
const detailNameInput = $('detailNameInput');
const detailNameSaveBtn = $('detailNameSaveBtn');
const nameSavedHint = $('nameSavedHint');
const detailFileLabel = $('detailFileLabel');
const detailCreatedAt = $('detailCreatedAt');
const detailFileSize = $('detailFileSize');
const detailVideoSize = $('detailVideoSize');
const detailStatus = $('detailStatus');
const detailNotes = $('detailNotes');
const saveNotesBtn = $('saveNotesBtn');
const notesSavedHint = $('notesSavedHint');
const detailDownloadBtn = $('detailDownloadBtn');
const detailDeleteBtn = $('detailDeleteBtn');

// 删除弹窗
const deleteModal = $('deleteModal');
const confirmDeleteBtn = $('confirmDeleteBtn');
const cancelDeleteBtn = $('cancelDeleteBtn');

// Toast
const toast = $('toast');

// ── 状态 ──
let currentFile = null;
let currentTaskId = null;
let pollTimer = null;
let uploadViewer = null;      // viewer for result-after-upload
let detailViewer = null;      // viewer for detail page
let streamViewerInstance = null; // viewer for live streaming
let wsClient = null;          // WebSocket 连接
let pendingDeleteTaskId = null;
let busy = false;             // prevent double clicks

// ── 用户认证 ──
const AUTH_KEY = 'slam3r_user';

function getSavedUser() {
    try {
        return JSON.parse(localStorage.getItem(AUTH_KEY));
    } catch { return null; }
}

function saveUser(user) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
}

function clearUser() {
    localStorage.removeItem(AUTH_KEY);
}

function updateNavbarUser(user) {
    const displayName = user.nickname || user.username || '用户';
    navUsername.textContent = displayName;
    if (user.avatar_url) {
        navAvatar.src = user.avatar_url;
        navAvatar.style.display = 'block';
    } else {
        navAvatar.style.display = 'none';
    }
}

// ── 头像上传 ──

navAvatarWrap.addEventListener('click', () => {
    avatarInput.click();
});

avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;

    const user = getSavedUser();
    if (!user || !user.id) {
        showToast('请先登录', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('user_id', user.id);
    formData.append('avatar', file);

    try {
        const resp = await fetch(`${getApiBase()}/api/auth/avatar/upload`, {
            method: 'POST',
            body: formData,
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || '上传失败');

        // 更新保存的用户信息
        user.avatar_url = data.avatar_url;
        saveUser(user);
        navAvatar.src = data.avatar_url;
        navAvatar.style.display = 'block';
        showToast('头像已更新', 'success');
    } catch (err) {
        showToast('头像上传失败: ' + err.message, 'error');
    }
    avatarInput.value = '';
});

// ── 认证页面头像 ──

function resetAuthAvatar() {
    authAvatar.style.display = 'none';
    authAvatarPlaceholder.style.display = 'block';
}

// ── 工具函数 ──

function showToast(msg, type = 'info', duration = 3000) {
    toast.textContent = msg;
    toast.className = 'toast';
    if (type === 'error') toast.classList.add('error');
    if (type === 'success') toast.classList.add('success');
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

function formatSize(bytes) {
    if (bytes == null) return '未知';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getApiBase() {
    return window.location.origin;
}

function authHeaders() {
    const user = getSavedUser();
    const headers = { 'Content-Type': 'application/json' };
    if (user && user.token) {
        headers['Authorization'] = 'Bearer ' + user.token;
    }
    return headers;
}

function getAuthToken() {
    const user = getSavedUser();
    return user && user.token ? user.token : null;
}

function authFetch(url, options = {}) {
    const headers = options.headers || {};
    const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) {
        headers['Content-Type'] = 'application/json';
    }
    const user = getSavedUser();
    if (user && user.token) {
        headers['Authorization'] = 'Bearer ' + user.token;
    }
    return fetch(url, { ...options, headers });
}

// ── 视图切换 ──

function showView(viewName) {
    views.forEach(v => v.style.display = 'none');

    // 判断是否为认证页
    const isAuth = ['login', 'register', 'reset'].includes(viewName);
    const isApp = ['list', 'upload', 'detail'].includes(viewName);

    // 切换莫兰迪背景（仅认证页显示）
    if (authBg) authBg.classList.toggle('active', isAuth);
    if (authDecoDots) authDecoDots.classList.toggle('active', isAuth);
    if (appBg) appBg.classList.toggle('active', isApp);
    // 上传页使用独立的粉绿蓝紫背景
    if (uploadBg) uploadBg.classList.toggle('active', viewName === 'upload');
    if (mainContent) mainContent.style.display = isApp ? 'block' : 'none';

    // 认证页完全隐藏导航栏（整个 navbar）
    const navbar = document.getElementById('mainNav');
    if (navbar) navbar.style.display = isAuth ? 'none' : 'flex';
    navUserInfo.style.display = isAuth ? 'none' : 'flex';
    navNewBtn.style.display = isAuth ? 'none' : (isApp ? 'inline-flex' : 'none');

    // 显示/隐藏使用说明
    howToSection.style.display = (viewName === 'list') ? 'block' : 'none';

    switch (viewName) {
        case 'login':
            loginView.style.display = 'flex';
            resetAuthAvatar();
            break;
        case 'register':
            registerView.style.display = 'flex';
            resetAuthAvatar();
            break;
        case 'reset':
            resetView.style.display = 'flex';
            resetAuthAvatar();
            break;
        case 'list':
            listView.style.display = 'block';
            break;
        case 'upload':
            uploadView.style.display = 'block';
            break;
        case 'detail':
            detailView.style.display = 'block';
            break;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAppView(viewName, ...args) {
    navUserInfo.style.display = 'flex';
    navNewBtn.style.display = 'inline-flex';
    showView(viewName, ...args);
}

// ── 导航事件 ──

navHomeBtn.addEventListener('click', () => {
    goToList();
});

navNewBtn.addEventListener('click', () => {
    goToUpload();
});

navLogoutBtn.addEventListener('click', () => {
    clearUser();
    navUserInfo.style.display = 'none';
    navNewBtn.style.display = 'none';
    showView('login');
    showToast('已退出登录', 'info');
});

function goToList() {
    disposeDetailViewer();
    showAppView('list');
    loadModelList();
}

function goToUpload() {
    resetUploadView();
    showAppView('upload');
}

function goToDetail(taskId) {
    disposeDetailViewer();
    showAppView('detail');
    loadDetail(taskId);
}

// ── 认证页面导航 ──

function showLogin() {
    showView('login');
    clearAuthErrors();
    // 如果账号已填好（比如从注册跳过来），触发头像检查
    const u = loginUsername.value.trim();
    if (u) {
        authAvatar.style.display = 'none';
        authAvatarPlaceholder.style.display = 'block';
        // 触发检查
        setTimeout(async () => {
            try {
                const resp = await fetch(`${getApiBase()}/api/auth/check/${encodeURIComponent(u)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.exists && data.avatar_url) {
                        authAvatar.src = data.avatar_url;
                        authAvatar.style.display = 'block';
                        authAvatarPlaceholder.style.display = 'none';
                    }
                }
            } catch (_) {}
        }, 200);
    }
}
function showRegister() { showView('register'); clearAuthErrors(); }
function showReset() { showView('reset'); clearAuthErrors(); }

function clearAuthErrors() {
    loginError.style.display = 'none';
    registerError.style.display = 'none';
    resetError.style.display = 'none';
    resetSuccess.style.display = 'none';
}

gotoRegisterLink.addEventListener('click', showRegister);
gotoResetLink.addEventListener('click', showReset);
gotoLoginFromRegister.addEventListener('click', showLogin);
gotoLoginFromReset.addEventListener('click', showLogin);

// ── 返回链接 ──

backFromUpload.addEventListener('click', goToList);
backFromDetail.addEventListener('click', goToList);

// ── 登录事件 ──

loginBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    loginError.style.display = 'none';

    const username = loginUsername.value.trim();
    const password = loginPassword.value.trim();

    if (!username || !password) {
        loginError.textContent = '请输入账号和密码';
        loginError.style.display = 'block';
        busy = false;
        return;
    }

    try {
        const resp = await fetch(`${getApiBase()}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || '登录失败');

        // 保存 token
        if (data.token) {
            data.user.token = data.token;
        }
        saveUser(data.user);
        updateNavbarUser(data.user);
        showToast(`欢迎回来，${data.user.nickname || data.user.username}！`, 'success');
        goToList();
    } catch (err) {
        loginError.textContent = err.message;
        loginError.style.display = 'block';
    } finally {
        busy = false;
    }
});

// 回车登录
loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginBtn.click(); });
loginUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') loginPassword.focus(); });

// 输入账号时自动检查头像
let avatarCheckTimer = null;
loginUsername.addEventListener('input', () => {
    clearTimeout(avatarCheckTimer);
    const username = loginUsername.value.trim();
    if (!username) {
        authAvatar.style.display = 'none';
        authAvatarPlaceholder.style.display = 'block';
        return;
    }
    avatarCheckTimer = setTimeout(async () => {
        try {
            const resp = await fetch(`${getApiBase()}/api/auth/check/${encodeURIComponent(username)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.exists && data.avatar_url) {
                authAvatar.src = data.avatar_url;
                authAvatar.style.display = 'block';
                authAvatarPlaceholder.style.display = 'none';
                // 保存到当前会话用于后续操作
                if (window._loginUserAvatar !== data.avatar_url) {
                    window._loginUserAvatar = data.avatar_url;
                }
            } else {
                authAvatar.style.display = 'none';
                authAvatarPlaceholder.style.display = 'block';
                window._loginUserAvatar = null;
            }
        } catch (e) {
            // 静默失败
        }
    }, 300); // 300ms 防抖
});

// ── 注册事件 ──
let registerAvatarFile = null;  // 注册时预选的头像文件

// 注册页头像上传
regAvatarWrap.addEventListener('click', () => {
    regAvatarInput.click();
});

regAvatarInput.addEventListener('change', () => {
    const file = regAvatarInput.files[0];
    if (!file) return;
    // 预览
    const reader = new FileReader();
    reader.onload = (e) => {
        regAvatar.src = e.target.result;
        regAvatar.style.display = 'block';
        regAvatarPlaceholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
    registerAvatarFile = file;
});

registerBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    registerError.style.display = 'none';

    const nickname = registerNickname.value.trim();
    const username = registerUsername.value.trim();
    const password = registerPassword.value;
    const confirm = registerConfirm.value;

    if (!nickname) {
        registerError.textContent = '请输入用户名';
        registerError.style.display = 'block';
        busy = false;
        return;
    }
    if (!username || !password) {
        registerError.textContent = '请填写完整信息';
        registerError.style.display = 'block';
        busy = false;
        return;
    }
    if (password !== confirm) {
        registerError.textContent = '两次密码不一致';
        registerError.style.display = 'block';
        busy = false;
        return;
    }

    try {
        const resp = await fetch(`${getApiBase()}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, nickname }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || '注册失败');

        // 如果选了头像，注册成功后自动上传
        if (registerAvatarFile) {
            try {
                // 先登录拿到 user_id
                const loginResp = await fetch(`${getApiBase()}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                const loginData = await loginResp.json();
                if (loginResp.ok && loginData.user && loginData.user.id) {
                    const formData = new FormData();
                    formData.append('user_id', loginData.user.id);
                    formData.append('avatar', registerAvatarFile);
                    await fetch(`${getApiBase()}/api/auth/avatar/upload`, {
                        method: 'POST',
                        body: formData,
                    });
                }
            } catch (_) { /* 头像上传失败不影响注册结果 */ }
        }

        showToast('注册成功，请登录', 'success');
        // 清空注册表单
        registerAvatarFile = null;
        registerNickname.value = '';
        registerUsername.value = '';
        registerPassword.value = '';
        registerConfirm.value = '';
        regAvatar.style.display = 'none';
        regAvatarPlaceholder.style.display = 'block';
        // 跳到登录页，填好账号
        loginUsername.value = username;
        loginPassword.value = '';
        showLogin();
    } catch (err) {
        registerError.textContent = err.message;
        registerError.style.display = 'block';
    } finally {
        busy = false;
    }
});

// 回车注册
registerConfirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') registerBtn.click(); });

// ── 重置密码事件 ──

resetBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    resetError.style.display = 'none';
    resetSuccess.style.display = 'none';

    const username = resetUsername.value.trim();
    const newPassword = resetPassword.value;
    const confirm = resetConfirm.value;

    if (!username || !newPassword) {
        resetError.textContent = '请填写完整信息';
        resetError.style.display = 'block';
        busy = false;
        return;
    }
    if (newPassword !== confirm) {
        resetError.textContent = '两次密码不一致';
        resetError.style.display = 'block';
        busy = false;
        return;
    }

    try {
        const resp = await fetch(`${getApiBase()}/api/auth/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, new_password: newPassword }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || '重置失败');

        resetSuccess.textContent = '✅ 密码已重置，请用新密码登录';
        resetSuccess.style.display = 'block';
        resetPassword.value = '';
        resetConfirm.value = '';
        showToast('密码重置成功', 'success');
    } catch (err) {
        resetError.textContent = err.message;
        resetError.style.display = 'block';
    } finally {
        busy = false;
    }
});

// 回车重置
resetConfirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') resetBtn.click(); });

// ════════════════════════════════════════════════════════════
// 视图 1：模型列表
// ════════════════════════════════════════════════════════════

async function loadModelList() {
    skeletonLoading.style.display = 'block';
    emptyState.style.display = 'none';
    listErrorState.style.display = 'none';
    modelGrid.innerHTML = '';

    // 显示骨架卡
    for (let i = 0; i < 3; i++) {
        const sk = document.createElement('div');
        sk.className = 'skeleton-card';
        sk.innerHTML = `
            <div class="skeleton-thumb"></div>
            <div class="skeleton-info">
                <div class="skeleton-line w-70"></div>
                <div class="skeleton-line w-40"></div>
            </div>
        `;
        modelGrid.appendChild(sk);
    }

    try {
        const resp = await authFetch(`${getApiBase()}/api/models`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const models = await resp.json();
        modelGrid.innerHTML = '';

        if (!models || models.length === 0) {
            skeletonLoading.style.display = 'none';
            emptyState.style.display = 'block';
            modelCount.textContent = '';
            return;
        }

        skeletonLoading.style.display = 'none';
        modelCount.textContent = `共 ${models.length} 个模型`;

        models.forEach(m => {
            const card = document.createElement('div');
            card.className = 'model-card';
            card.dataset.taskId = m.task_id;

            // 缩略图或占位
            let thumbHtml;
            if (m.has_thumbnail) {
                thumbHtml = `<img class="model-card-thumb" src="${m.thumbnail_url}?t=${Date.now()}" alt="${m.original_filename}" loading="lazy">`;
            } else {
                thumbHtml = `<div class="model-card-thumb-placeholder">🏠</div>`;
            }

            const displayName = m.display_name || m.original_filename || `模型-${m.task_id}`;

            card.innerHTML = `
                ${thumbHtml}
                <div class="model-card-body">
                    <div class="model-card-title" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                    <div class="model-card-meta">${m.created_at || ''} · ${formatSize(m.file_size_bytes)}</div>
                </div>
                <button class="model-card-delete" data-task-id="${m.task_id}" title="删除">✕</button>
            `;

            // 点击卡片 → 详情
            card.addEventListener('click', (e) => {
                if (e.target.closest('.model-card-delete')) return;
                goToDetail(m.task_id);
            });

            // 删除按钮
            const delBtn = card.querySelector('.model-card-delete');
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openDeleteModal(m.task_id);
            });

            modelGrid.appendChild(card);
        });

    } catch (err) {
        console.error('加载模型列表失败:', err);
        skeletonLoading.style.display = 'none';
        listErrorState.style.display = 'block';
        listErrorMessage.textContent = `无法获取模型列表: ${err.message}`;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

emptyNewBtn.addEventListener('click', goToUpload);
listRetryBtn.addEventListener('click', loadModelList);

// ════════════════════════════════════════════════════════════
// 视图 2：上传 & 重建
// ════════════════════════════════════════════════════════════

// 点击上传区 = 触发文件选择
uploadZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') {
        fileInput.click();
    }
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

function handleFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
        showToast('请选择视频文件（mp4/mov/avi）', 'error');
        return;
    }

    currentFile = file;

    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    fileName.textContent = `📄 ${file.name}`;
    fileSize.textContent = formatSize(file.size);

    uploadZone.style.display = 'none';
    previewArea.style.display = 'block';

    showToast(`已选择: ${file.name}`, 'success');
}

changeFileBtn.addEventListener('click', () => {
    previewArea.style.display = 'none';
    uploadZone.style.display = 'block';
    videoPreview.src = '';
    URL.revokeObjectURL(videoPreview.src);
    currentFile = null;
    fileInput.value = '';
});

// ── 开始重建 ──

startBtn.addEventListener('click', async () => {
    if (!currentFile) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    if (busy) return;
    busy = true;

    if (currentFile.size > 500 * 1024 * 1024) {
        showToast('视频文件过大，建议压缩后上传（< 500MB）', 'error');
        busy = false;
        return;
    }

    // 先检查服务端是否已达上限
    try {
        const checkResp = await authFetch(`${getApiBase()}/api/models`);
        if (checkResp.ok) {
            const models = await checkResp.json();
            if (models && models.length >= 6) {
                showToast('模型数量已达上限（6 个），请删除旧的模型再创建新的', 'error');
                busy = false;
                return;
            }
        }
    } catch (_) { /* 如果检查失败，继续尝试上传，后端会二次验证 */ }

    // 切换到进度
    previewArea.style.display = 'none';
    uploadZone.style.display = 'none';
    resultSection.style.display = 'none';
    progressSection.style.display = 'block';
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    progressStatus.textContent = '正在上传...';
    progressSpinner.style.display = 'flex';

    const formData = new FormData();
    formData.append('video', currentFile);

    try {
        const headers = {};
        const token = getAuthToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const resp = await fetch(`${getApiBase()}/api/reconstruct`, {
            method: 'POST',
            headers,
            body: formData,
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `上传失败 (${resp.status})`);
        }

        const data = await resp.json();
        currentTaskId = data.task_id;

        showToast('上传成功，开始重建！', 'success');
        progressStatus.textContent = '任务已创建，正在处理...';

        startPolling(currentTaskId);

    } catch (err) {
        console.error('上传失败:', err);
        showToast(`上传失败: ${err.message}`, 'error');
        progressSpinner.style.display = 'none';
        progressStatus.textContent = `❌ ${err.message}`;

        setTimeout(() => {
            resetUploadView();
        }, 5000);
    } finally {
        busy = false;
    }
});

// ── 进度轮询 ──

function startWebSocket(taskId) {
    // 关闭旧连接
    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/${taskId}`;

    try {
        wsClient = new WebSocket(url);

        // 5 秒连接超时：连不上就放弃，不影响主流程
        const wsTimeout = setTimeout(() => {
            if (wsClient && wsClient.readyState !== WebSocket.OPEN) {
                console.warn('WebSocket 连接超时，跳过实时预览');
                wsClient.close();
                wsClient = null;
            }
        }, 5000);

        wsClient.onopen = () => {
            clearTimeout(wsTimeout);
            console.log('WebSocket 已连接:', taskId);
            // 显示流式预览容器
            streamViewerContainer.style.display = 'block';
            // 初始化流式 viewer（浅色背景，关闭自动旋转）
            if (!streamViewerInstance) {
                streamViewerInstance = new PointCloudViewer('streamViewer', {
                    bgColor: 0xf0eeeb,
                    autoRotate: false,
                });
            }
        };

        wsClient.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'points' && msg.positions && msg.positions.length > 0) {
                    if (streamViewerInstance) {
                        // 应用 YZ 翻转（与后端 save_model_to_glb 一致）
                        const flipped = msg.positions.map(p => [p[0], -p[1], -p[2]]);
                        streamViewerInstance.addPoints(flipped, msg.colors);
                    }
                }
            } catch (e) {
                // ignore parse errors
            }
        };

        wsClient.onerror = (err) => {
            clearTimeout(wsTimeout);
            console.warn('WebSocket 不可用（隧道不支持），继续轮询模式');
            wsClient = null;
        };

        wsClient.onclose = () => {
            clearTimeout(wsTimeout);
            console.log('WebSocket 已关闭');
            wsClient = null;
        };
    } catch (err) {
        console.error('WebSocket 连接失败:', err);
    }
}

function stopWebSocket() {
    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }
    // 清理流式 viewer
    if (streamViewerInstance) {
        streamViewerInstance.dispose();
        streamViewerInstance = null;
    }
    streamViewerContainer.style.display = 'none';
}

function startPolling(taskId) {
    if (pollTimer) clearInterval(pollTimer);

    // 启动 WebSocket 流式推送
    startWebSocket(taskId);

    pollTimer = setInterval(async () => {
        try {
            const resp = await fetch(`${getApiBase()}/api/status/${taskId}`);
            if (!resp.ok) throw new Error('查询状态失败');

            const data = await resp.json();

            const pct = data.progress || 0;
            progressFill.style.width = `${pct}%`;
            progressPercent.textContent = `${pct}%`;
            progressStatus.textContent = data.message || '处理中...';

            if (data.status === 'completed') {
                clearInterval(pollTimer);
                pollTimer = null;
                await onTaskCompleted(taskId);
            } else if (data.status === 'failed') {
                clearInterval(pollTimer);
                pollTimer = null;
                onTaskFailed(data.error || '未知错误');
            }
        } catch (err) {
            console.error('轮询失败:', err);
        }
    }, 2000);
}

// ── 任务完成 ──

async function onTaskCompleted(taskId) {
    // 关闭 WebSocket 和流式 viewer
    stopWebSocket();

    progressSpinner.style.display = 'none';
    progressStatus.textContent = '🎉 重建完成！正在准备预览...';
    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';

    // 短暂展示结果预览，然后跳转到详情页
    await new Promise(resolve => setTimeout(resolve, 800));

    progressSection.style.display = 'none';
    resultSection.style.display = 'block';

    const dlUrl = `${getApiBase()}/api/result/${taskId}`;

    // 初始化上传结果区的 viewer（浅色）
    if (!uploadViewer) {
        uploadViewer = new PointCloudViewer('viewerContainer', {
            bgColor: 0xf0eeeb,
            autoRotate: true,
        });
    }

    viewerPlaceholder.style.display = 'flex';
    viewerPlaceholder.innerHTML = '<div class="spinner"></div><span>加载模型中...</span>';

    // 设置下载按钮
    downloadBtn.href = dlUrl;

    // 加载模型
    try {
        await uploadViewer.loadModel(dlUrl);
        showToast('模型加载完成！', 'success');
    } catch (err) {
        console.error('模型加载失败:', err);
        viewerPlaceholder.innerHTML = '<span style="color:#ef4444;">❌ 模型加载失败</span>';
    }
}

// 跳转到详情页
gotoDetailBtn.addEventListener('click', () => {
    if (currentTaskId) {
        goToDetail(currentTaskId);
    }
});

// ── 任务失败 ──

function onTaskFailed(error) {
    stopWebSocket();
    progressSpinner.style.display = 'none';
    // 如果是 ffmpeg 缺失的错误（含换行符），用 <pre> 显示多行
    const isMultiLine = error.includes('\n') || error.includes('ffmpeg');
    if (isMultiLine) {
        progressStatus.innerHTML = `<div class="error-detail">❌ 重建失败</div><pre class="error-tech">${escapeHtml(error)}</pre>`;
    } else {
        progressStatus.textContent = `❌ ${error}`;
    }
    showToast(`重建失败`, 'error', 6000);

    // 失败后不自动重置，让用户能看到错误信息
    // 显示一个"重新上传"按钮
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-primary reset-btn';
    retryBtn.textContent = '🔄 重新上传';
    retryBtn.addEventListener('click', resetUploadView);
    const existing = progressSection.querySelector('.reset-btn');
    if (existing) existing.remove();
    progressSection.querySelector('.progress-card').appendChild(retryBtn);
}

function resetUploadView() {
    stopWebSocket();
    resultSection.style.display = 'none';
    progressSection.style.display = 'none';
    previewArea.style.display = 'none';
    uploadZone.style.display = 'block';
    videoPreview.src = '';
    currentFile = null;
    currentTaskId = null;
    fileInput.value = '';

    if (uploadViewer) {
        uploadViewer.dispose();
        uploadViewer = null;
    }
}

// ════════════════════════════════════════════════════════════
// 视图 3：模型详情
// ════════════════════════════════════════════════════════════

async function loadDetail(taskId) {
    // 存储 task_id 供其他函数使用
    detailContent.dataset.taskId = taskId;

    detailLoading.style.display = 'flex';
    detailError.style.display = 'none';
    detailContent.style.display = 'none';

    try {
        const resp = await authFetch(`${getApiBase()}/api/models/${taskId}`);
        if (!resp.ok) {
            if (resp.status === 404) throw new Error('模型不存在');
            throw new Error(`HTTP ${resp.status}`);
        }

        const model = await resp.json();

        // 显示名称（可编辑）
        detailNameInput.value = model.display_name || model.original_filename || `模型-${taskId}`;
        detailFileLabel.textContent = model.original_filename ? `源文件: ${model.original_filename}` : '';
        nameSavedHint.style.display = 'none';

        // 填充元数据
        detailCreatedAt.textContent = model.created_at || '未知';
        detailFileSize.textContent = formatSize(model.file_size_bytes);
        detailVideoSize.textContent = model.video_size_mb ? `${model.video_size_mb} MB` : '未知';
        detailStatus.textContent = model.status === 'completed' ? '已完成' : (model.status || '未知');

        // 备注
        detailNotes.value = model.notes || '';
        notesSavedHint.style.display = 'none';

        // 下载
        detailDownloadBtn.href = `${getApiBase()}/api/result/${taskId}`;

        // 显示内容
        detailLoading.style.display = 'none';
        detailContent.style.display = 'flex';

        // 初始化 3D 查看器（浅色）
        if (!detailViewer) {
            detailViewer = new PointCloudViewer('detailViewerContainer', {
                bgColor: 0xf0eeeb,
                autoRotate: true,
            });
        }

        detailViewerPlaceholder.style.display = 'flex';
        detailViewerPlaceholder.innerHTML = '<div class="spinner"></div><span>加载模型中...</span>';

        try {
            await detailViewer.loadModel(`${getApiBase()}/api/result/${taskId}`);
        } catch (err) {
            console.error('详情页模型加载失败:', err);
            detailViewerPlaceholder.innerHTML = '<span style="color:#ef4444;">❌ 模型加载失败，请尝试下载后本地查看</span>';
        }

    } catch (err) {
        console.error('加载详情失败:', err);
        detailLoading.style.display = 'none';
        detailError.style.display = 'flex';
        detailErrorTitle.textContent = '加载失败';
        detailErrorMessage.textContent = err.message || '无法获取模型信息';
    }
}

function disposeDetailViewer() {
    if (detailViewer) {
        detailViewer.dispose();
        detailViewer = null;
    }
}

detailRetryBtn.addEventListener('click', () => {
    const taskId = detailContent.dataset.taskId;
    if (taskId) loadDetail(taskId);
});

// ── 保存备注 ──

saveNotesBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;

    // 获取 task_id 从当前详情的 URL
    // 这里我们从 detailFileName 关联的 task_id 获取
    // 更好的做法：从 detailContent dataset 获取
    const taskId = detailContent.dataset.taskId;
    if (!taskId) {
        showToast('无法获取模型 ID', 'error');
        busy = false;
        return;
    }

    const notes = detailNotes.value.trim();

    try {
        const resp = await authFetch(`${getApiBase()}/api/models/${taskId}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes }),
        });

        if (!resp.ok) throw new Error('保存失败');

        notesSavedHint.style.display = 'inline';
        setTimeout(() => { notesSavedHint.style.display = 'none'; }, 2000);
        showToast('备注已保存', 'success');
    } catch (err) {
        console.error('保存备注失败:', err);
        showToast('保存备注失败: ' + err.message, 'error');
    } finally {
        busy = false;
    }
});

// ── 保存模型名称 ──

detailNameSaveBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;

    const taskId = detailContent.dataset.taskId;
    if (!taskId) {
        showToast('无法获取模型 ID', 'error');
        busy = false;
        return;
    }

    const name = detailNameInput.value.trim();
    if (!name) {
        showToast('名称不能为空', 'error');
        busy = false;
        return;
    }

    try {
        const resp = await authFetch(`${getApiBase()}/api/models/${taskId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });

        if (!resp.ok) throw new Error('保存失败');

        nameSavedHint.style.display = 'inline';
        setTimeout(() => { nameSavedHint.style.display = 'none'; }, 2000);
        showToast('名称已保存', 'success');

        // 如果当前在列表页，刷新列表更新卡片名称
        if (listView.style.display === 'block') {
            loadModelList();
        }
    } catch (err) {
        console.error('保存名称失败:', err);
        showToast('保存名称失败: ' + err.message, 'error');
    } finally {
        busy = false;
    }
});

// 回车键保存名称
detailNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        detailNameSaveBtn.click();
    }
});

// ── 删除模型 ──

function openDeleteModal(taskId) {
    pendingDeleteTaskId = taskId;
    deleteModal.style.display = 'flex';
}

function closeDeleteModal() {
    deleteModal.style.display = 'none';
    pendingDeleteTaskId = null;
}

cancelDeleteBtn.addEventListener('click', closeDeleteModal);

// 点击遮罩关闭
deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) closeDeleteModal();
});

confirmDeleteBtn.addEventListener('click', async () => {
    const taskId = pendingDeleteTaskId;
    if (!taskId) return;
    if (busy) return;

    busy = true;
    confirmDeleteBtn.textContent = '删除中...';
    confirmDeleteBtn.disabled = true;

    try {
        const resp = await authFetch(`${getApiBase()}/api/models/${taskId}`, {
            method: 'DELETE',
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || '删除失败');
        }

        showToast('模型已删除', 'success');
        closeDeleteModal();

        // 如果当前在详情页且删的就是当前模型，返回列表
        if (detailContent.style.display !== 'none' && detailContent.dataset.taskId === taskId) {
            goToList();
        } else {
            // 刷新列表
            loadModelList();
        }

    } catch (err) {
        console.error('删除失败:', err);
        showToast('删除失败: ' + err.message, 'error');
    } finally {
        busy = false;
        confirmDeleteBtn.textContent = '🗑️ 确认删除';
        confirmDeleteBtn.disabled = false;
    }
});

// ── 详情页删除按钮 ──

detailDeleteBtn.addEventListener('click', () => {
    const taskId = detailContent.dataset.taskId;
    if (taskId) openDeleteModal(taskId);
});

// ════════════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // 始终先显示登录页
    // 用户登录后才会进入应用主界面
    showView('login');
    setTimeout(() => loginUsername.focus(), 300);
});


