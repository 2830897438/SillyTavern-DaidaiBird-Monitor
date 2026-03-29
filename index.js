/**
 * DaidaiBird Monitor Extension for SillyTavern
 *
 * 当上游 Custom URL 包含 "daidaibird" 时：
 * - 从监控 API 获取各模型可用率
 * - 登录后获取模型定价信息
 * - 获取账号下的 Key 列表，可选择自动填入
 * - 查询 Key 余额
 * 传给上游的模型名保持不变。
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { SECRET_KEYS, writeSecret } from '../../../secrets.js';

const extensionName = 'SillyTavern-DaidaiBird-Monitor';
const API_BASE = 'https://user.daidaibird.top';
const MONITOR_API = `${API_BASE}/api/monitors/status`;
const LOGIN_API = `${API_BASE}/api/users/login`;
const PRICING_API = `${API_BASE}/api/commodity/getPricing`;
const ORDERS_API = `${API_BASE}/api/general/orders`;
const KEY_QUOTA_API = `${API_BASE}/api/general/keyQuota`;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const URL_KEYWORD = 'daidaibird';

let monitorData = new Map();
let pricingData = new Map();
let channelDescs = {};
let jwtToken = null;
let userInfo = null;
let userKeys = []; // 用户的 API Key 列表
let pollTimer = null;
let isActive = false;
let isUpdating = false;

// ==================== 设置 ====================

function getDefaultSettings() {
    return {
        enabled: true,
        userEmail: '',
        password: '',
        showPrice: true,
        showAvailability: true,
        selectedKey: '',
    };
}

// ==================== API 调用 ====================

/**
 * 带 JWT 的通用 POST 请求
 */
async function apiPost(url, body, needAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (needAuth && jwtToken) {
        headers['Authorization'] = `Bearer ${jwtToken}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && needAuth) {
            // JWT 过期，尝试重新登录
            console.log('[DDB] JWT过期，重新登录...');
            const loggedIn = await login();
            if (loggedIn) {
                headers['Authorization'] = `Bearer ${jwtToken}`;
                const retry = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
                if (retry.ok) return await retry.json();
            }
        }
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

/**
 * 登录获取 JWT
 */
async function login() {
    const settings = extension_settings[extensionName];
    if (!settings.userEmail || !settings.password) return false;

    try {
        const response = await fetch(LOGIN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: settings.userEmail,
                password: settings.password,
            }),
        });

        if (!response.ok) return false;

        const data = await response.json();
        if (data.code === 200 && data.token) {
            jwtToken = data.token;
            userInfo = data.msg;
            console.log('[DDB] 登录成功');
            updateLoginStatus(true);
            return true;
        }
        updateLoginStatus(false, data.msg || '登录失败');
        return false;
    } catch (err) {
        console.error('[DDB] 登录异常:', err);
        updateLoginStatus(false, err.message);
        return false;
    }
}

/**
 * 获取报错率数据（无需认证）
 */
async function fetchMonitorData() {
    try {
        const response = await fetch(MONITOR_API);
        if (!response.ok) return false;
        const data = await response.json();
        monitorData.clear();

        for (const monitor of data) {
            if (!monitor.modelName || !Array.isArray(monitor.history) || monitor.history.length === 0) continue;
            const latest = monitor.history[0];
            const errorRate = typeof latest.weightedErrorRate === 'number' ? latest.weightedErrorRate : 0;
            monitorData.set(monitor.modelName, errorRate);

            const cleanName = monitor.modelName.replace(/^\[.*?\]\s*/, '');
            if (cleanName !== monitor.modelName) {
                monitorData.set(cleanName, errorRate);
            }
        }
        return true;
    } catch (err) {
        console.error('[DDB] 获取监控数据失败:', err);
        return false;
    }
}

/**
 * 获取定价信息
 */
async function fetchPricingData() {
    if (!jwtToken || !userInfo) return false;

    try {
        const data = await apiPost(PRICING_API, userInfo);
        if (data.code === 200 && data.msg && data.msg.list) {
            pricingData.clear();
            if (data.msg.channelDescs) channelDescs = data.msg.channelDescs;

            for (const item of data.msg.list) {
                if (!item.all_name) continue;
                pricingData.set(item.all_name, {
                    num: item.num,
                    is_price: item.is_price,
                    out_price: item.out_price,
                    input_price: item.input_price,
                    title: item.title,
                    module: item.module,
                    type: item.type,
                    price: item.price,
                });
            }
            return true;
        }
        return false;
    } catch (err) {
        console.error('[DDB] 获取定价失败:', err);
        return false;
    }
}

/**
 * 获取用户订单（提取 Key 列表）
 */
async function fetchUserKeys() {
    if (!jwtToken || !userInfo) return false;

    try {
        userKeys = [];
        let page = 1;
        const pageSize = 50;

        // 拉取所有订单页
        while (true) {
            const data = await apiPost(ORDERS_API, {
                userData: JSON.stringify({ userId: userInfo.userId }),
                page,
                pageSize,
            });

            if (data.code !== 200 || !Array.isArray(data.msg)) break;

            for (const order of data.msg) {
                if (order.key && typeof order.key === 'string' && order.key.startsWith('sk-')) {
                    // 避免重复
                    if (!userKeys.some(k => k.key === order.key)) {
                        userKeys.push({
                            key: order.key,
                            name: order.name || order.payPackage || '',
                            date: order.createdAt || order.date || '',
                        });
                    }
                }
            }

            const totalPages = data.totalPages || 1;
            if (page >= totalPages) break;
            page++;
        }

        console.log(`[DDB] 获取到 ${userKeys.length} 个 Key`);
        updateKeySelect();
        return true;
    } catch (err) {
        console.error('[DDB] 获取订单/Key失败:', err);
        return false;
    }
}

/**
 * 查询 Key 余额
 */
async function fetchKeyQuota(key) {
    if (!jwtToken || !userInfo || !key) return null;

    try {
        const data = await apiPost(KEY_QUOTA_API, {
            userData: JSON.stringify({ userId: userInfo.userId }),
            key,
        });

        if (data.code === 200 && data.msg) {
            return {
                balance: data.msg.balance || '0',
                utilised: data.msg.utilised || '0',
            };
        }
        return null;
    } catch (err) {
        console.error('[DDB] 查询余额失败:', err);
        return null;
    }
}

// ==================== 模型列表显示 ====================

function findErrorRate(modelId) {
    if (monitorData.has(modelId)) return monitorData.get(modelId);

    for (const [name, rate] of monitorData) {
        const cleanName = name.replace(/^\[.*?\]\s*/, '');
        if (cleanName === modelId) return rate;
        if (modelId.includes(cleanName) || cleanName.includes(modelId)) return rate;
    }
    return null;
}

function findPricing(modelId) {
    if (pricingData.has(modelId)) return pricingData.get(modelId);
    for (const [allName, info] of pricingData) {
        if (allName === modelId) return info;
    }
    return null;
}

function formatAvailability(errorRate) {
    const availability = 100 - errorRate;
    if (availability >= 100) return '100%';
    return availability.toFixed(1) + '%';
}

function formatPrice(pricing) {
    if (!pricing) return '';

    const num = parseFloat(pricing.num);
    const basePrice = parseFloat(pricing.price) || 0;

    if (pricing.is_price === '1' || pricing.is_price === 1) {
        // 固定价格：实际价格 = num × price
        if (num > 0 && basePrice > 0) {
            const realPrice = (num * basePrice).toFixed(2).replace(/\.?0+$/, '');
            return `￥${realPrice}/次`;
        }
        return '';
    } else {
        // 按量计费：￥入价/M | ￥出价/M
        const inPrice = parseFloat(pricing.input_price);
        const outPrice = parseFloat(pricing.out_price);
        if (outPrice > 0) {
            return `￥${pricing.input_price}/M | ￥${pricing.out_price}/M`;
        }
        return '';
    }
}

function updateModelSelectDisplay() {
    if (!isActive || isUpdating) return;

    const settings = extension_settings[extensionName];
    const hasMonitor = monitorData.size > 0 && settings.showAvailability;
    const hasPricing = pricingData.size > 0 && settings.showPrice;

    if (!hasMonitor && !hasPricing) return;

    isUpdating = true;

    try {
        const selectors = ['.model_custom_select', '#model_custom_select'];

        for (const selector of selectors) {
            const $select = $(selector);
            if (!$select.length) continue;

            $select.find('option').each(function () {
                const $option = $(this);
                const modelId = $option.val();
                if (!modelId) return;

                const parts = [modelId];

                if (hasPricing) {
                    const pricing = findPricing(modelId);
                    if (pricing) {
                        const priceText = formatPrice(pricing);
                        if (priceText) parts.push(priceText);
                    }
                }

                if (hasMonitor) {
                    const errorRate = findErrorRate(modelId);
                    if (errorRate !== null) {
                        parts.push(`可用:${formatAvailability(errorRate)}`);
                    }
                }

                const newText = parts.length > 1
                    ? `${parts[0]} [${parts.slice(1).join(' | ')}]`
                    : parts[0];

                if ($option.text() !== newText) {
                    $option.text(newText);
                }
            });
        }
    } finally {
        isUpdating = false;
    }
}

// ==================== UI 更新 ====================

function updateLoginStatus(success, errorMsg) {
    const $status = $('#ddb_login_status');
    if (!$status.length) return;

    if (success) {
        $status.text(`已登录: ${userInfo?.userEmail || ''}`).css('color', '#4caf50');
    } else {
        $status.text(errorMsg || '未登录').css('color', '#f44336');
    }
}

function updateKeySelect() {
    const $select = $('#ddb_key_select');
    if (!$select.length) return;

    const settings = extension_settings[extensionName];
    $select.empty();
    $select.append('<option value="">-- 选择 Key --</option>');

    for (const keyInfo of userKeys) {
        const shortKey = keyInfo.key.substring(0, 8) + '...' + keyInfo.key.substring(keyInfo.key.length - 6);
        const label = keyInfo.name ? `${shortKey} (${keyInfo.name})` : shortKey;
        const selected = settings.selectedKey === keyInfo.key ? 'selected' : '';
        $select.append(`<option value="${keyInfo.key}" ${selected}>${label}</option>`);
    }

    if (userKeys.length === 0) {
        $select.append('<option value="" disabled>暂无 Key</option>');
    }
}

async function updateQuotaDisplay(key) {
    const $quota = $('#ddb_key_quota');
    if (!$quota.length) return;

    if (!key) {
        $quota.text('');
        return;
    }

    $quota.text('查询中...');
    const quota = await fetchKeyQuota(key);
    if (quota) {
        $quota.html(`余额: <b style="color:#4caf50">￥${quota.balance}</b> | 已用: ￥${quota.utilised}`);
    } else {
        $quota.text('查询失败');
    }
}

/**
 * 将选中的 Key 填入 SillyTavern 的 API Key 输入框
 */
function applySelectedKey(key) {
    if (!key) return;

    // 尝试写入 SillyTavern 的 Custom API Key
    const $apiKeyInput = $('#api_key_custom');
    if ($apiKeyInput.length) {
        $apiKeyInput.val(key).trigger('change');
    }

    // 也尝试通过 writeSecret 写入（更可靠的方式）
    try {
        if (typeof writeSecret === 'function' && SECRET_KEYS && SECRET_KEYS.CUSTOM) {
            writeSecret(SECRET_KEYS.CUSTOM, key);
        }
    } catch (e) {
        console.warn('[DDB] writeSecret 失败，已通过输入框填入:', e);
    }

    console.log('[DDB] 已填入 API Key');
}

// ==================== 监控控制 ====================

function checkCustomUrl() {
    try {
        const customUrlInput = $('#custom_api_url_text');
        if (customUrlInput.length) {
            const url = customUrlInput.val();
            return url && url.toLowerCase().includes(URL_KEYWORD);
        }
        const oaiSettings = window.oai_settings;
        if (oaiSettings && oaiSettings.custom_url) {
            return oaiSettings.custom_url.toLowerCase().includes(URL_KEYWORD);
        }
    } catch (e) {}
    return false;
}

async function fetchAllData() {
    // 并行获取监控数据 + 登录&定价&Key
    await Promise.allSettled([
        fetchMonitorData(),
        (async () => {
            const settings = extension_settings[extensionName];
            if (settings.userEmail && settings.password) {
                if (!jwtToken) await login();
                if (jwtToken) {
                    await Promise.allSettled([
                        fetchPricingData(),
                        fetchUserKeys(),
                    ]);
                }
            }
        })(),
    ]);
}

async function startMonitoring() {
    if (isActive) return;
    isActive = true;
    console.log('[DDB] 启动监控');

    await fetchAllData();
    updateModelSelectDisplay();

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        if (!checkCustomUrl()) { stopMonitoring(); return; }
        await fetchAllData();
        updateModelSelectDisplay();
    }, POLL_INTERVAL_MS);
}

function stopMonitoring() {
    if (!isActive) return;
    isActive = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    monitorData.clear();
    pricingData.clear();

    isUpdating = true;
    try {
        const selectors = ['.model_custom_select', '#model_custom_select'];
        for (const selector of selectors) {
            $(selector).find('option').each(function () {
                const $option = $(this);
                const modelId = $option.val();
                if (modelId) $option.text(modelId);
            });
        }
    } finally {
        isUpdating = false;
    }
}

async function checkAndToggle() {
    const shouldBeActive = checkCustomUrl();
    if (shouldBeActive && !isActive) await startMonitoring();
    else if (!shouldBeActive && isActive) stopMonitoring();
}

// ==================== 设置面板 ====================

function getSettingsHtml() {
    const s = extension_settings[extensionName];
    return `
    <div class="ddb-monitor-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>DaidaiBird Monitor</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <hr>
                <h4>账号登录</h4>
                <div class="ddb-settings-group">
                    <label for="ddb_user_email">邮箱</label>
                    <input id="ddb_user_email" type="text" class="text_pole" placeholder="your@email.com" value="${s.userEmail || ''}" />
                </div>
                <div class="ddb-settings-group">
                    <label for="ddb_password">密码</label>
                    <input id="ddb_password" type="password" class="text_pole" placeholder="密码" value="${s.password || ''}" />
                </div>
                <div class="ddb-settings-group">
                    <input id="ddb_login_btn" class="menu_button" type="button" value="登录" />
                    <span id="ddb_login_status" style="margin-left:10px;font-size:0.85em;color:#999;">未登录</span>
                </div>

                <hr>
                <h4>API Key 管理</h4>
                <div class="ddb-settings-group">
                    <label for="ddb_key_select">选择 Key</label>
                    <select id="ddb_key_select" class="text_pole">
                        <option value="">-- 请先登录 --</option>
                    </select>
                </div>
                <div class="ddb-settings-group">
                    <input id="ddb_apply_key_btn" class="menu_button" type="button" value="使用此 Key" />
                    <input id="ddb_refresh_keys_btn" class="menu_button" type="button" value="刷新 Key 列表" style="margin-left:5px;" />
                </div>
                <div class="ddb-settings-group">
                    <span id="ddb_key_quota" style="font-size:0.9em;"></span>
                </div>

                <hr>
                <h4>模型列表显示</h4>
                <div class="ddb-settings-group">
                    <label class="checkbox_label">
                        <input id="ddb_show_price" type="checkbox" ${s.showPrice ? 'checked' : ''} />
                        <span>显示模型价格</span>
                    </label>
                </div>
                <div class="ddb-settings-group">
                    <label class="checkbox_label">
                        <input id="ddb_show_availability" type="checkbox" ${s.showAvailability ? 'checked' : ''} />
                        <span>显示可用率</span>
                    </label>
                </div>

                <hr>
                <div class="ddb-settings-group">
                    <input id="ddb_refresh_all_btn" class="menu_button" type="button" value="刷新全部数据" />
                    <span id="ddb_refresh_status" style="margin-left:10px;font-size:0.85em;color:#999;"></span>
                </div>
            </div>
        </div>
    </div>`;
}

// ==================== 初始化 ====================

jQuery(async () => {
    const context = getContext();
    const { eventSource, event_types } = context;

    // 初始化设置
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = getDefaultSettings();
    }
    const defaults = getDefaultSettings();
    for (const key of Object.keys(defaults)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaults[key];
        }
    }

    // 注入设置面板
    $('#extensions_settings2').append(getSettingsHtml());

    // === 账号登录 ===
    $('#ddb_user_email').on('change', function () {
        extension_settings[extensionName].userEmail = $(this).val().trim();
        jwtToken = null; userInfo = null;
        saveSettingsDebounced();
    });

    $('#ddb_password').on('change', function () {
        extension_settings[extensionName].password = $(this).val().trim();
        jwtToken = null; userInfo = null;
        saveSettingsDebounced();
    });

    $('#ddb_login_btn').on('click', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true).val('登录中...');
        jwtToken = null; userInfo = null;

        const ok = await login();
        if (ok) {
            await Promise.allSettled([fetchPricingData(), fetchUserKeys()]);
            if (isActive) updateModelSelectDisplay();
        }

        $btn.prop('disabled', false).val('登录');
    });

    // === Key 管理 ===
    $('#ddb_key_select').on('change', async function () {
        const key = $(this).val();
        extension_settings[extensionName].selectedKey = key;
        saveSettingsDebounced();
        await updateQuotaDisplay(key);
    });

    $('#ddb_apply_key_btn').on('click', function () {
        const key = $('#ddb_key_select').val();
        if (!key) {
            alert('请先选择一个 Key');
            return;
        }
        applySelectedKey(key);
        $('#ddb_refresh_status').text('Key 已填入').css('color', '#4caf50');
    });

    $('#ddb_refresh_keys_btn').on('click', async function () {
        const $btn = $(this);
        $btn.prop('disabled', true);
        if (!jwtToken) await login();
        if (jwtToken) await fetchUserKeys();
        $btn.prop('disabled', false);
    });

    // === 显示开关 ===
    $('#ddb_show_price').on('change', function () {
        extension_settings[extensionName].showPrice = $(this).prop('checked');
        saveSettingsDebounced();
        if (isActive) updateModelSelectDisplay();
    });

    $('#ddb_show_availability').on('change', function () {
        extension_settings[extensionName].showAvailability = $(this).prop('checked');
        saveSettingsDebounced();
        if (isActive) updateModelSelectDisplay();
    });

    // === 全部刷新 ===
    $('#ddb_refresh_all_btn').on('click', async function () {
        const $btn = $(this);
        const $status = $('#ddb_refresh_status');
        $btn.prop('disabled', true);
        $status.text('刷新中...').css('color', '#999');

        jwtToken = null; userInfo = null;
        await fetchAllData();
        if (isActive) updateModelSelectDisplay();

        // 刷新选中 Key 的余额
        const selectedKey = $('#ddb_key_select').val();
        if (selectedKey) await updateQuotaDisplay(selectedKey);

        $status.text(`已刷新 (${new Date().toLocaleTimeString()})`).css('color', '#4caf50');
        $btn.prop('disabled', false);
    });

    // === 事件监听 ===
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, async () => {
        await new Promise(r => setTimeout(r, 2000));
        await checkAndToggle();
    });

    $(document).on('click', '#api_button_openai', async () => {
        await new Promise(r => setTimeout(r, 3000));
        if (isActive) updateModelSelectDisplay();
        else await checkAndToggle();
    });

    $(document).on('change', '#custom_api_url_text', async () => {
        await new Promise(r => setTimeout(r, 500));
        await checkAndToggle();
    });

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, async () => {
            await new Promise(r => setTimeout(r, 2000));
            await checkAndToggle();
        });
    }

    setTimeout(async () => { await checkAndToggle(); }, 5000);

    console.log('[DDB] DaidaiBird Monitor 插件已加载');
});
