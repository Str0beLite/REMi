// One place that knows about unsaved edits, so leaving an editor (in-app or closing the tab) can ask first.
// shortcut: browser back/forward isn't intercepted (hashchange can't be cancelled); add a history guard if that bites.
let message: string | null = null;

export const setUnsaved = (m: string | null) => {
  message = m;
};
export const confirmLeave = () => !message || window.confirm(message);

window.addEventListener('beforeunload', e => {
  if (message) e.preventDefault();
});
