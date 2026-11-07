(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VideoTreeStats = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function summarize(node, store = new Map()) {
    const totals = {total:0, done:0, problems:0, running:0};
    for (const t of node.files || []) {
      totals.total++;
      if (t.status === 'done') totals.done++;
      if (['failed','interrupted','probe_failed','conflict'].includes(t.status)) totals.problems++;
      if (t.status === 'running') totals.running++;
    }
    for (const child of (node.dirs || new Map()).values()) {
      const sub = summarize(child, store);
      for (const key of Object.keys(totals)) totals[key] += sub[key];
    }
    store.set(node.id, totals);
    return totals;
  }
  return {summarize};
});
