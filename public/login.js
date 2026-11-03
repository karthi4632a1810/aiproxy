const form = document.getElementById('loginForm');
const submit = document.getElementById('loginSubmit');
const errorLabel = document.getElementById('loginError');
let setupRequired = false;
async function initialize() {
  try {
    const me = await fetch('/api/auth/me');
    if (me.ok) { location.replace('/'); return; }
    const response = await fetch('/api/auth/status');
    if (!response.ok) throw new Error('Unable to connect to the proxy');
    const status = await response.json(); setupRequired = status.setupRequired;
    if (setupRequired) {
      document.getElementById('loginTitle').textContent = 'Create your administrator account';
      document.getElementById('loginDescription').textContent = 'Set up access to your proxy. You can add more users after signing in.';
      document.getElementById('nameField').hidden = false;
      form.elements.name.required = true;
      form.elements.password.minLength = 12;
      form.elements.password.autocomplete = 'new-password';
      document.getElementById('setupTokenField').hidden = !status.setupTokenRequired;
      form.elements.setupToken.required = status.setupTokenRequired;
      document.getElementById('loginHelp').textContent = status.setupTokenRequired
        ? 'Use the SETUP_TOKEN configured on your server. Passwords need at least 12 characters.'
        : 'This first account has administrator access. Passwords need at least 12 characters.';
    }
    submit.textContent = setupRequired ? 'Create account' : 'Sign in'; submit.disabled = false;
  } catch (error) { errorLabel.textContent = error.message; }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); submit.disabled = true; errorLabel.textContent = '';
  try {
    const response = await fetch(`/api/auth/${setupRequired ? 'setup' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || 'Sign in failed');
    form.reset(); location.replace('/');
  } catch (error) { errorLabel.textContent = error.message; submit.disabled = false; }
});
initialize();
