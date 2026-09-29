// Connection screen: renders the state the main process pushes and sends back the person's choices.
const $ = id => document.getElementById(id);
const bridge = window.shoutConnect;
let formShown = false;

function render(state) {
  $('title').textContent = state.title || 'SHOUT';
  $('hint').textContent = state.hint || ''; $('hint').hidden = !state.hint;
  $('url').textContent = state.url || ''; $('url').hidden = !state.url;
  $('error').textContent = state.error || ''; $('error').hidden = !state.error;
  $('status').textContent = state.detail || '';
  $('bar').hidden = !state.busy;
  for (const button of document.querySelectorAll('[data-action]')) button.hidden = !state.actions?.includes(button.dataset.action);
  $('connect-form').hidden = !state.form;
  if (state.form && !formShown) { $('server-input').value = state.form.value || ''; $('form-error').hidden = true; $('server-input').focus(); $('server-input').select(); }
  formShown = Boolean(state.form);
}

if (bridge) {
  bridge.onState(render);
  bridge.state().then(render, () => {});
  for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => bridge.act(button.dataset.action).catch(() => {}));
  $('connect-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('connect-button').disabled = true;
    try {
      const result = await bridge.act('connect', $('server-input').value);
      if (result?.error) { $('form-error').textContent = result.error; $('form-error').hidden = false; $('server-input').focus(); }
    } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
    finally { $('connect-button').disabled = false; }
  });
}
