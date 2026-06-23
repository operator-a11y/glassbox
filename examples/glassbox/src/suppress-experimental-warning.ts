/**
 * Imported first so the filter is installed before `node:sqlite` loads. Silences
 * only the node:sqlite ExperimentalWarning (the API we rely on); all other process
 * warnings still print.
 */

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  console.warn(`${w.name}: ${w.message}`);
});
