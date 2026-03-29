/**
 * DaidaiBird Monitor Extension for SillyTavern
 *
 * 当上游 Custom URL 包含 "daidaibird" 时，自动从监控 API 获取各模型报错率，
 * 并在模型下拉列表中显示。传给上游的模型名保持不变。
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const extensionName = 'SillyTavern-DaidaiBird-Monitor';
const MONITOR_API = 'https://user.daidaibird.top/api/monitors/status';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟刷新一次报错率
const URL_KEYWORD = 'daidaibird';

let monitorData = new Map(); // modelName -> latestWeightedErrorRate
let pollTimer = null;
let isActive = false;
let isUpdating = false; // 防重入锁

/**
 * 从监控 API 获取数据并缓存
 */
async function fetchMonitorData() {
    try {
        const response = await fetch(MONITOR_API);
        if (!response.ok) {
            console.warn(`[DDB Monitor] API 请求失败: ${response.status}`);
            return false;
        }
        const data = await response.json();
        monitorData.clear();

        for (const monitor of data) {
            if (!monitor.modelName || !Array.isArray(monitor.history) || monitor.history.length === 0) {
                continue;
            }
            // 取最新一条历史记录的 weightedErrorRate
            const latest = monitor.history[0];
            const errorRate = typeof latest.weightedErrorRate === 'number' ? latest.weightedErrorRate : 0;

            // 存储原始 modelName（可能带 [标签] 前缀）
            monitorData.set(monitor.modelName, errorRate);

            // 同时存储去掉标签前缀的版本，方便匹配
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
 * 优先精确匹配，其次模糊匹配
 */
function findErrorRate(modelId) {
    // 精确匹配
    if (monitorData.has(modelId)) {
        return monitorData.get(modelId);
    }

    // 模糊匹配：遍历所有 key，看是否包含 modelId 或 modelId 包含 key
    for (const [name, rate] of monitorData) {
        const cleanName = name.replace(/^\[.*?\]\s*/, '');
        if (cleanName === modelId || modelId === cleanName) {
            return rate;
        }
        // 部分匹配 - 处理版本号差异等
        if (modelId.includes(cleanName) || cleanName.includes(modelId)) {
            return rate;
        }
    }

    return null;
}

/**
 * 格式化报错率显示文本
 */
function formatErrorRate(rate) {
    if (rate === 0) return '0%';
    return rate.toFixed(1) + '%';
}

/**
 * 更新模型下拉列表中的显示文本
 * 只修改 option 的显示文本(text)，不修改 value（确保传给 API 的是原始模型名）
 */
function updateModelSelectDisplay() {
    if (!isActive || monitorData.size === 0 || isUpdating) return;

    isUpdating = true;

    try {
        const selectors = [
            '.model_custom_select',
            '#model_custom_select',
        ];

        for (const selector of selectors) {
            const $select = $(selector);
            if (!$select.length) continue;

            $select.find('option').each(function () {
                const $option = $(this);
                const modelId = $option.val();
                if (!modelId) return;

                // value 就是原始模型名
                const originalText = modelId;

                const errorRate = findErrorRate(modelId);
                if (errorRate !== null) {
                    const rateText = formatErrorRate(errorRate);
                    const newText = `${originalText} [报错: ${rateText}]`;
                    // 只在文本不同时才更新，避免不必要的 DOM 操作
                    if ($option.text() !== newText) {
                        $option.text(newText);
                    }
                } else {
                    if ($option.text() !== originalText) {
                        $option.text(originalText);
                    }
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
 * 启动监控轮询
 */
async function startMonitoring() {
    if (isActive) return;
    isActive = true;
    console.log('[DDB Monitor] 检测到 DaidaiBird URL，启动监控');

    const success = await fetchMonitorData();
    if (success) {
        updateModelSelectDisplay();
    }

    // 设置定时轮询，每5分钟刷新一次
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
        if (!checkCustomUrl()) {
            stopMonitoring();
            return;
        }
        const ok = await fetchMonitorData();
        if (ok) updateModelSelectDisplay();
    }, POLL_INTERVAL_MS);
}

/**
 * 停止监控轮询
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
 * 初始化插件
 */
jQuery(async () => {
    const context = getContext();
    const { eventSource, event_types } = context;

    // 初始化扩展设置
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {
            enabled: true,
        };
    }

    // 监听 API source 变更（切换 API 类型时触发）
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, async () => {
        await new Promise(r => setTimeout(r, 2000));
        await checkAndToggle();
    });

    // 监听 "Connect" 按钮点击（模型列表在连接后刷新）
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

    // 延迟初始检查（兼容 APP_READY 不触发的情况）
    setTimeout(async () => {
        await checkAndToggle();
    }, 5000);

    console.log('[DDB Monitor] DaidaiBird 报错率监控插件已加载');
});
