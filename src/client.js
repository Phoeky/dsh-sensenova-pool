/**
 * 浏览器半：在 DSH 的「插件」页里给本 bundle 渲染一张 key 管理卡片。
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
 * 用 `plugins.bundle.config`（keyed，键 = npm 包名）。这是 0.1.6+ 的现行槽位，
 * 卡片会出现在「插件」页里本 bundle 的详情中。同时注册 `settings.plugins.tab`
 * 作为设置页入口，两处都能进 —— 用户不必猜入口在哪。
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

    // ------------------------------------------------------------------ 卡片

    function KeyCard({ t }) {
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [keys, setKeys] = React.useState([]);
      const [summary, setSummary] = React.useState(undefined);
      const [catalog, setCatalog] = React.useState(undefined);
      const [adminKey, setAdminKey] = React.useState(undefined);
      const [tested, setTested] = React.useState({});

      const load = React.useCallback(async () => {
        try {
          const status = await getJson(`${BASE}/status`);
          if (status && Array.isArray(status.keys)) setKeys(status.keys);
          if (status) {
            setSummary(status.summary);
            setCatalog(status.catalog);
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

      const canSave = !busy && draft.trim() !== '';

      return h('div', { style: rootStyle }, [
        // ---- 顶部说明 + 池状态 ----
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

        // ---- 输入区 ----
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

        notice ? h('p', { key: 'notice', role: 'status', style: { ...hintStyle, color: labelSecondary } }, notice) : null,
        error ? h('p', { key: 'error', role: 'alert', style: { ...hintStyle, color: 'var(--dsw-alias-label-danger, #cf222e)' } }, error) : null,

        // ---- 已有 key 列表 ----
        keys.length === 0
          ? h('p', { key: 'empty', style: hintStyle }, t('empty'))
          : h(
              'ul',
              { key: 'list', style: listStyle },
              keys.map((row) => {
                const probe = tested[row.id];
                return h('li', { key: row.id, style: rowStyle }, [
                  h('span', { key: 'mask', style: { ...codeStyle, flex: '1 1 auto', wordBreak: 'break-all' } }, row.key),
                  h(
                    'span',
                    { key: 'status', style: badgeStyle(row.status) },
                    t(`status_${row.status}`),
                  ),
                  h('span', { key: 'stats', style: { ...codeStyle, flex: '0 0 auto' } }, t('stats', { ok: String(row.stats.successes), total: String(row.stats.requests), limited: String(row.stats.rateLimited) })),
                  row.status === 'cooldown' && row.cooldownRemaining > 0
                    ? h('span', { key: 'cd', style: { ...codeStyle, flex: '0 0 auto' } }, t('cooldown', { s: String(row.cooldownRemaining) }))
                    : null,
                  probe
                    ? h('span', { key: 'probe', style: { ...codeStyle, flex: '0 0 auto', color: probe.ok ? 'var(--dsw-alias-label-success, #2ea043)' : 'var(--dsw-alias-label-danger, #cf222e)' } }, probe.ok ? `✓ ${probe.latencyMs}ms` : `✗ ${probe.status || 'err'}`)
                    : null,
                  h('button', { key: 'test', type: 'button', style: { ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12 }, disabled: busy, onClick: () => testKey(row.id) }, t('test')),
                  h('button', { key: 'del', type: 'button', style: { ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12 }, disabled: busy, onClick: () => removeKey(row.id) }, t('remove')),
                ]);
              }),
            ),

        // ---- 模型列表（让用户确认接入了什么） ----
        catalog && catalog.count > 0
          ? h('p', { key: 'models', style: { ...hintStyle, fontSize: 12 } }, t('modelsHint', { count: String(catalog.count) }))
          : null,
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
      modelsHint: '{count} models available in the model picker.',
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
      modelsHint: '模型选择器里有 {count} 个模型可用。',
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

      // 槽位一：插件页里本 bundle 的配置区（0.1.6+ 的现行位置）。
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
              ({ view, t: seat }) => (view === 'summary' ? seat('hint') : h(KeyCard, { t: seat })),
            ),
          ),
        );
      });

      // 槽位二：设置页的插件标签页，给用户第二个入口。
      guardClientContribution('settings.plugins.tab', () => {
        ctx.slots.inject('settings.plugins.tab', () =>
          guardClientContribution('settings.plugins.tab', () =>
            ctx.slots.register(
              {
                name: 'settings.plugins.tab',
                id: BUNDLE_NAME,
                order: 40,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ t }),
              },
              ({ t: seat }) => h(KeyCard, { t: seat }),
            ),
          ),
        );
      });
    }

    return { name, inject, apply, BUNDLE_NAME };
  },
});
