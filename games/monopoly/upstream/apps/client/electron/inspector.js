// inspector.js - GameProcess Inspector
const { ipcRenderer } = require('electron');
let currentState = null;
let autoRefresh = false;
let autoTimer = null;
let activeTab = 'overview';
// Track expanded paths: Set of JSON path strings like "players.0.modifiers.1"
const expandedPaths = new Set();
// GM 操作日志
const gmOperationLog = [];
// 渲染去重：上次渲染的状态哈希和标签页
let lastRenderedHash = '';
let lastRenderedTab = '';

// 计算状态快速哈希（用于跳过无变化渲染）
function hashState(state) {
    if (!state) return '空';
    const p = state.players || [];
    const playersStr = p.map(x => x.id + ':' + (x.money ?? '') + ':' + (x.positionIndex ?? '')).join(',');
    const propsStr = (state.properties || []).map(x => x.id + ':' + (x.owner?.userId ?? '_')).join(',');
    return state.currentRound + '|' + playersStr + '|' + propsStr + '|' + (state.gameLogList?.length ?? 0) + '|' + (state.currentEventName ?? '');
}
const content = document.getElementById('content');
const status = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');
const autoBtn = document.getElementById('autoBtn');
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        searchBar.classList.toggle('visible', activeTab === 'raw');
        lastRenderedHash = '';
        render();
    });
});
refreshBtn.addEventListener('click', () => fetchState(true));
autoBtn.addEventListener('click', () => {
    autoRefresh = !autoRefresh;
    autoBtn.textContent = autoRefresh ? '自动: ON' : '自动: OFF';
    autoBtn.classList.toggle('active', autoRefresh);
    if (autoRefresh) { autoTimer = setInterval(fetchState, 2000); }
    else { clearInterval(autoTimer); autoTimer = null; }
});
searchInput.addEventListener('input', () => { lastRenderedHash = ''; render(); });
async function fetchState(forceRender) {
    status.textContent = '获取中...';
    status.className = 'status';
    try {
        const result = await ipcRenderer.invoke('inspector:get-state');
        if (result && result.__error) {
            status.textContent = result.__error;
            status.className = 'status err';
            currentState = null;
            lastRenderedHash = '';
            render();
            return;
        }
        currentState = result;
        status.textContent = '回合 ' + (result ? result.currentRound : '?');
        status.className = 'status ok';
        if (forceRender) lastRenderedHash = '';
        render();
    } catch (e) {
        status.textContent = '错误: ' + e.message;
        status.className = 'status err';
    }
}
function render() {
    if (!currentState) { content.textContent = '无数据。开始游戏后点击刷新。'; return; }

    // 去重：状态未变且同一 tab，跳过渲染（仅更新状态栏）
    const newHash = hashState(currentState);
    if (newHash === lastRenderedHash && activeTab === lastRenderedTab) {
        return;
    }
    lastRenderedHash = newHash;
    lastRenderedTab = activeTab;

    // 保存滚动位置和输入焦点
    const scrollTop = content.scrollTop;
    const activeEl = document.activeElement;
    const focusedId = (activeEl && activeEl.id) ? activeEl.id : null;
    const focusedSelection = (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA'))
        ? { start: activeEl.selectionStart, end: activeEl.selectionEnd } : null;

    switch (activeTab) {
        case 'overview': renderOverview(); break;
        case 'players': renderCards(currentState.players, 'player'); break;
        case 'properties': renderCards(currentState.properties, 'property'); break;
        case 'events': renderEvents(); break;
        case 'logs': renderLogs(); break;
        case 'raw': renderRaw(); break;
        case 'gm': renderGMControl(); break;
    }

    // 恢复滚动位置
    content.scrollTop = scrollTop;
    // 恢复输入焦点和光标位置
    if (focusedId) {
        const el = document.getElementById(focusedId);
        if (el) {
            el.focus();
            if (focusedSelection && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                try { el.setSelectionRange(focusedSelection.start, focusedSelection.end); } catch (_) {}
            }
        }
    }
}
function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function renderOverview() {
    const s = currentState;
    const cards = [
        ['当前回合', s.currentRound],
        ['倍率', s.currentMultiplier],
        ['当前玩家', s.currentRoundPlayer || '-'],
        ['当前阶段', s.currentGamePhase || '-'],
        ['当前事件', s.currentEventName || '-'],
        ['游戏结束', String(s.isGameOver)],
        ['运行栈', s.gameRuntimeStack.stackSize + ' 事件' + (s.gameRuntimeStack.isRunning ? ' (运行中)' : '')],
        ['玩家', String(s.players.length)],
        ['地产', String(s.properties.length)],
        ['地图事件', String(s.mapEvents.length)],
        ['日志条目', String(s.gameLogList.length)],
        ['排名', s.rankedPlayerIds.length > 0 ? s.rankedPlayerIds.join(', ') : '-'],
    ];
    let html = '';
    for (const [label, value] of cards) {
        html += '<div class="overview-card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(String(value)) + '</div></div>';
    }
    html += '<h3>游戏设置</h3><table><thead><tr><th>键</th><th>标签</th><th>值</th><th>显示</th></tr></thead><tbody>';
    for (const [key, val] of Object.entries(s.gameSetting || {})) {
        html += '<tr><td>' + esc(key) + '</td><td>' + esc(String(val.label)) + '</td><td>' + esc(String(val.value)) + '</td><td>' + esc(String(val.displayValue)) + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '<h3>自定义数据</h3><pre>' + esc(JSON.stringify(s.customData, null, 2)) + '</pre>';
    html += '<h3>导出数据</h3><pre>' + esc(JSON.stringify(s.exportData, null, 2)) + '</pre>';
    content.innerHTML = html;
}
function renderTable(items) {
    if (!items || items.length === 0) { content.textContent = '无数据'; return; }
    const keys = [...new Set(items.flatMap(o => Object.keys(o)))];
    let html = '<table><thead><tr>';
    for (const k of keys) html += '<th>' + esc(k) + '</th>';
    html += '</tr></thead><tbody>';
    for (const p of items) {
        html += '<tr>';
        for (const k of keys) {
            const v = p[k]; const txt = v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
            html += '<td>' + esc(txt) + '</td>';
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    content.innerHTML = html;
}
// Render items as cards with nested object support
function renderCards(items, type) {
    if (!items || items.length === 0) { content.textContent = '无' + type + '数据'; return; }
    let html = '<div class="cards-container">';
    for (const item of items) {
        // Get primary identifier (try id, name, or first key)
        const idKey = Object.keys(item).find(k => k === 'id' || k === 'name' || k === 'playerId');
        const title = idKey ? (item[idKey] || '未知') : ('项 ' + items.indexOf(item));
        const titleKey = idKey || 'item';

        html += '<div class="data-card">';
        html += '<div class="card-header"><span class="card-title">' + esc(String(title)) + '</span></div>';
        html += '<div class="card-body">';

        // Display all fields
        for (const [key, val] of Object.entries(item)) {
            if (key === idKey) continue; // Skip title field
            html += renderField(key, val, 0, titleKey + '.' + key);
        }

        html += '</div></div>';
    }
    html += '</div>';
    content.innerHTML = html;

    // Attach toggle listeners after rendering (only to new triggers)
    attachToggleListeners();

    // Expand nodes that were previously expanded
    restoreExpandedState();
}
// Render a single field (handles nested objects)
// path: JSON path string for tracking expand state
function renderField(key, val, depth, path) {
    const showKey = key !== '';
    const keyHtml = showKey ? '<span class="field-key">' + esc(key) + ':</span> ' : '';

    if (val === null || val === undefined) {
        return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="null">null</span></div>';
    }
    if (typeof val === 'boolean') {
        return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="bool-' + val + '">' + val + '</span></div>';
    }
    if (typeof val === 'number') {
        return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="num">' + val + '</span></div>';
    }
    if (typeof val === 'string') {
        return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="val">"' + esc(val) + '"</span></div>';
    }
    if (Array.isArray(val)) {
        if (val.length === 0) {
            return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="text-dim">[]</span></div>';
        }
        const childId = 'child-' + Math.random().toString(36).substr(2, 9);
        const isExpanded = expandedPaths.has(path);
        // Store JSON data as base64 to avoid encoding issues
        const jsonB64 = btoa(unescape(encodeURIComponent(JSON.stringify(val))));
        let html = '<div class="field-group collapsible" style="padding-left:' + (depth * 12) + 'px">';
        html += '<div class="toggle-trigger" data-target="' + childId + '" data-path="' + esc(path) + '">';
        html += '<span class="arrow">' + (isExpanded ? '▼' : '▶') + '</span>';
        if (showKey) html += '<span class="field-key">' + esc(key) + ':</span> ';
        html += '<span class="text-dim">数组(' + val.length + ')</span>';
        html += '</div>';
        html += '<div class="nested' + (isExpanded ? '' : ' hidden') + '" id="' + childId + '" data-json="' + esc(jsonB64) + '"></div>';
        html += '</div>';
        return html;
    }
    if (typeof val === 'object') {
        const keys = Object.keys(val);
        if (keys.length === 0) {
            return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + '<span class="text-dim">{}</span></div>';
        }
        const childId = 'child-' + Math.random().toString(36).substr(2, 9);
        const isExpanded = expandedPaths.has(path);
        // Store JSON data as base64 to avoid encoding issues
        const jsonB64 = btoa(unescape(encodeURIComponent(JSON.stringify(val))));
        let html = '<div class="field-group collapsible" style="padding-left:' + (depth * 12) + 'px">';
        html += '<div class="toggle-trigger" data-target="' + childId + '" data-path="' + esc(path) + '">';
        html += '<span class="arrow">' + (isExpanded ? '▼' : '▶') + '</span>';
        if (showKey) html += '<span class="field-key">' + esc(key) + ':</span> ';
        html += '<span class="text-dim">对象 {' + keys.length + '}</span>';
        html += '</div>';
        html += '<div class="nested' + (isExpanded ? '' : ' hidden') + '" id="' + childId + '" data-json="' + esc(jsonB64) + '"></div>';
        html += '</div>';
        return html;
    }
    return '<div class="field" style="padding-left:' + (depth * 12) + 'px">' + keyHtml + esc(String(val)) + '</div>';
}
// Attach click listeners to toggle triggers (only to unbound triggers)
function attachToggleListeners() {
    document.querySelectorAll('.toggle-trigger:not([data-bound])').forEach(trigger => {
        trigger.setAttribute('data-bound', 'true');
        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            const targetId = this.getAttribute('data-target');
            const target = document.getElementById(targetId);
            const path = this.getAttribute('data-path');
            const arrow = this.querySelector('.arrow');

            if (!target) return;

            if (target.classList.contains('hidden')) {
                // Expand - render children
                target.classList.remove('hidden');
                arrow.textContent = '▼';
                if (path) expandedPaths.add(path);

                // Only render if not already rendered
                if (!target.hasAttribute('data-rendered')) {
                    try {
                        const jsonB64 = target.getAttribute('data-json');
                        const jsonStr = decodeURIComponent(escape(atob(jsonB64)));
                        const val = JSON.parse(jsonStr);
                        let html = '';
                        if (Array.isArray(val)) {
                            for (let i = 0; i < val.length; i++) {
                                html += '<div class="nested-item">' + renderField('', val[i], 1, path + '[' + i + ']') + '</div>';
                            }
                        } else {
                            for (const [k, v] of Object.entries(val)) {
                                html += '<div class="nested-item">' + renderField(k, v, 1, path + '.' + k) + '</div>';
                            }
                        }
                        target.innerHTML = html;
                        target.setAttribute('data-rendered', 'true');

                        // Attach listeners to newly created triggers
                        attachToggleListeners();
                    } catch (err) {
                        target.innerHTML = '<div class="null">错误: ' + esc(err.message) + '</div>';
                        console.error('展开错误:', err);
                    }
                }
            } else {
                // Collapse
                target.classList.add('hidden');
                arrow.textContent = '▶';
                if (path) expandedPaths.delete(path);
            }
        });
    });
}
// Restore expanded state from expandedPaths set
function restoreExpandedState() {
    expandedPaths.forEach(path => {
        // Find the trigger with matching data-path
        const trigger = document.querySelector('.toggle-trigger[data-path="' + esc(path).replace(/"/g, '\\"') + '"]');
        if (!trigger) return;
        const targetId = trigger.getAttribute('data-target');
        const target = document.getElementById(targetId);
        if (!target || target.hasAttribute('data-rendered')) return;
        // Render the content
        try {
            const jsonB64 = target.getAttribute('data-json');
            const jsonStr = decodeURIComponent(escape(atob(jsonB64)));
            const val = JSON.parse(jsonStr);
            let html = '';
            if (Array.isArray(val)) {
                for (let i = 0; i < val.length; i++) {
                    html += '<div class="nested-item">' + renderField('', val[i], 1, path + '[' + i + ']') + '</div>';
                }
            } else {
                for (const [k, v] of Object.entries(val)) {
                    html += '<div class="nested-item">' + renderField(k, v, 1, path + '.' + k) + '</div>';
                }
            }
            target.innerHTML = html;
            target.setAttribute('data-rendered', 'true');
            // Attach listeners to newly created triggers
            attachToggleListeners();
        } catch (err) {
            console.error('恢复展开状态错误:', err);
        }
    });
}
function renderEvents() {
    const s = currentState; let html = '';
    html += '<h3>运行栈</h3><p>大小: ' + s.gameRuntimeStack.stackSize + ' | 运行中: ' + s.gameRuntimeStack.isRunning + '</p>';
    const events = s.mapEvents || [];
    html += '<h3>地图事件 (' + events.length + ')</h3>';
    if (events.length) {
        html += '<table><thead><tr><th>ID</th><th>名称</th><th>类型</th></tr></thead><tbody>';
        for (const [id, evt] of events) html += '<tr><td>' + esc(id) + '</td><td>' + esc(String(evt.name || '-')) + '</td><td>' + esc(String(evt.type || '-')) + '</td></tr>';
        html += '</tbody></table>';
    }
    const items = s.mapItems || [];
    html += '<h3>地图项 (' + items.length + ')</h3>';
    if (items.length) {
        html += '<table><thead><tr><th>ID</th><th>名称</th><th>索引</th></tr></thead><tbody>';
        for (const [id, item] of items) html += '<tr><td>' + esc(id) + '</td><td>' + esc(String(item.name || '-')) + '</td><td>' + esc(String(item.index ?? '-')) + '</td></tr>';
        html += '</tbody></table>';
    }
    content.innerHTML = html;
}
function renderLogs() {
    const logs = currentState.gameLogList || [];
    if (logs.length === 0) { content.textContent = '暂无日志'; return; }
    let html = '<table><thead><tr><th>时间</th><th>内容</th></tr></thead><tbody>';
    for (const log of logs) {
        const t = log.time != null ? (log.time / 1000).toFixed(1) + 's' : '-';
        html += '<tr><td>' + esc(t) + '</td><td>' + esc(log.content || '-') + '</td></tr>';
    }
    html += '</tbody></table>';
    content.innerHTML = html;
    content.scrollTop = content.scrollHeight;
}
function renderRaw() {
    const filter = searchInput.value.toLowerCase();
    let json = JSON.stringify(currentState, null, 2);
    if (filter) { json = json.split('\n').filter(l => l.toLowerCase().includes(filter)).join('\n'); }
    content.innerHTML = '<pre>' + esc(json) + '</pre>';
}
// Close button - use IPC instead of getFocusedWindow()
document.getElementById('closeBtn').addEventListener('click', () => {
    ipcRenderer.send('close-inspector');
});

// ========== GM Control Functions ==========

// 生成 GM Action ID
function generateActionId() {
    return 'gm-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// 格式化时间
function formatLogTime() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}

// 记录 GM 操作日志
function logGMOperation(action, response) {
    const entry = {
        time: formatLogTime(),
        action: action.type,
        detail: '',
        success: response.success,
        error: response.error,
    };

    switch (action.type) {
        case 'setMoney':
            entry.detail = `玩家${action.payload.playerId} ${action.payload.operation} ${action.payload.amount}`;
            if (response.success) {
                entry.detail += ` → ${response.data.newMoney}`;
            }
            break;
        case 'addChanceCard':
            entry.detail = `卡片${action.payload.cardId} → 玩家${action.payload.targetPlayerId}`;
            if (response.success) {
                entry.detail = `"${response.data.cardName}" → ${response.data.targetPlayerName}`;
            }
            break;
        case 'setPropertyOwner':
            entry.detail = `地皮${action.payload.propertyId} → 主人${action.payload.newOwnerId || '无主'}`;
            if (response.success) {
                entry.detail = `"${response.data.propertyName}" 从 ${response.data.oldOwner || '无主'} → ${response.data.newOwner || '无主'}`;
            }
            break;
    }

    gmOperationLog.unshift(entry);
    // 只保留最近 50 条
    if (gmOperationLog.length > 50) {
        gmOperationLog.pop();
    }
    renderGMLog();
}

function renderGMControl() {
    if (!currentState) {
        content.textContent = '无数据。开始游戏后点击刷新。';
        return;
    }

    // 保存当前选中值（防止 auto refresh 重置下拉框）
    const savedValues = {};
    const selectIds = ['gm-money-player', 'gm-card-select', 'gm-card-player', 'gm-prop-select', 'gm-prop-owner'];
    for (const id of selectIds) {
        const el = document.getElementById(id);
        if (el) savedValues[id] = el.value;
    }
    const moneyAmount = document.getElementById('gm-money-amount');
    const savedMoneyAmount = moneyAmount ? moneyAmount.value : '';

    const getPlayerName = (p) => p.user?.username || '未知';

    let html = '';

    // 修改金钱区域
    html += '<div class="gm-section">';
    html += '<div class="gm-section-title">修改金钱</div>';
    html += '<div class="gm-form-row">';
    html += '<label>玩家</label>';
    html += '<select id="gm-money-player" class="gm-select"><option value="">选择玩家</option>';
    for (const p of currentState.players) {
        html += '<option value="' + esc(p.id) + '">' + esc(getPlayerName(p)) + ' ($' + (p.money ?? '?') + ')</option>';
    }
    html += '</select></div>';
    html += '<div class="gm-form-row"><label>快捷</label><div class="gm-quick-btns">';
    html += '<button class="gm-btn gm-quick-btn" data-amount="1000" data-op="add">+1000</button>';
    html += '<button class="gm-btn gm-quick-btn" data-amount="5000" data-op="add">+5000</button>';
    html += '<button class="gm-btn gm-quick-btn" data-amount="10000" data-op="add">+10000</button>';
    html += '<button class="gm-btn gm-quick-btn" data-amount="-1000" data-op="add">-1000</button>';
    html += '<button class="gm-btn gm-quick-btn" data-amount="999999" data-op="set">无限</button>';
    html += '</div></div>';
    html += '<div class="gm-form-row">';
    html += '<label>自定义</label>';
    html += '<input type="number" id="gm-money-amount" class="gm-input" placeholder="金额" style="width: 80px;">';
    html += '<button class="gm-btn" id="gm-money-set">设置</button>';
    html += '<button class="gm-btn" id="gm-money-add">增加</button>';
    html += '<button class="gm-btn" id="gm-money-sub">减少</button>';
    html += '</div></div>';

    // 添加手牌区域
    html += '<div class="gm-section">';
    html += '<div class="gm-section-title">添加手牌（机会卡）</div>';
    html += '<div class="gm-form-row">';
    html += '<label>卡片</label>';
    html += '<select id="gm-card-select" class="gm-select"><option value="">选择卡片</option>';
    for (const [id, card] of currentState.chanceCardInfos) {
        html += '<option value="' + esc(id) + '">' + esc(card.name) + '</option>';
    }
    html += '</select></div>';
    html += '<div class="gm-form-row">';
    html += '<label>玩家</label>';
    html += '<select id="gm-card-player" class="gm-select"><option value="">选择玩家</option>';
    for (const p of currentState.players) {
        html += '<option value="' + esc(p.id) + '">' + esc(getPlayerName(p)) + '</option>';
    }
    html += '</select></div>';
    html += '<div class="gm-form-row">';
    html += '<button class="gm-btn" id="gm-card-add">添加卡片</button>';
    html += '</div></div>';

    // 修改地皮主人区域
    html += '<div class="gm-section">';
    html += '<div class="gm-section-title">修改地皮主人</div>';
    html += '<div class="gm-form-row">';
    html += '<label>地皮</label>';
    html += '<select id="gm-prop-select" class="gm-select"><option value="">选择地皮</option>';
    for (const p of currentState.properties) {
        const ownerName = p.owner?.username || '无主';
        html += '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (当前: ' + esc(ownerName) + ')</option>';
    }
    html += '</select></div>';
    html += '<div class="gm-form-row">';
    html += '<label>新主人</label>';
    html += '<select id="gm-prop-owner" class="gm-select">';
    html += '<option value="">无主</option>';
    for (const pl of currentState.players) {
        html += '<option value="' + esc(pl.id) + '">' + esc(getPlayerName(pl)) + '</option>';
    }
    html += '</select></div>';
    html += '<div class="gm-form-row">';
    html += '<button class="gm-btn" id="gm-prop-set">设置主人</button>';
    html += '</div></div>';

    // 操作日志区域
    html += '<div class="gm-section">';
    html += '<div class="gm-section-title">操作日志</div>';
    html += '<div id="gm-log" class="gm-log">';
    html += renderGMLogEntries();
    html += '</div></div>';

    content.innerHTML = html;

    // 恢复之前选中的值
    for (const id of selectIds) {
        if (savedValues[id]) {
            const el = document.getElementById(id);
            if (el) el.value = savedValues[id];
        }
    }
    if (savedMoneyAmount) {
        const el = document.getElementById('gm-money-amount');
        if (el) el.value = savedMoneyAmount;
    }

    attachGMListeners();
}

function renderGMLogEntries() {
    if (gmOperationLog.length === 0) {
        return '<div class="gm-log-entry" style="color: var(--text-dim);">暂无操作记录</div>';
    }
    let logHtml = '';
    for (const entry of gmOperationLog) {
        const statusClass = entry.success ? 'gm-log-success' : 'gm-log-error';
        const statusIcon = entry.success ? '✓' : '✗';
        logHtml += '<div class="gm-log-entry">';
        logHtml += '<span class="gm-log-time">[' + entry.time + ']</span> ';
        logHtml += '<span class="' + statusClass + '">' + statusIcon + '</span> ';
        logHtml += '<span>' + esc(entry.detail) + '</span>';
        logHtml += '</div>';
    }
    return logHtml;
}

function renderGMLog() {
    const logContainer = document.getElementById('gm-log');
    if (logContainer) {
        logContainer.innerHTML = renderGMLogEntries();
    }
}

function attachGMListeners() {
    // 快捷金额按钮
    document.querySelectorAll('[data-amount]').forEach(btn => {
        btn.addEventListener('click', async function() {
            const playerId = document.getElementById('gm-money-player').value;
            const amount = parseInt(this.getAttribute('data-amount'));
            const op = this.getAttribute('data-op');

            if (!playerId) {
                alert('请选择玩家');
                return;
            }

            const action = {
                id: generateActionId(),
                timestamp: Date.now(),
                type: 'setMoney',
                payload: {
                    playerId: playerId,
                    operation: op,
                    amount: amount,
                },
            };

            await submitGMAction(action);
        });
    });

    // 自定义金额按钮
    document.getElementById('gm-money-set').addEventListener('click', async () => {
        handleCustomMoney('set');
    });
    document.getElementById('gm-money-add').addEventListener('click', async () => {
        handleCustomMoney('add');
    });
    document.getElementById('gm-money-sub').addEventListener('click', async () => {
        handleCustomMoney('subtract');
    });

    // 添加卡片按钮
    document.getElementById('gm-card-add').addEventListener('click', async () => {
        const cardId = document.getElementById('gm-card-select').value;
        const playerId = document.getElementById('gm-card-player').value;

        if (!cardId || !playerId) {
            alert('请选择卡片和玩家');
            return;
        }

        const action = {
            id: generateActionId(),
            timestamp: Date.now(),
            type: 'addChanceCard',
            payload: {
                cardId: cardId,
                targetPlayerId: playerId,
            },
        };

        await submitGMAction(action);
    });

    // 设置地皮主人按钮
    document.getElementById('gm-prop-set').addEventListener('click', async () => {
        const propertyId = document.getElementById('gm-prop-select').value;
        const newOwnerId = document.getElementById('gm-prop-owner').value || null;

        if (!propertyId) {
            alert('请选择地皮');
            return;
        }

        const action = {
            id: generateActionId(),
            timestamp: Date.now(),
            type: 'setPropertyOwner',
            payload: {
                propertyId: propertyId,
                newOwnerId: newOwnerId,
            },
        };

        await submitGMAction(action);
    });
}

async function handleCustomMoney(operation) {
    const playerId = document.getElementById('gm-money-player').value;
    const amountInput = document.getElementById('gm-money-amount');
    const amount = parseInt(amountInput.value);

    if (!playerId) {
        alert('请选择玩家');
        return;
    }

    if (isNaN(amount)) {
        alert('请输入有效金额');
        return;
    }

    const action = {
        id: generateActionId(),
        timestamp: Date.now(),
        type: 'setMoney',
        payload: {
            playerId: playerId,
            operation: operation,
            amount: amount,
        },
    };

    await submitGMAction(action);
}

async function submitGMAction(action) {
    try {
        status.textContent = '执行 GM 操作中...';
        const response = await ipcRenderer.invoke('inspector:gm-action', action);
        logGMOperation(action, response);

        if (response.success) {
            status.textContent = 'GM 操作成功';
            status.className = 'status ok';
            // 自动刷新
            await fetchState();
        } else {
            status.textContent = 'GM 操作失败: ' + (response.error || '未知错误');
            status.className = 'status err';
        }
    } catch (e) {
        status.textContent = 'GM 操作错误: ' + e.message;
        status.className = 'status err';
        logGMOperation(action, { success: false, error: e.message });
    }
}

// ========== End GM Control Functions ==========

// Make toolbar draggable
document.querySelector('.toolbar').style['-webkit-app-region'] = 'drag';
document.querySelectorAll('.toolbar button').forEach(b => b.style['-webkit-app-region'] = 'no-drag');

fetchState();