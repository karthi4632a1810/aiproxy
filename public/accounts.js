async function initAccounts() {
  const keysBody = document.getElementById('keysBody');
  const usageBody = document.getElementById('usageBody');
  const keyFilter = document.getElementById('usageKey');
  const days = document.getElementById('usageDays');
  const notice = document.getElementById('accountError');
  let keys = [], users = [];
  const number = value => Number(value || 0).toLocaleString();
  const when = value => value ? new Date(value).toLocaleString() : 'Never';
  async function json(url, options) {
    const response = await apiFetch(url, options); const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    return data;
  }
  function cells(row, values) {
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; row.appendChild(td); }
  }
  const owner = id => users.find(user => user.id === id)?.email || id;
  function button(text, action) {
    const btn = document.createElement('button'); btn.className = 'btn btn-secondary btn-sm'; btn.textContent = text;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await action(); notice.textContent = ''; } catch (error) { notice.textContent = error.message; } finally { btn.disabled = false; }
    });
    return btn;
  }
  async function refreshKeys() {
    const results = await Promise.all([json('/api/account/users'), json('/api/account/keys')]);
    users = results[0].users; keys = results[1].keys;
    keysBody.replaceChildren();
    for (const key of keys) {
      const row = document.createElement('tr');
      const state = key.revokedAt ? 'Revoked' : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? 'Expired' : 'Active';
      cells(row, [key.name, owner(key.userId), key.client, `${key.prefix}…`, state + (key.agent ? ' · Workspace' : ''),
        number(key.stats.requests), number(key.stats.inputTokens + key.stats.outputTokens), number(key.stats.errors + key.stats.aborted), when(key.lastUsedAt)]);
      const action = document.createElement('td');
      if (!key.revokedAt) action.appendChild(button('Revoke', async () => { await json(`/api/account/keys/${key.id}`, { method: 'DELETE' }); await refreshKeys(); }));
      row.appendChild(action); keysBody.appendChild(row);
    }
    if (!keys.length) { const row = document.createElement('tr'); cells(row, ['No API keys yet. Create your first key below.']); row.firstChild.colSpan = 10; keysBody.appendChild(row); }
    const previous = keyFilter.value;
    keyFilter.replaceChildren(new Option('All keys + dashboard', ''));
    for (const key of keys) keyFilter.add(new Option(`${key.name} · ${owner(key.userId)}`, key.id));
    if (keys.some(k => k.id === previous)) keyFilter.value = previous;
    const select = document.getElementById('keyOwner'); const selected = select.value || currentUser.id;
    select.replaceChildren();
    for (const user of users.filter(u => !u.disabled)) select.add(new Option(user.email, user.id));
    select.value = selected;
    const usersBody = document.getElementById('usersBody'); usersBody.replaceChildren();
    for (const user of users) {
      const row = document.createElement('tr'); cells(row, [user.name, user.email, user.role, user.disabled ? 'Disabled' : 'Active']);
      const action = document.createElement('td');
      if (user.id !== currentUser.id) action.appendChild(button(user.disabled ? 'Enable' : 'Disable', async () => {
        await json(`/api/account/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: !user.disabled }) });
        await refreshKeys();
      }));
      row.appendChild(action); usersBody.appendChild(row);
    }
  }
  async function refreshUsage() {
    const query = new URLSearchParams({ days: days.value }); if (keyFilter.value) query.set('keyId', keyFilter.value);
    const data = await json(`/api/account/usage?${query}`);
    document.getElementById('usageRequests').textContent = number(data.totals.requests);
    document.getElementById('usageInput').textContent = number(data.totals.inputTokens);
    document.getElementById('usageOutput').textContent = number(data.totals.outputTokens);
    document.getElementById('usageErrors').textContent = number(data.totals.errors + data.totals.aborted);
    document.getElementById('usageEstimate').textContent = `${number(data.totals.estimatedRequests)} requests use estimated token counts. Labels identify the key's intended client; IP and client hints do not verify a person's identity.`;
    usageBody.replaceChildren();
    for (const request of data.requests) {
      const row = document.createElement('tr');
      const key = keys.find(k => k.id === request.keyId);
      cells(row, [when(request.timestamp), owner(request.userId), key?.name || 'Dashboard session', request.client,
        request.model, `${request.outcome} (${request.status || '…'})`, `${number(request.inputTokens)} / ${number(request.outputTokens)}${request.estimated ? ' ≈' : ''}`,
        `${number(request.durationMs)} ms`, request.ip, request.clientHint || request.userAgent || '—', request.endpoint]);
      usageBody.appendChild(row);
    }
    if (!data.requests.length) { const row = document.createElement('tr'); cells(row, ['No requests in this period.']); row.firstChild.colSpan = 11; usageBody.appendChild(row); }
  }
  const refresh = async () => { try { await refreshKeys(); await refreshUsage(); notice.textContent = ''; } catch (error) { notice.textContent = error.message; } };
  for (const element of [keyFilter, days]) element.addEventListener('change', () => refreshUsage().catch(error => { notice.textContent = error.message; }));
  document.getElementById('refreshUsage').addEventListener('click', refresh);
  document.getElementById('createKeyForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const submit = form.querySelector('button[type=submit]'); submit.disabled = true;
    try {
      const data = await json('/api/account/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: form.elements.keyName.value, client: form.elements.client.value, userId: form.elements.userId.value,
        expiresInDays: Number(form.elements.expiry.value) || null, agent: form.elements.agent.checked
      }) });
      document.getElementById('newKeyValue').value = data.token;
      document.getElementById('newKeyBox').hidden = false;
      form.elements.keyName.value = ''; form.elements.agent.checked = false;
      await refresh();
    } catch (error) { notice.textContent = error.message; } finally { submit.disabled = false; }
  });
  document.getElementById('copyNewKey').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(document.getElementById('newKeyValue').value); showToast('API key copied'); }
    catch { document.getElementById('newKeyValue').select(); showToast('Select and copy the key'); }
  });
  document.getElementById('dismissNewKey').addEventListener('click', () => { document.getElementById('newKeyValue').value = ''; document.getElementById('newKeyBox').hidden = true; });
  document.getElementById('createUserForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await json('/api/account/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await refresh(); showToast('User created');
    } catch (error) { notice.textContent = error.message; } finally { btn.disabled = false; }
  });
  document.getElementById('passwordForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target;
    try {
      await json('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); location.replace('/login.html');
    } catch (error) { notice.textContent = error.message; }
  });
  await refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
}
