let currentUser;
let csrfToken = '';
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) location.replace('/login.html');
  return response;
}
async function requireLogin() {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!response.ok) { location.replace('/login.html'); return false; }
  const data = await response.json(); currentUser = data.user; csrfToken = data.csrfToken;
  document.getElementById('accountIdentity').textContent = `${currentUser.name} · ${currentUser.role}`;
  document.querySelectorAll('[data-admin]').forEach(element => { element.hidden = currentUser.role !== 'admin'; });
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    const response = await apiFetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) location.replace('/login.html');
  });
  document.body.classList.remove('auth-loading');
  return true;
}
