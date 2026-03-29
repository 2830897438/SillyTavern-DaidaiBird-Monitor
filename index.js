/**
 * DaidaiBird Monitor Extension for SillyTavern
 *
 * 当上游 Custom URL 包含 "daidaibird" 时，自动从监控 API 获取各模型报错率，
 * 并通过登录获取JWT后拉取模型定价信息，在模型下拉列表中显示。
 * 传给上游的模型名保持不变。
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const extensionName = 'SillyTavern-DaidaiBird-Monitor';
const MONITOR_API = 'https://user.daidaibird.top/api/monitors/status';
const LOGIN_API = 'https://user.daidaibird.top/api/users/login';
const PRICING_API = 'https://user.daidaibird.top/api/commodity/getPricing';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟刷新一次
const URL_KEYWORD = 'daidaibird';

let monitorData = new Map(); // modelName -> latestWeightedErrorRate
let pricingData = new Map(); // all_name -> { num, is_price, out_price, input_price, title, module, channelDesc }
let channelDescs = {}; // title -> description
let jwtToken = null;
let userInfo = null; // login 返回的用户信息
let pollTimer = null;
let isActive = false;
let isUpdating = false; // 防重入锁

/**
 * 获取默认设置
 */
function getDefaultSettings() {
    return {
        enabled: true,
        userEmail: '',
        password: '',
        showPrice: true,
        showErrorRate: true,
    };
}

/**
 * 登录获取 JWT
 */
async function login() {
    const settings = extension_settings[extensionName];
    if (!settings.userEmail || !settings.password) {
        console.warn('[DDB Monitor] 未配置邮箱或密码，跳过登录');
        return false;
    }

    try {
        const response = await fetch(LOGIN_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userEmail: settings.userEmail,
                password: settings.password,
            }),
        });

        if (!response.ok) {
            console.warn(`[DDB Monitor] 登录请求失败: ${response.status}`);
            return false;
        }

        const data = await response.json();
        if (data.code === 200 && data.token) {
            jwtToken = data.token;
            userInfo = data.msg;
            console.log('[DDB Monitor] 登录成功');
            return true;
        } else {
            console.warn('[DDB Monitor] 登录失败:', data);
            return false;
        }
    } catch (err) {
        console.error('[DDB Monitor] 登录异常:', err);
        return false;
    }
}

/**
 * 获取模型定价信息
 */
async function fetchPricingData() {
    if (!jwtToken || !userInfo) {
        console.warn('[DDB Monitor] 无JWT或用户信息，跳过定价获取');
        return false;
    }

    try {
        const response = await fetch(PRICING_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwtToken}`,
            },
            body: JSON.stringify(userInfo),
        });

        if (!response.ok) {
            // JWT 可能过期，尝试重新登录
            if (response.status === 401 || response.status === 403) {
                console.log('[DDB Monitor] JWT过期，重新登录...');
                const loggedIn = await login();
                if (loggedIn) {
                    return await fetchPricingData();
                }
            }
            console.warn(`[DDB Monitor] 定价请求失败: ${response.status}`);
            return false;
        }

        const data = await response.json();
        if (data.code === 200 && data.msg && data.msg.list) {
            pricingData.clear();

            // 存储渠道描述
            if (data.msg.channelDescs) {
                channelDescs = data.msg.channelDescs;
            }

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

            console.log(`[DDB Monitor] 已加载 ${pricingData.size} 个模型的定价数据`);
            return true;
        } else {
            console.warn('[DDB Monitor] 定价数据格式异常:', data);
            return false;
        }
    } catch (err) {
        console.error('[DDB Monitor] 获取定价数据失败:', err);
        return false;
    }
}

/**
 * 从监控 API 获取报错率数据
 */
async function fetchMonitorData() {
    try {
        const response = await fetch(MONITOR_API);
        if (!response.ok) {
            console.warn(`[DDB Monitor] 监控API请求失败: ${response.status}`);
            return false;
        }
        const data = await response.json();
        monitorData.clear();

        for (const monitor of data) {
            if (!monitor.modelName || !Array.isArray(monitor.history) || monitor.history.length === 0) {
                continue;
            }
            const latest = monitor.history[0];
            const errorRate = typeof latest.weightedErrorRate === 'number' ? latest.weightedErrorRate : 0;
            monitorData.set(monitor.modelName, errorRate);

            const cleanName = monitor.modelName.replace(/^\[.*?\]\s*/, '');
            if (cleanName !== monitor.modelName) {
                monitorData.set(cleanName, errorRate);
            }
        }

        console.log(`[DDB Monitor] 已加载 ${monitorData.size} 个模型的报错率数据`);
        return true;
    } catch (err) {
        console.error('[DDB Monitor] 获取监控数据失败:', err);
        return false;
    }
}

/**
 * 查找模型对应的报错率
 */
function findErrorRate(modelId) {
    if (monitorData.has(modelId)) {
        return monitorData.get(modelId);
    }

    for (const [name, rate] of monitorData) {
        const cleanName = name.replace(/^\[.*?\]\s*/, '');
        if (cleanName === modelId || modelId === cleanName) {
            return rate;
        }
        if (modelId.includes(cleanName) || cleanName.includes(modelId)) {
            return rate;
        }
    }

    return null;
}

/**
 * 查找模型对应的定价信息
 */
function findPricing(modelId) {
    // 精确匹配 all_name
    if (pricingData.has(modelId)) {
        return pricingData.get(modelId);
    }

    // 遍历查找包含关系
    for (const [allName, info] of pricingData) {
        if (allName === modelId) {
            return info;
        }
    }

    return null;
}

/**
 * 格式化可用率（100% - 报错率）
 */
function formatAvailability(errorRate) {
    const availability = 100 - errorRate;
    if (availability >= 100) return '100%';
    return availability.toFixed(1) + '%';
}

/**
 * 格式化价格显示
 */
function formatPrice(pricing) {
    if (!pricing) return '';

    const num = parseFloat(pricing.num);
    if (pricing.is_price === '1' || pricing.is_price === 1) {
        // 固定价格模式：num 是每次调用的倍率
        if (num > 0) {
            return `¥${num}/次`;
        }
        return '';
    } else {
        // 按量计费模式
        if (pricing.out_price && parseFloat(pricing.out_price) > 0) {
            return `出:$${pricing.out_price}/入:$${pricing.input_price}`;
        }
        return '';
    }
}

/**
 * 更新模型下拉列表中的显示文本
 */
function updateModelSelectDisplay() {
    if (!isActive || isUpdating) return;

    const settings = extension_settings[extensionName];
    const hasMonitor = monitorData.size > 0 && settings.showErrorRate;
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

                // 添加价格信息
                if (hasPricing) {
                    const pricing = findPricing(modelId);
                    if (pricing) {
                        const priceText = formatPrice(pricing);
                        if (priceText) {
                            parts.push(priceText);
                        }
                    }
                }

                // 添加报错率信息
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

/**
 * 检查当前 Custom URL 是否包含 daidaibird
 */
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
    } catch (e) {
        console.warn('[DDB Monitor] 检查 URL 失败:', e);
    }
    return false;
}

/**
 * 获取所有数据（监控 + 登录 + 定价）
 */
async function fetchAllData() {
    const results = await Promise.allSettled([
        fetchMonitorData(),
        (async () => {
            // 先登录，再获取定价
            const settings = extension_settings[extensionName];
            if (settings.userEmail && settings.password) {
                if (!jwtToken) {
                    await login();
                }
                if (jwtToken) {
                    await fetchPricingData();
                }
            }
        })(),
    ]);

    return results.some(r => r.status === 'fulfilled' && r.value !== false);
}

/**
 * 启动监控
 */
async function startMonitoring() {
    if (isActive) return;
    isActive = true;
    console.log('[DDB Monitor] 检测到 DaidaiBird URL，启动监控');

    await fetchAllData();
    updateModelSelectDisplay();

    // 设置定时轮询，每5分钟刷新一次
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        if (!checkCustomUrl()) {
            stopMonitoring();
            return;
        }
        await fetchAllData();
        updateModelSelectDisplay();
    }, POLL_INTERVAL_MS);
}

/**
 * 停止监控
 */
function stopMonitoring() {
    if (!isActive) return;
    isActive = false;
    console.log('[DDB Monitor] 停止监控');

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    monitorData.clear();
    pricingData.clear();

    // 还原模型列表显示
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

/**
 * 检查并决定是否启动/停止监控
 */
async function checkAndToggle() {
    const shouldBeActive = checkCustomUrl();
    if (shouldBeActive && !isActive) {
        await startMonitoring();
    } else if (!shouldBeActive && isActive) {
        stopMonitoring();
    }
}

/**
 * 加载设置面板 HTML
 */
function getSettingsHtml() {
    const settings = extension_settings[extensionName];
    return `
    <div class="ddb-monitor-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>DaidaiBird Monitor</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="ddb-settings-group">
                    <label for="ddb_user_email">邮箱:</label>
                    <input id="ddb_user_email" type="text" class="text_pole" placeholder="your@email.com" value="${settings.userEmail || ''}" />
                </div>
                <div class="ddb-settings-group">
                    <label for="ddb_password">密码:</label>
                    <input id="ddb_password" type="password" class="text_pole" placeholder="密码" value="${settings.password || ''}" />
                </div>
                <div class="ddb-settings-group">
                    <label class="checkbox_label">
                        <input id="ddb_show_price" type="checkbox" ${settings.showPrice ? 'checked' : ''} />
                        <span>显示模型价格</span>
                    </label>
                </div>
                <div class="ddb-settings-group">
                    <label class="checkbox_label">
                        <input id="ddb_show_error_rate" type="checkbox" ${settings.showErrorRate ? 'checked' : ''} />
                        <span>显示可用率</span>
                    </label>
                </div>
                <div class="ddb-settings-group">
                    <input id="ddb_refresh_btn" class="menu_button" type="button" value="立即刷新数据" />
                    <span id="ddb_status_text" style="margin-left:10px;font-size:0.85em;color:#999;"></span>
                </div>
            </div>
        </div>
    </div>`;
}

/**
 * 初始化插件
 */
jQuery(async () => {
    const context = getContext();
    const { eventSource, event_types } = context;

    // 初始化扩展设置
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = getDefaultSettings();
    }
    // 确保所有字段存在
    const defaults = getDefaultSettings();
    for (const key of Object.keys(defaults)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaults[key];
        }
    }

    // 注入设置面板
    const settingsHtml = getSettingsHtml();
    $('#extensions_settings2').append(settingsHtml);

    // 绑定设置事件
    $('#ddb_user_email').on('change', function () {
        extension_settings[extensionName].userEmail = $(this).val().trim();
        jwtToken = null; // 清除旧token
        userInfo = null;
        saveSettingsDebounced();
    });

    $('#ddb_password').on('change', function () {
        extension_settings[extensionName].password = $(this).val().trim();
        jwtToken = null;
        userInfo = null;
        saveSettingsDebounced();
    });

    $('#ddb_show_price').on('change', function () {
        extension_settings[extensionName].showPrice = $(this).prop('checked');
        saveSettingsDebounced();
        if (isActive) updateModelSelectDisplay();
    });

    $('#ddb_show_error_rate').on('change', function () {
        extension_settings[extensionName].showErrorRate = $(this).prop('checked');
        saveSettingsDebounced();
        if (isActive) updateModelSelectDisplay();
    });

    $('#ddb_refresh_btn').on('click', async function () {
        const $btn = $(this);
        const $status = $('#ddb_status_text');
        $btn.prop('disabled', true);
        $status.text('刷新中...');

        jwtToken = null;
        userInfo = null;
        await fetchAllData();
        if (isActive) updateModelSelectDisplay();

        $status.text(`已刷新 (${new Date().toLocaleTimeString()})`);
        $btn.prop('disabled', false);
    });

    // 监听 API source 变更
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, async () => {
        await new Promise(r => setTimeout(r, 2000));
        await checkAndToggle();
    });

    // 监听 "Connect" 按钮点击
    $(document).on('click', '#api_button_openai', async () => {
        await new Promise(r => setTimeout(r, 3000));
        if (isActive) {
            updateModelSelectDisplay();
        } else {
            await checkAndToggle();
        }
    });

    // 监听 Custom URL 输入框变化
    $(document).on('change', '#custom_api_url_text', async () => {
        await new Promise(r => setTimeout(r, 500));
        await checkAndToggle();
    });

    // APP_READY 时进行初始检查
    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, async () => {
            await new Promise(r => setTimeout(r, 2000));
            await checkAndToggle();
        });
    }

    // 延迟初始检查
    setTimeout(async () => {
        await checkAndToggle();
    }, 5000);

    console.log('[DDB Monitor] DaidaiBird 报错率+定价监控插件已加载');
});
