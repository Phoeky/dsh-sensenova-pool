/**
 * 浏览器半：在 DSH 的「设置」与「插件」页里渲染本插件的管理卡片。
 *
 * 为什么是这个文件形态
 * --------------------
 * DSH 的浏览器半不是普通 ESM，而是一个**全局工厂注册**：DSH 在 `<head>` 里注入
 * `window.__ModuleLoader__` 门面，脚本执行时只是登记一个 factory，真正的实例化由
 * 加载器按需完成。因此本文件必须：
 *
 *   1. 用 `window.__ModuleLoader__.load({ id, factory })` 包裹；
 *   2. `id` **必须**与 npm 包名逐字相同（DSH 用它把浏览器半挂到 Loader 行上）；
 *   3. 是**纯 JavaScript**（无 JSX、无 TypeScript）—— 加载器不做编译；
 *   4. 只 `require` 冻结表里提供的模块。这里只用 `react`，从而对宿主包的
 *      增删改名完全免疫（workbuddy / dshmarket 也是这么做的）。
 *
 * 槽位选择
 * --------
 * 1. `settings.section`（**一级设置分区**）—— 主入口。用户要求「key 管理页面在
 *    DSH 的设置里」，这就是设置侧栏里与「通用 / 模型 / 插件」并列的那一类分区，
 *    由 `@deepseek-ai/dsh-client-ui-settings` 声明，`ui-settings-general` 渲染。
 * 2. `plugins.bundle.config`（keyed，键 = npm 包名）—— 「插件」页里本 bundle 的
 *    详情卡片，保留原入口，用户不必猜。
 * 3. `settings.plugins.tab` —— 「内置插件」分区里的标签页，第三个入口。
 *
 * 一个必须遵守的宿主约束
 * ----------------------
 * **动态客户端包内不能使用浏览器定时器全局量**（`setTimeout` / `setInterval`
 * 在模块顶层会直接抛错）。因此本卡片不做轮询，只在挂载时与每次操作后刷新；
 * 需要等待的地方一律用 React 的 effect 与 Promise。
 */

window.__ModuleLoader__.load({
  id: 'dsh-sensenova-pool',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BUNDLE_NAME = 'dsh-sensenova-pool';
    const NS = 'dsh-sensenova-pool';
    const BASE = '/plugins/dsh-sensenova-pool';

    /** 写入类操作必须带的证明头（回环 Host 校验不足以证明调用方被授过权）。 */
    const ADMIN_HEADER = 'x-sensenova-pool-admin';

    // ------------------------------------------------------------------ 样式
    // 全部用宿主主题 token，跟随明暗主题，不硬编码颜色。

    const labelPrimary = 'var(--dsw-alias-label-primary)';
    const labelSecondary = 'var(--dsw-alias-label-secondary)';
    const labelTertiary = 'var(--dsw-alias-label-tertiary)';
    const borderL2 = 'var(--dsw-alias-border-l2)';
    const bgLayer1 = 'var(--dsw-alias-bg-layer-1)';
    const bgLayer2 = 'var(--dsw-alias-bg-layer-2)';

    const rootStyle = { display: 'flex', flexDirection: 'column', gap: 12, margin: 0, padding: 0 };
    const hintStyle = { margin: 0, fontSize: 13, lineHeight: '20px', color: labelTertiary };
    const areaStyle = {
      boxSizing: 'border-box',
      width: '100%',
      minHeight: 88,
      padding: '8px 10px',
      border: `1px solid ${borderL2}`,
      borderRadius: 8,
      background: bgLayer1,
      color: labelPrimary,
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      resize: 'vertical',
      outline: 'none',
    };
    const buttonStyle = {
      boxSizing: 'border-box',
      minHeight: 32,
      padding: '5px 14px',
      border: `1px solid ${borderL2}`,
      borderRadius: 16,
      background: bgLayer1,
      color: labelPrimary,
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    };
    const buttonPrimaryStyle = {
      ...buttonStyle,
      background: 'var(--dsw-alias-bg-module-platform)',
      fontWeight: 500,
    };
    const smallButtonStyle = { ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12 };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      border: `1px solid ${borderL2}`,
      borderRadius: 8,
      background: bgLayer2,
    };
    const listStyle = { display: 'flex', flexDirection: 'column', gap: 6, listStyle: 'none', margin: 0, padding: 0 };
    const codeStyle = {
      fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: 12,
      color: labelSecondary,
    };
    /** 分区块：一条细分割线把「接口 / Key / 模型」三块隔开。 */
    const blockStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      paddingTop: 16,
      borderTop: `1px solid ${borderL2}`,
    };
    const blockTitleStyle = { margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '22px', color: labelPrimary };
    /** 只读值框：可整段选中，方便手抄。 */
    const valueStyle = {
      ...codeStyle,
      flex: '1 1 260px',
      minWidth: 0,
      padding: '6px 8px',
      border: `1px solid ${borderL2}`,
      borderRadius: 6,
      background: bgLayer1,
      color: labelPrimary,
      wordBreak: 'break-all',
      userSelect: 'all',
    };
    const pageTitleStyle = { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: labelPrimary };

    /** 状态徽标：颜色区分健康 / 冷却 / 失效。 */
    const badgeStyle = (status) => {
      const tone =
        status === 'healthy'
          ? { fg: 'var(--dsw-alias-label-success, #2ea043)', bg: 'var(--dsw-alias-bg-success, rgba(46,160,67,.12))' }
          : status === 'cooldown'
            ? { fg: 'var(--dsw-alias-label-warning, #bf8700)', bg: 'var(--dsw-alias-bg-warning, rgba(191,135,0,.12))' }
            : { fg: 'var(--dsw-alias-label-danger, #cf222e)', bg: 'var(--dsw-alias-bg-danger, rgba(207,34,46,.12))' };
      return {
        flex: '0 0 auto',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 11,
        lineHeight: '18px',
        color: tone.fg,
        background: tone.bg,
      };
    };

    // -------------------------------------------------------------- 网络访问

    async function getJson(path) {
      const response = await fetch(path, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error((value && value.error) || `HTTP ${response.status}`);
      return value;
    }

    async function postJson(path, body, adminKey) {
      const headers = { 'Content-Type': 'application/json', accept: 'application/json' };
      if (adminKey) headers[ADMIN_HEADER] = adminKey;
      const response = await fetch(path, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error((value && value.error) || `HTTP ${response.status}`);
      return value;
    }

    /**
     * 复制到剪贴板。
     *
     * `navigator.clipboard` 在 `dsh-app://` 这类自定义协议下不一定可用（安全上下文
     * 判定因宿主而异），因此保留 `execCommand` 兜底 —— 它虽然过时，但在 Electron
     * 渲染进程里一直有效。
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // 落到下面的兜底。
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    // ------------------------------------------------------------------ 卡片

    /**
     * 管理卡片：对外接口 + Key 池 + 模型可见性。
     *
     * @param props.t 文案读取器（宿主 locale 绑定）。
     * @param props.variant 'section' 时渲染页面标题（设置分区里需要），'card' 时不渲染。
     */
    function KeyCard({ t, variant }) {
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [keys, setKeys] = React.useState([]);
      const [summary, setSummary] = React.useState(undefined);
      const [catalog, setCatalog] = React.useState(undefined);
      const [models, setModels] = React.useState([]);
      const [endpoint, setEndpoint] = React.useState(undefined);
      const [adminKey, setAdminKey] = React.useState(undefined);
      const [tested, setTested] = React.useState({});
      const [copied, setCopied] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          const status = await getJson(`${BASE}/status`);
          if (status && Array.isArray(status.keys)) setKeys(status.keys);
          if (status) {
            setSummary(status.summary);
            setCatalog(status.catalog);
            if (Array.isArray(status.models)) setModels(status.models);
            if (status.endpoint) setEndpoint(status.endpoint);
            if (typeof status.adminKey === 'string') setAdminKey(status.adminKey);
          }
          setError(undefined);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      /** 统一的操作包装：置忙、清提示、失败落到 error 而不是抛出。 */
      const run = React.useCallback(
        async (label, work) => {
          setBusy(true);
          setNotice(undefined);
          try {
            const message = await work();
            setNotice(message);
            await load();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        },
        [load],
      );

      const addKeys = () =>
        run('add', async () => {
          const value = await postJson(`${BASE}/keys`, { action: 'add', keys: draft }, adminKey);
          setDraft('');
          const parts = [t('added', { added: String(value.added) })];
          if (value.duplicate > 0) parts.push(t('duplicate', { duplicate: String(value.duplicate) }));
          return parts.join('，');
        });

      const removeKey = (id) =>
        run('remove', async () => {
          await postJson(`${BASE}/keys`, { action: 'remove', id }, adminKey);
          return t('removed');
        });

      const clearKeys = () =>
        run('clear', async () => {
          await postJson(`${BASE}/keys`, { action: 'clear' }, adminKey);
          return t('cleared');
        });

      const refreshCatalog = () =>
        run('refresh', async () => {
          const value = await postJson(`${BASE}/keys`, { action: 'refresh-catalog' }, adminKey);
          return t('catalogRefreshed', { count: String(value?.catalog?.count ?? 0) });
        });

      const testKey = (id) =>
        run('test', async () => {
          const value = await postJson(`${BASE}/test`, { id }, adminKey);
          setTested((previous) => ({ ...previous, [id]: value }));
          return value.ok ? t('testOk', { ms: String(value.latencyMs) }) : t('testFail', { message: String(value.message).slice(0, 80) });
        });

      const toggleModel = (id, enabled) =>
        run('model', async () => {
          await postJson(`${BASE}/keys`, { action: 'set-model', id, enabled }, adminKey);
          return enabled ? t('modelShown', { id }) : t('modelHidden', { id });
        });

      const copy = async (field, text) => {
        const ok = await copyText(text);
        setCopied(ok ? field : '');
        setNotice(ok ? t('copied') : undefined);
        if (!ok) setError(t('copyFailed'));
      };

      const canSave = !busy && draft.trim() !== '';
      const enabledCount = models.filter((model) => model.enabled).length;
      const endpointReady = endpoint !== undefined && typeof endpoint.baseUrl === 'string' && endpoint.baseUrl !== '';

      return h('div', { style: rootStyle }, [
        variant === 'section' ? h('h2', { key: 'title', style: pageTitleStyle }, t('nav')) : null,
        h('p', { key: 'hint', style: hintStyle }, t('hint')),

        summary
          ? h(
              'div',
              { key: 'summary', style: { display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: labelSecondary } },
              [
                h('span', { key: 'total' }, t('sumTotal', { n: String(summary.total) })),
                h('span', { key: 'healthy' }, t('sumHealthy', { n: String(summary.healthy) })),
                h('span', { key: 'cooling' }, t('sumCooling', { n: String(summary.cooldown) })),
                h('span', { key: 'invalid' }, t('sumInvalid', { n: String(summary.invalid) })),
                catalog
                  ? h('span', { key: 'catalog' }, t('sumCatalog', { source: catalog.source, count: String(catalog.count) }))
                  : null,
              ],
            )
          : null,

        // ---- 对外接口：地址 / 端口 / API Key ------------------------------
        h('div', { key: 'endpoint', style: blockStyle }, [
          h('h3', { key: 'title', style: blockTitleStyle }, t('endpointTitle')),
          h('p', { key: 'hint', style: hintStyle }, t('endpointHint')),

          endpointReady
            ? h('div', { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                h('div', { key: 'url', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                  h('span', { key: 'label', style: { ...codeStyle, flex: '0 0 84px', color: labelTertiary } }, t('endpointUrl')),
                  h('code', { key: 'value', style: valueStyle }, endpoint.baseUrl),
                  h(
                    'button',
                    {
                      key: 'copy',
                      type: 'button',
                      style: smallButtonStyle,
                      disabled: busy,
                      onClick: () => copy('url', endpoint.baseUrl),
                    },
                    copied === 'url' ? t('copied') : t('copy'),
                  ),
                ]),
                h('div', { key: 'key', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
                  h('span', { key: 'label', style: { ...codeStyle, flex: '0 0 84px', color: labelTertiary } }, t('endpointKey')),
                  h('code', { key: 'value', style: valueStyle }, endpoint.apiKey || '—'),
                  h(
                    'button',
                    {
                      key: 'copy',
                      type: 'button',
                      style: smallButtonStyle,
                      disabled: busy || !endpoint.apiKey,
                      onClick: () => copy('key', endpoint.apiKey),
                    },
                    copied === 'key' ? t('copied') : t('copy'),
                  ),
                ]),
              ])
            : h('p', { key: 'down', style: { ...hintStyle, color: 'var(--dsw-alias-label-warning, #bf8700)' } }, t('endpointDown')),
        ]),

        // ---- Key 池 -------------------------------------------------------
        h('div', { key: 'pool', style: blockStyle }, [
          h('h3', { key: 'title', style: blockTitleStyle }, t('keysTitle')),
          h('textarea', {
            key: 'draft',
            style: areaStyle,
            value: draft,
            spellCheck: false,
            rows: 3,
            placeholder: t('placeholder'),
            onChange: (event) => {
              setDraft(event.target.value);
            },
          }),
          h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } }, [
            h(
              'button',
              {
                key: 'save',
                type: 'button',
                style: canSave ? buttonPrimaryStyle : { ...buttonPrimaryStyle, opacity: 0.5, cursor: 'default' },
                disabled: !canSave,
                onClick: addKeys,
              },
              busy ? t('working') : t('save'),
            ),
            h('button', { key: 'refresh', type: 'button', style: buttonStyle, disabled: busy, onClick: refreshCatalog }, t('refreshCatalog')),
            keys.length > 0
              ? h('button', { key: 'clear', type: 'button', style: buttonStyle, disabled: busy, onClick: clearKeys }, t('clear'))
              : null,
          ]),

          keys.length === 0
            ? h('p', { key: 'empty', style: hintStyle }, t('empty'))
            : h(
                'ul',
                { key: 'list', style: listStyle },
                keys.map((row) => {
                  const probe = tested[row.id];
                  return h('li', { key: row.id, style: rowStyle }, [
                    h('span', { key: 'mask', style: { ...codeStyle, flex: '1 1 auto', wordBreak: 'break-all' } }, row.key),
                    h('span', { key: 'status', style: badgeStyle(row.status) }, t(`status_${row.status}`)),
                    h(
                      'span',
                      { key: 'stats', style: { ...codeStyle, flex: '0 0 auto' } },
                      t('stats', { ok: String(row.stats.successes), total: String(row.stats.requests), limited: String(row.stats.rateLimited) }),
                    ),
                    row.status === 'cooldown' && row.cooldownRemaining > 0
                      ? h('span', { key: 'cd', style: { ...codeStyle, flex: '0 0 auto' } }, t('cooldown', { s: String(row.cooldownRemaining) }))
                      : null,
                    probe
                      ? h(
                          'span',
                          {
                            key: 'probe',
                            style: {
                              ...codeStyle,
                              flex: '0 0 auto',
                              color: probe.ok ? 'var(--dsw-alias-label-success, #2ea043)' : 'var(--dsw-alias-label-danger, #cf222e)',
                            },
                          },
                          probe.ok ? `✓ ${probe.latencyMs}ms` : `✗ ${probe.status || 'err'}`,
                        )
                      : null,
                    h('button', { key: 'test', type: 'button', style: smallButtonStyle, disabled: busy, onClick: () => testKey(row.id) }, t('test')),
                    h('button', { key: 'del', type: 'button', style: smallButtonStyle, disabled: busy, onClick: () => removeKey(row.id) }, t('remove')),
                  ]);
                }),
              ),
        ]),

        // ---- 模型可见性 ---------------------------------------------------
        h('div', { key: 'models', style: blockStyle }, [
          h('h3', { key: 'title', style: blockTitleStyle }, t('modelsTitle')),
          h('p', { key: 'hint', style: hintStyle }, t('modelsHint', { count: String(enabledCount), total: String(models.length) })),
          enabledCount === 0 && models.length > 0
            ? h('p', { key: 'warn', style: { ...hintStyle, color: 'var(--dsw-alias-label-warning, #bf8700)' } }, t('modelsAllHidden'))
            : null,
          models.length === 0
            ? h('p', { key: 'empty', style: hintStyle }, t('modelsEmpty'))
            : h(
                'ul',
                { key: 'list', style: listStyle },
                models.map((model) =>
                  h(
                    'li',
                    { key: model.id, style: { ...rowStyle, padding: '6px 10px' } },
                    h(
                      'label',
                      { style: { display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 auto', minWidth: 0, cursor: 'pointer' } },
                      [
                        h('input', {
                          key: 'box',
                          type: 'checkbox',
                          checked: model.enabled === true,
                          disabled: busy,
                          onChange: (event) => toggleModel(model.id, event.target.checked),
                        }),
                        h(
                          'span',
                          { key: 'name', style: { fontSize: 13, color: model.enabled ? labelPrimary : labelTertiary, flex: '0 0 auto' } },
                          model.name,
                        ),
                        h('span', { key: 'id', style: { ...codeStyle, flex: '1 1 auto', wordBreak: 'break-all' } }, model.id),
                      ],
                    ),
                  ),
                ),
              ),
        ]),

        notice ? h('p', { key: 'notice', role: 'status', style: { ...hintStyle, color: labelSecondary } }, notice) : null,
        error ? h('p', { key: 'error', role: 'alert', style: { ...hintStyle, color: 'var(--dsw-alias-label-danger, #cf222e)' } }, error) : null,
      ]);
    }

    // ------------------------------------------------------------------ 文案

    const en = {
      nav: 'SenseNova Key Pool',
      hint: 'Paste one or more SenseNova keys (sk-...). Separate them with newlines or commas; they rotate automatically when one is rate-limited (429).',
      placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      save: 'Add keys',
      working: 'Working…',
      clear: 'Remove all',
      refreshCatalog: 'Refresh model list',
      test: 'Test',
      remove: 'Remove',
      empty: 'No keys yet. Paste at least one above.',
      added: 'Added {added} key(s)',
      duplicate: '{duplicate} already present',
      removed: 'Removed',
      cleared: 'All keys removed',
      catalogRefreshed: 'Model list refreshed ({count} models)',
      testOk: 'Key works ({ms}ms)',
      testFail: 'Failed: {message}',
      sumTotal: 'keys {n}',
      sumHealthy: 'healthy {n}',
      sumCooling: 'cooling {n}',
      sumInvalid: 'invalid {n}',
      sumCatalog: 'catalog: {source} ({count})',
      stats: '{ok}/{total} ok, {limited} limited',
      status_healthy: 'healthy',
      status_cooldown: 'cooling',
      status_invalid: 'invalid',
      cooldown: '{s}s',
      endpointTitle: 'Local endpoint',
      endpointHint: 'An OpenAI-compatible endpoint exposed for other agents. Put the URL and API key into any other agent and it works.',
      endpointUrl: 'Base URL',
      endpointKey: 'API key',
      endpointDown: 'The local endpoint is not running; the keys are still usable inside DSH.',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text and copy manually.',
      keysTitle: 'Key pool',
      modelsTitle: 'Models in the picker',
      modelsHint: '{count} of {total} models are shown in the model picker.',
      modelsAllHidden: 'Every model is hidden — the picker will be empty until you re-enable one.',
      modelsEmpty: 'No models yet. Add a key and refresh the list.',
      modelShown: '{id} is now shown',
      modelHidden: '{id} is hidden',
    };

    const zh = {
      nav: '商汤日日新（Key 轮换池）',
      hint: '粘贴一把或多把商汤 key（sk-…），用换行或逗号分隔。遇 429 限流会自动切换到下一把 key。',
      placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      save: '添加 Key',
      working: '处理中…',
      clear: '清空全部',
      refreshCatalog: '刷新模型列表',
      test: '测试',
      remove: '删除',
      empty: '还没有 key，请在上方粘贴至少一把。',
      added: '已添加 {added} 把 key',
      duplicate: '其中 {duplicate} 把已存在',
      removed: '已删除',
      cleared: '已清空全部 key',
      catalogRefreshed: '模型列表已刷新（{count} 个模型）',
      testOk: '这把 key 可用（{ms}ms）',
      testFail: '失败：{message}',
      sumTotal: '共 {n} 把',
      sumHealthy: '健康 {n}',
      sumCooling: '冷却 {n}',
      sumInvalid: '失效 {n}',
      sumCatalog: '目录：{source}（{count}）',
      stats: '{ok}/{total} 成功，{limited} 次限流',
      status_healthy: '健康',
      status_cooldown: '冷却中',
      status_invalid: '已失效',
      cooldown: '{s}s',
      endpointTitle: '本地接口',
      endpointHint: '对外提供的 OpenAI 兼容接口。把 url 和 API Key 填进其他 Agent 即可直接使用。',
      endpointUrl: '接口地址',
      endpointKey: 'API Key',
      endpointDown: '本地接口未启动；Key 在 DSH 内仍可正常使用。',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请手动选中文本复制。',
      keysTitle: 'Key 池',
      modelsTitle: '下拉中的模型',
      modelsHint: '共 {total} 个模型，当前展示 {count} 个。',
      modelsAllHidden: '所有模型都被隐藏了，模型选择器会是空的 —— 至少勾回一个。',
      modelsEmpty: '还没有模型，请先添加 key 并刷新列表。',
      modelShown: '已展示 {id}',
      modelHidden: '已隐藏 {id}',
    };

    // ------------------------------------------------------------ 错误隔离

    const NOOP_DISPOSER = () => {};

    /**
     * 把一次客户端注册包进错误边界。
     *
     * 槽位 API 若在未来版本变化，这里会退化成一条 console.error，
     * 而不是把异常抛进 DSH 的插件加载器（那会弹整页的红色「插件加载失败」）。
     */
    function guardClientContribution(label, work) {
      try {
        return work();
      } catch (cause) {
        console.error(`[${BUNDLE_NAME}] 客户端注册失败（不影响模型可用）: ${label}`, cause);
        return NOOP_DISPOSER;
      }
    }

    const name = 'dsh-sensenova-pool-client';

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      // 文案字典：注册后即可用 ctx.locale.bind 取 t。
      guardClientContribution('locale', () => {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${BUNDLE_NAME}: dictionaries`);
      });

      const t = ctx.locale.bind(NS);

      // 槽位一（主入口）：设置侧栏里的一级分区，与「通用 / 模型 / 插件」并列。
      guardClientContribution('settings.section', () => {
        ctx.slots.inject('settings.section', () =>
          guardClientContribution('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'sensenova-pool',
                // 排在「通用(0) / 模型 / 账号 / 插件」之后，避免挤掉宿主自己的顺序。
                order: 40,
                // 侧栏栏目名用包名：设置里一眼能对上是哪个插件。
                // 页内标题仍用中文名（见 t('nav')），两者刻意不同。
                label: () => BUNDLE_NAME,
                locale: NS,
                inject: () => ({ t }),
              },
              ({ t: seat }) => h(KeyCard, { t: seat, variant: 'section' }),
            ),
          ),
        );
      });

      // 槽位二：插件页里本 bundle 的配置区（0.1.6+ 的现行位置）。
      guardClientContribution('plugins.bundle.config', () => {
        ctx.slots.inject('plugins.bundle.config', () =>
          guardClientContribution('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: BUNDLE_NAME,
                locale: NS,
                inject: () => ({ t }),
              },
              ({ view, t: seat }) => (view === 'summary' ? seat('hint') : h(KeyCard, { t: seat, variant: 'card' })),
            ),
          ),
        );
      });

      // 槽位三：设置页的插件标签页，给用户第三个入口。
      guardClientContribution('settings.plugins.tab', () => {
        ctx.slots.inject('settings.plugins.tab', () =>
          guardClientContribution('settings.plugins.tab', () =>
            ctx.slots.register(
              {
                name: 'settings.plugins.tab',
                id: BUNDLE_NAME,
                order: 40,
                label: () => BUNDLE_NAME,
                locale: NS,
                inject: () => ({ t }),
              },
              ({ t: seat }) => h(KeyCard, { t: seat, variant: 'card' }),
            ),
          ),
        );
      });
    }

    return { name, inject, apply, BUNDLE_NAME };
  },
});
