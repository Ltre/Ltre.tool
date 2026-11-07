'use strict';
/**
 * A session owns its actual DOM subtree. Only the selected subtree is attached:
 * - clones are distinct DOM nodes, not a shared form reset for draft mode;
 * - detached subtrees retain unsaved form values and UI state;
 * - unique HTML IDs exist only once in the live document.
 */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.WorkspaceDOM = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  class WorkspaceViews {
    constructor(template, host) {
      if (!template?.content || !host?.replaceChildren) throw new Error('缺少工作区模板或挂载点');
      this.template = template;
      this.host = host;
      this.views = new Map();
      this.activeKey = null;
    }
    make(key) {
      const fragment = this.template.content.cloneNode(true);
      const element = fragment.firstElementChild;
      if (!element) throw new Error('工作区模板没有根节点');
      const view = {key, element, initialized: false, closedDirs: new Set(), openedFiles: new Set(),
        sourceEdited: false, outputEdited: false};
      this.views.set(key, view);
      return view;
    }
    get(key) { return this.views.get(key); }
    activate(key) {
      let view = this.views.get(key);
      const created = !view;
      if (!view) view = this.make(key);
      const changed = this.activeKey !== key;
      if (changed) {
        this.host.replaceChildren(view.element);
        this.activeKey = key;
      }
      return {view, created, changed};
    }
    drop(key) {
      const view = this.views.get(key);
      if (!view) return;
      if (this.activeKey === key) {
        this.host.replaceChildren();
        this.activeKey = null;
      }
      this.views.delete(key);
    }
  }
  return {WorkspaceViews};
});
