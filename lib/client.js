/**
 * Browser half of `dsh-open-workspace-any-app`.
 *
 * This file is a *client bundle*, not an ES module: the DSH web shell loads it
 * as a plain script whose whole effect is to register a factory with
 * `window.__ModuleLoader__`. Side effects (including CSS) belong inside the
 * factory closure, which materializes on first import — the loader treats
 * executing the script as registration only.
 *
 * The bundle id must equal the package name, because that is how the host's
 * `dsh-client-modules` scan keys the row when it reads this package's
 * `exports["./client"]` and `dsh.client` declaration.
 *
 * The control registers into `conversation.session.header.utilities`, the
 * list slot the built-in open-in-app button also occupies. That slot is a
 * *list*: a fresh id is added beside the shipped entries, while reusing a
 * shipped id would replace that cell — so this plugin uses its own id and
 * leaves the built-in control untouched.
 *
 * ## What this half owns
 *
 * - The remembered choice: the last app the person opened with is persisted to
 *   `localStorage` through the platform's own snapshot store, so the button
 *   returns to it across sessions and browser restarts.
 * - The button face: it shows that app's *icon*, not a generic glyph.
 * - Managing the menu: choosing which applications are in it, and which are
 *   removed. Adding happens through the dialog's scanned list, so an addition
 *   is one click on the app's own name — no bundle path to type, and no native
 *   panel whose availability varies by platform.
 *
 * ## The manage dialog is a viewport, not a growing page
 *
 * The dialog lists what is installed, and a machine has hundreds of bundles.
 * Rendering them all inside a card that sizes to its content made the card
 * taller than the window: its own rows, and the buttons under them, sat off
 * screen with no way to reach them. So the dialog now has a *fixed viewport*:
 *
 * - the card is capped at `--dsh-frame-viewport-height` and never exceeds the
 *   window (the same shape `dsh-client-ui-plugin-manager` uses for its install
 *   dialog: `max-height: min(<px>, 100%)`);
 * - the body scrolls, so every row is reachable however long the list is;
 * - a search field sits above the list, and the unscanned part of the list is
 *   cut to {@link INITIAL_ROWS} rows until the field has a query — the list is
 *   for *finding* one app, not for reading all of them.
 *
 * The CSS is injected as a `<style>` tag at factory scope, pre-tagged with this
 * package's id so the loader's own HMR bookkeeping can remove it on reload —
 * the same channel a compiled CSS-module bundle uses, and the same reason the
 * injection cannot wait for `apply()` (see `installStyles`). Inline styles
 * cannot express `:hover`, a scrollbar, or the `input::placeholder` the search
 * field needs.
 */
window.__ModuleLoader__.load({
  id: 'dsh-open-workspace-any-app',
  factory: (require) => {
    const React = require('react');
    const store = require('@deepseek-ai/dsh-client-store');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const {
      Button,
      IconChevronDownOutlineRegular,
      IconFolderOpenOutlineRegular,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconSearchOutlineRegular,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      Input,
      Menu,
      Modal,
      Toast,
      Tooltip,
    } = primitives;

    /** Route references; the browser addresses app routes document-relative. */
    const APPS_ROUTE = 'plugins/dsh-open-workspace-any-app/apps';
    const ICON_ROUTE = 'plugins/dsh-open-workspace-any-app/icon';
    const OPEN_ROUTE = 'plugins/dsh-open-workspace-any-app/open';
    const DISCOVER_ROUTE = 'plugins/dsh-open-workspace-any-app/discover';
    const ADD_ROUTE = 'plugins/dsh-open-workspace-any-app/apps/add';
    const REMOVE_ROUTE = 'plugins/dsh-open-workspace-any-app/apps/remove';
    const RESTORE_ROUTE = 'plugins/dsh-open-workspace-any-app/apps/restore';

    /** Dictionary namespace for this plugin's strings. */
    const NS = 'open-any-app';

    /**
     * How many scanned applications the dialog shows while the search field is
     * empty.
     *
     * A machine has hundreds of bundles, and the dialog exists to pick one:
     * an unscanned list longer than the window is noise, not information. Six
     * rows is about what fits under the search field without the card having to
     * grow, so the dialog opens at a stable size and stays there. Typing any
     * query lifts the cap — a person who is looking for something specific has
     * told us what to show.
     */
    const INITIAL_ROWS = 6;

    /**
     * Class names for the pieces inline styles cannot describe.
     *
     * These are the only hooks the markup and the stylesheet share, so they
     * live as literals in one place rather than as strings sprinkled through
     * the render.
     */
    const CLS = {
      dialog: 'dsh-open-any-app-dialog',
      content: 'dsh-open-any-app-content',
      search: 'dsh-open-any-app-search',
      list: 'dsh-open-any-app-list',
      more: 'dsh-open-any-app-more-hint',
    };

    /**
     * The dialog's layout stylesheet.
     *
     * Two rules carry the whole fix and are worth reading together:
     *
     * - `.dsh-open-any-app-dialog` caps the card. `100%` resolves against the
     *   modal layer's padding box (the `Modal` primitive pads `24px` around a
     *   full-viewport flex container), so the card can never be taller than the
     *   window, and `min(520px, 100%)` keeps it a dialog rather than a sheet on
     *   a large display.
     * - `.dsh-open-any-app-content` is the flex child that must *shrink* for
     *   that cap to bite: `min-height: 0` defeats the default `min-height:
     *   auto`, which would otherwise let the content push the card past its
     *   `max-height`. `overflow-y: auto` then turns the overflow into a
     *   scrollbar instead of clipped rows.
     *
     * `overscroll-behavior: contain` stops a flick at the end of the list from
     * scrolling the transcript behind the mask.
     */
    const STYLES = `
.${CLS.dialog} {
  width: min(480px, 100%);
  max-height: min(520px, 100%);
}
.${CLS.content} {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.${CLS.search} {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.${CLS.search} > span {
  width: 100%;
}
.${CLS.list} {
  display: flex;
  flex-direction: column;
}
.${CLS.more} {
  padding: 6px 8px 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
`;

    /**
     * Install the stylesheet once per document.
     *
     * ## Why this runs at factory scope, not inside `apply()`
     *
     * `apply()` is the obvious home for a side effect, and it is the wrong one
     * here. The loader claims a plugin's style tags immediately after its
     * *factory* returns — `claimStyles(ownerId)` walks every `style:not([data-plugin])`
     * and stamps it with the owning package id, which is how a reload later
     * knows which tags to remove. A tag created in `apply()` runs after that
     * sweep, so it stays unclaimed: on every reload the loader removes the tags
     * it knows about and this one survives, accumulating a stale copy per
     * generation. Tagging `data-plugin` up front opts in explicitly instead of
     * relying on the sweep, and makes the ownership a fact stated here rather
     * than an inference about call order.
     *
     * The cost is that the tag is created while the factory materializes rather
     * than while the plugin starts. That is what the shipped control does too:
     * its CSS-module bundle injects at module scope inside the factory. Nothing
     * renders before `apply()`, so a tag that exists a moment early is inert.
     *
     * Guarding on the id keeps the call idempotent when a factory runs more than
     * once in a page.
     */
    function installStyles() {
      if (typeof document === 'undefined') return;
      const tagId = `${NS}/dialog.css`;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-open-workspace-any-app';
      tag.dataset.pluginCss = tagId;
      tag.textContent = STYLES;
      document.head.appendChild(tag);
    }

    installStyles();

    /**
     * The remembered app id, shared across every Session header and persisted
     * to `localStorage`.
     *
     * This is the platform's own snapshot store, not a hand-rolled
     * `localStorage` call: it rehydrates on construction and writes on every
     * change, and it degrades to an in-memory store when storage is
     * unavailable (private mode, quota) instead of throwing.
     */
    const choice = store.createSnapshotStore('', { persist: { name: 'dsh.open-workspace-any-app.choice' } });

    /** The catalog, shared per page so the button and the dialog agree. */
    const apps = store.createSnapshotStore(null);
    /** Applications the person removed, offered back by the dialog. */
    const removed = store.createSnapshotStore([]);

    const en = {
      'action.open': 'Open in another app',
      'action.openIn': 'Open in {app}',
      'action.busy': 'Opening…',
      'action.empty': 'No applications yet',
      'action.failed': 'Could not open the workspace',
      'action.manage': 'Manage applications…',
      'action.truncated': 'Some applications were still being detected',
      'dialog.title': 'Applications',
      'dialog.description': 'Choose which applications the menu offers.',
      'dialog.inMenu': 'In the menu',
      'dialog.removed': 'Removed',
      'dialog.found': 'Found in Applications',
      'dialog.loading': 'Looking for installed applications…',
      'dialog.none': 'Nothing new found.',
      'dialog.failed': 'Could not read installed applications',
      'dialog.noMatch': 'Nothing matches “{query}”.',
      'dialog.more': '{count} more installed — type to narrow the list.',
      'dialog.filter': 'Search applications…',
      'dialog.close': 'Close',
      'dialog.remove': 'Remove {app} from the menu',
      'dialog.restore': 'Put {app} back in the menu',
      'dialog.add': 'Add {app}',
      'dialog.added': 'Added {app}',
      'dialog.removedToast': 'Removed {app}',
      'dialog.restored': 'Put {app} back',
    };
    const zh = {
      'action.open': '用其它应用打开',
      'action.openIn': '用 {app} 打开',
      'action.busy': '正在打开…',
      'action.empty': '还没有应用',
      'action.failed': '无法打开工作区',
      'action.manage': '管理应用…',
      'action.truncated': '部分应用仍在检测中',
      'dialog.title': '应用',
      'dialog.description': '选择菜单里显示哪些应用。',
      'dialog.inMenu': '菜单中',
      'dialog.removed': '已移除',
      'dialog.found': '在「应用程序」中发现',
      'dialog.loading': '正在查找本机应用…',
      'dialog.none': '没有发现新应用。',
      'dialog.failed': '无法读取本机应用',
      'dialog.noMatch': '没有匹配「{query}」的应用。',
      'dialog.more': '还有 {count} 个已安装应用 —— 输入关键字可缩小范围。',
      'dialog.filter': '搜索应用…',
      'dialog.close': '关闭',
      'dialog.remove': '把 {app} 移出菜单',
      'dialog.restore': '把 {app} 放回菜单',
      'dialog.add': '添加 {app}',
      'dialog.added': '已添加 {app}',
      'dialog.removedToast': '已移除 {app}',
      'dialog.restored': '已放回 {app}',
    };

    /**
     * Fetch one JSON route with the credentials the host's trust fence wants.
     *
     * `credentials: 'same-origin'` sends the login-token cookie: without it
     * every route answers 401 and the menu would look empty rather than
     * unauthorized.
     * @param {string} route - document-relative route path.
     * @param {object} [init] - fetch options.
     * @returns {Promise<any>} the parsed JSON body.
     */
    async function request(route, init = {}) {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...init,
      });
      if (!response.ok) {
        let detail = `${route} answered ${String(response.status)}`;
        try {
          const body = await response.json();
          if (typeof body.message === 'string') detail = body.message;
        } catch {
          // Swallows a non-JSON error body: the status line is enough detail.
        }
        const error = new Error(detail);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    }

    /**
     * Read the catalog and publish it, along with the removed list.
     * @returns {Promise<Array<object>>} the offered apps.
     */
    async function refreshApps() {
      const body = await request(APPS_ROUTE);
      const list = Array.isArray(body.apps) ? body.apps : [];
      apps.set(list);
      removed.set(Array.isArray(body.hidden) ? body.hidden : []);
      return list;
    }

    /**
     * Resolve which app the button acts on.
     *
     * The remembered id wins when it is still offered; otherwise the first app
     * is used. Unlike the built-in control this does *not* filter the catalog
     * through a hardcoded label table, so an app the person added — or one the
     * operator declared — is never silently dropped for being unknown.
     * @param {Array<object>|null} list - the offered apps.
     * @param {string} remembered - the persisted app id.
     * @returns {object|undefined} the app to act on.
     */
    function preferredApp(list, remembered) {
      if (list === null || list.length === 0) return undefined;
      return list.find((app) => app.id === remembered) ?? list[0];
    }

    /** One application image, falling back to a generic glyph when there is none. */
    function AppIcon({ appId, icon, size = 14 }) {
      const [failed, setFailed] = React.useState(false);
      if (icon === false || failed) return React.createElement(IconFolderOpenOutlineRegular, { size });
      return React.createElement('img', {
        src: `${ICON_ROUTE}/${encodeURIComponent(appId)}`,
        width: size,
        height: size,
        alt: '',
        draggable: false,
        'data-open-any-app-icon': appId,
        onError: () => {
          setFailed(true);
        },
      });
    }

    /** One icon-only row action, sized for a list row. */
    function RowAction({ label, dataAttr, onClick, children, danger = false }) {
      return React.createElement(Tooltip, {
        portal: true,
        label,
        side: 'bottom',
        delayMs: 400,
        children: React.createElement('button', {
          type: 'button',
          'aria-label': label,
          [dataAttr]: '',
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            flex: 'none',
            padding: 0,
            border: 'none',
            borderRadius: 'var(--dsw-radius-sm)',
            background: 'transparent',
            color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          },
        }, children),
      });
    }

    /**
     * One row in the manage list: icon, label, and its trailing action.
     * @param {object} props - row inputs.
     * @returns {import('react').ReactElement} the row.
     */
    function AppRow({ appId, label, icon, action }) {
      return React.createElement('div', {
        'data-open-any-app-row': appId,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 32,
          padding: '2px 2px 2px 8px',
          borderRadius: 'var(--dsw-radius-sm)',
        },
      }, [
        React.createElement(AppIcon, { key: 'icon', appId, icon }),
        React.createElement('span', {
          key: 'label',
          style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, label),
        action,
      ]);
    }

    /**
     * The manage dialog: what is in the menu, what was removed, and what is
     * available to add.
     *
     * The scanned list is the one route to adding: rows for the Applications
     * roots the host scans, so an addition is one click on the app's own name
     * and nobody ever types a bundle path.
     * @param {object} props - dialog inputs.
     * @returns {import('react').ReactElement|null} the dialog.
     */
    function ManageDialog({ open, t, list, removedList, onClose, showToast }) {
      const [candidates, setCandidates] = React.useState(null);
      const [scanFailed, setScanFailed] = React.useState(false);
      const [filter, setFilter] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      // The scan runs when the dialog opens, and again after any change so the
      // "found" list never offers an app that was just added.
      const loadCandidates = React.useCallback((signal) => {
        request(DISCOVER_ROUTE, { signal }).then(
          (body) => {
            setCandidates(Array.isArray(body.candidates) ? body.candidates : []);
            setScanFailed(false);
          },
          (failure) => {
            // A failed scan and an empty scan must not read the same: "nothing
            // new found" over a broken request tells the person their machine
            // has no other applications, which is a different claim.
            if (failure?.name === 'AbortError') return;
            setCandidates([]);
            setScanFailed(true);
          },
        );
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        setCandidates(null);
        setScanFailed(false);
        setFilter('');
        loadCandidates(controller.signal);
        return () => {
          controller.abort();
        };
      }, [open, loadCandidates]);

      if (!open) return null;

      /**
       * Run one mutation, refresh both lists, and report the outcome.
       * @param {object} options - mutation inputs.
       * @returns {Promise<void>} resolves when the lists are refreshed.
       */
      const mutate = async ({ route, body, success }) => {
        if (busy) return;
        setBusy(true);
        try {
          await request(route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          await refreshApps();
          loadCandidates();
          if (success !== undefined) showToast(success);
        } catch (failure) {
          showToast(failure instanceof Error ? failure.message : t('action.failed'));
        } finally {
          setBusy(false);
        }
      };

      const needle = filter.trim().toLowerCase();
      const matches = (label) => needle === '' || label.toLowerCase().includes(needle);

      // The field filters all three sections, so what is already in the menu and
      // what was removed are searchable too — a person looking for an app knows
      // its name, not which of the three lists it is in.
      const shownMenu = (list ?? []).filter((app) => matches(app.label));
      const shownRemoved = removedList.filter((app) => matches(app.label));
      const scanned = candidates === null
        ? null
        : candidates.filter((candidate) => matches(candidate.label));
      // The scan is the list that overflows — a machine has hundreds of bundles —
      // so it is the one that opens capped. A query lifts the cap: the person has
      // said what they are looking for, so everything that matches is fair game.
      const shownFound = scanned !== null && needle === '' ? scanned.slice(0, INITIAL_ROWS) : scanned;
      const cappedFound = scanned === null ? 0 : scanned.length - (shownFound?.length ?? 0);

      // The field is offered whenever there is something to search, counted
      // before the filter so that typing a query which matches nothing cannot
      // take away the box needed to clear it.
      const searchable = (list ?? []).length + removedList.length + (candidates?.length ?? 0) > 0;

      /**
       * One titled group of rows.
       * @param {string} key - React key.
       * @param {string} heading - the group's localized heading.
       * @param {Array} rows - rendered rows; an empty group renders nothing.
       * @returns {object|null} the group, or null when it has no rows.
       */
      const section = (key, heading, rows) => (rows.length === 0 ? null : React.createElement('div', {
        key,
        style: { marginTop: 14 },
      }, [
        React.createElement('div', {
          key: 'h',
          style: { fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)', padding: '0 8px 4px' },
        }, heading),
        React.createElement('div', { key: 'rows', className: CLS.list }, rows),
      ]));

      /** A one-line placeholder where a list would be: loading, empty, or no match. */
      const placeholder = (key, text) => React.createElement('div', {
        key,
        style: { padding: '4px 8px', opacity: 0.6, fontSize: 12 },
      }, text);

      return React.createElement(Modal, {
        open: true,
        onClose,
        title: t('dialog.title'),
        description: t('dialog.description'),
        // The card is capped and the body scrolls: this is the fixed viewport
        // that keeps a long scan from pushing the card past the window.
        className: CLS.dialog,
        contentClassName: CLS.content,
        footer: [
          React.createElement(Button, {
            key: 'close',
            variant: 'ghost',
            onClick: onClose,
            children: t('dialog.close'),
          }),
        ],
      }, [
        // The search field owns the top of the viewport and stays there while
        // the list scrolls under it, so the way to narrow a long list is never
        // scrolled out of reach.
        searchable
          ? React.createElement('div', { key: 'search', className: CLS.search }, React.createElement(Input, {
            value: filter,
            icon: React.createElement(IconSearchOutlineRegular, { size: 14 }),
            placeholder: t('dialog.filter'),
            'aria-label': t('dialog.filter'),
            'data-open-any-app-filter': '',
            onChange: (event) => {
              setFilter(event.target.value);
            },
          }))
          : null,

        section('in-menu', t('dialog.inMenu'), shownMenu.map((app) => React.createElement(AppRow, {
          key: app.id,
          appId: app.id,
          label: app.label,
          icon: app.icon,
          action: React.createElement(RowAction, {
            label: t('dialog.remove', { app: app.label }),
            dataAttr: 'data-open-any-app-remove',
            danger: true,
            onClick: () => {
              void mutate({
                route: REMOVE_ROUTE,
                body: { app: app.id },
                success: t('dialog.removedToast', { app: app.label }),
              });
            },
          }, React.createElement(IconTrashOutlineRegular, { size: 14 })),
        }))),

        shownRemoved.length === 0 ? null : section('removed', t('dialog.removed'), shownRemoved.map((app) => React.createElement(AppRow, {
          key: app.id,
          appId: app.id,
          label: app.label,
          icon: false,
          action: React.createElement(RowAction, {
            label: t('dialog.restore', { app: app.label }),
            dataAttr: 'data-open-any-app-restore',
            onClick: () => {
              void mutate({
                route: RESTORE_ROUTE,
                body: { app: app.id },
                success: t('dialog.restored', { app: app.label }),
              });
            },
          }, React.createElement(IconRefreshOutlineRegular, { size: 14 })),
        }))),

        section('found',
          t('dialog.found'),
          candidates === null
            ? [placeholder('loading', t('dialog.loading'))]
            : scanFailed
              ? [placeholder('failed', t('dialog.failed'))]
              : scanned.length === 0
                // Two different emptinesses: nothing was found at all, or nothing
                // matched what was typed. Saying "nothing new found" to a query
                // reads as a broken search.
                ? [placeholder('none', needle === '' ? t('dialog.none') : t('dialog.noMatch', { query: filter.trim() }))]
                : [
                ...shownFound.map((candidate) => React.createElement(AppRow, {
                  key: candidate.path,
                  appId: `candidate:${candidate.path}`,
                  label: candidate.label,
                  icon: false,
                  action: React.createElement(RowAction, {
                    label: t('dialog.add', { app: candidate.label }),
                    dataAttr: 'data-open-any-app-add',
                    onClick: () => {
                      void mutate({
                        route: ADD_ROUTE,
                        body: { path: candidate.path, label: candidate.label },
                        success: t('dialog.added', { app: candidate.label }),
                      });
                    },
                  }, React.createElement(IconPlusOutlineRegular, { size: 14 })),
                })),
                // Say that the list is cut, and how to see the rest: a silently
                // truncated list reads as "that is everything installed".
                cappedFound > 0
                  ? React.createElement('div', {
                    key: 'more',
                    className: CLS.more,
                    'data-open-any-app-more-hint': '',
                  }, t('dialog.more', { count: cappedFound }))
                  : null,
              ]),
      ]);
    }

    /**
     * The Session-header control: a split button whose primary action opens
     * the workspace in the remembered app and whose chevron lists them all.
     * @param {object} props - slot inputs.
     * @returns {import('react').ReactElement|null} the control, or null without a workspace.
     */
    function OpenAnyAppAction(props) {
      const { sessionId, useSessions, t } = props;
      const cwd = useSessions((state) => state.byId[sessionId]?.cwd);
      // The third argument is the server snapshot: a snapshot store's value is
      // available synchronously, so the same reader serves both, exactly as the
      // built-in control subscribes to its stores.
      const remembered = React.useSyncExternalStore(choice.subscribe, choice.getSnapshot, choice.getSnapshot);
      const list = React.useSyncExternalStore(apps.subscribe, apps.getSnapshot, apps.getSnapshot);
      const removedList = React.useSyncExternalStore(removed.subscribe, removed.getSnapshot, removed.getSnapshot);

      const [menuOpen, setMenuOpen] = React.useState(false);
      const [dialogOpen, setDialogOpen] = React.useState(false);
      const [pending, setPending] = React.useState(false);
      const [toast, setToast] = React.useState(null);
      const inFlight = React.useRef(false);

      // The catalog is host state, not session state: read it once on mount so
      // the button can show a real app icon instead of a placeholder.
      React.useEffect(() => {
        refreshApps().catch(() => {
          // A failed first read leaves the button in its empty state; opening
          // the menu retries and surfaces the error there.
        });
      }, []);

      if (typeof cwd !== 'string' || cwd === '') return null;

      const preferred = preferredApp(list, remembered);
      const showToast = (text) => {
        setToast({ seq: (toast?.seq ?? 0) + 1, text });
      };

      const run = (appId) => {
        setMenuOpen(false);
        if (inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        request(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: appId, path: cwd }),
        })
          .then(() => {
            // Remember only a launch the host accepted: persisting a rejected
            // choice would make the next session open with a broken button.
            choice.set(appId);
          })
          .catch((failure) => {
            showToast(failure instanceof Error ? failure.message : t('action.failed'));
          })
          .finally(() => {
            inFlight.current = false;
            setPending(false);
          });
      };

      const label = pending
        ? t('action.busy')
        : preferred === undefined
          ? t('action.open')
          : t('action.openIn', { app: preferred.label });

      const items = (list ?? []).map((app) => ({
        id: `app:${app.id}`,
        icon: React.createElement(AppIcon, { appId: app.id, icon: app.icon }),
        label: app.label,
      }));
      items.push({ id: 'manage', icon: React.createElement(IconPlusOutlineRegular, {}), label: t('action.manage') });
      if ((list ?? []).length === 0) {
        items.unshift({
          id: 'empty',
          label: list === null ? t('action.busy') : t('action.empty'),
          disabled: true,
        });
      }

      const disabled = pending;

      return React.createElement(React.Fragment, null, [
        React.createElement(Menu, {
          key: 'menu',
          open: menuOpen && !disabled,
          autoFocus: true,
          portal: true,
          dense: true,
          align: 'end',
          // The check marks the remembered app, so the persisted state is
          // visible rather than implicit. It rides the menu's own selection
          // channel, and only once a choice exists — before that the first app
          // is the acting default, not something the person picked.
          selectedId: remembered === '' ? undefined : `app:${remembered}`,
          onClose: () => {
            setMenuOpen(false);
          },
          items,
          onSelect: (id) => {
            if (id === 'empty') return;
            if (id === 'manage') {
              setMenuOpen(false);
              setDialogOpen(true);
              return;
            }
            run(id.slice(4));
          },
          anchor: React.createElement('div', {
            key: 'anchor',
            'data-open-any-app': '',
            style: { display: 'inline-flex', alignItems: 'center' },
            children: [
              React.createElement(Tooltip, {
                key: 'tip',
                portal: true,
                label,
                side: 'bottom',
                delayMs: 500,
                children: React.createElement('button', {
                  type: 'button',
                  disabled,
                  'aria-label': label,
                  'data-open-any-app-primary': preferred?.id ?? '',
                  onClick: () => {
                    if (preferred === undefined) {
                      setMenuOpen(true);
                      return;
                    }
                    run(preferred.id);
                  },
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    height: 24,
                    padding: '0 6px',
                    border: 'none',
                    borderRadius: 'var(--dsw-radius-sm)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    cursor: disabled ? 'default' : 'pointer',
                  },
                }, [
                  // The remembered app's own icon is the button face, so the
                  // control says which app it will open without a tooltip.
                  React.createElement(AppIcon, {
                    key: 'icon',
                    appId: preferred?.id ?? '',
                    icon: preferred?.icon ?? false,
                    size: 16,
                  }),
                ]),
              }),
              React.createElement('button', {
                key: 'chevron',
                type: 'button',
                disabled,
                'aria-haspopup': 'menu',
                'aria-expanded': menuOpen && !disabled,
                'aria-label': t('action.open'),
                'data-open-any-app-more': '',
                onClick: () => {
                  if (!menuOpen) {
                    refreshApps().catch((failure) => {
                      showToast(failure instanceof Error ? failure.message : t('action.failed'));
                    });
                  }
                  setMenuOpen((value) => !value);
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14,
                  height: 24,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  cursor: disabled ? 'default' : 'pointer',
                },
              }, [React.createElement(IconChevronDownOutlineRegular, { key: 'c', size: 10 })]),
            ],
          }),
        }),
        React.createElement(ManageDialog, {
          key: 'dialog',
          open: dialogOpen,
          t,
          list,
          removedList,
          onClose: () => {
            setDialogOpen(false);
          },
          showToast,
        }),
        toast === null ? null : React.createElement(Toast, {
          key: `toast-${String(toast.seq)}`,
          text: toast.text,
          icon: React.createElement(IconWarningOutlineRegular, {}),
          onDone: () => {
            setToast(null);
          },
        }),
      ]);
    }

    /**
     * Client plugin body: register dictionaries and the Session-header control.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'open-any-app: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        // A fresh id: reusing the built-in 'open-in-app' id would replace the
        // shipped control instead of sitting beside it.
        id: 'open-any-app',
        // After the shipped control (order -10), before the later utilities.
        order: 0,
        locale: NS,
      }, (props) => React.createElement(OpenAnyAppAction, { ...props, t })));
    }

    return { apply, inject: ['slots', 'locale'] };
  },
});
