// ==================== GOOGLE DRIVE SYNC (PWA) ====================
// Uses standard OAuth 2.0 implicit grant redirect flow (no chrome.identity).
// Same appDataFolder + sidescribe-sync.json as the Chrome extension.

const GDriveSync = (function () {
  const CLIENT_ID = '6317734815-iugd7ievadvib0mljiuimr0c5ftc8f2d.apps.googleusercontent.com';
  const DRIVE_API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
  const FILE_NAME = 'sidescribe-sync.json';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
  const SYNC_DEBOUNCE_MS = 5000;

  let _token = null;
  let _fileId = null;
  let _syncTimer = null;
  let _syncing = false;
  let _onStatusChange = null;

  // ---- Redirect URI (same origin) ----
  function getRedirectURI() {
    // For GitHub Pages: https://<user>.github.io/<repo>/
    // Works with any host — just points back to the same page
    return window.location.origin + window.location.pathname;
  }

  // ---- OAuth via redirect (implicit grant) ----
  function signInInteractive() {
    const redirectUri = getRedirectURI();
    const state = Math.random().toString(36).slice(2);
    localStorage.setItem('sideScribeOAuthState', state);

    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + encodeURIComponent(CLIENT_ID) +
      '&response_type=token' +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&scope=' + encodeURIComponent(SCOPES) +
      '&state=' + encodeURIComponent(state) +
      '&prompt=consent';

    // Navigate to Google sign-in (will redirect back with token in hash)
    window.location.href = authUrl;
  }

  // Call this on page load to check if we're returning from OAuth
  function handleOAuthRedirect() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return false;

    const params = new URLSearchParams(hash.substring(1));
    const token = params.get('access_token');
    const state = params.get('state');
    const expiresIn = parseInt(params.get('expires_in') || '3600');

    // Verify state
    const savedState = localStorage.getItem('sideScribeOAuthState');
    if (state && savedState && state !== savedState) {
      console.warn('[SideScribe] OAuth state mismatch');
      return false;
    }
    localStorage.removeItem('sideScribeOAuthState');

    if (!token) return false;

    _token = token;
    const expiresAt = Date.now() + (expiresIn * 1000);
    localStorage.setItem('sideScribeToken', token);
    localStorage.setItem('sideScribeTokenExpiry', expiresAt.toString());

    // Clean up the URL hash
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  }

  function tryRestoreToken() {
    const token = localStorage.getItem('sideScribeToken');
    const expiry = localStorage.getItem('sideScribeTokenExpiry');
    if (token && expiry) {
      if (Date.now() < parseInt(expiry) - 60000) {
        _token = token;
        return true;
      }
    }
    return false;
  }

  function clearToken() {
    _token = null;
    _fileId = null;
    localStorage.removeItem('sideScribeToken');
    localStorage.removeItem('sideScribeTokenExpiry');
    localStorage.removeItem('sideScribeSyncTime');
  }

  async function authFetch(url, options = {}) {
    if (!_token) throw new Error('Not authenticated');
    const headers = { ...options.headers, 'Authorization': 'Bearer ' + _token };
    const resp = await fetch(url, { ...options, headers });

    if (resp.status === 401) {
      clearToken();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error('Drive API error ' + resp.status + ': ' + errBody.slice(0, 200));
    }
    return resp;
  }

  // ---- Drive file operations (identical to extension) ----

  async function findFile() {
    if (_fileId) return _fileId;
    const query = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    const resp = await authFetch(
      DRIVE_API + '/files?q=' + query + '&spaces=appDataFolder&fields=files(id,modifiedTime)&pageSize=1'
    );
    const data = await resp.json();
    if (data.files && data.files.length > 0) {
      _fileId = data.files[0].id;
      return _fileId;
    }
    return null;
  }

  async function createFile(content) {
    const metadata = {
      name: FILE_NAME,
      parents: ['appDataFolder'],
      mimeType: 'application/json'
    };
    const body = new FormData();
    body.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    body.append('file', new Blob([JSON.stringify(content)], { type: 'application/json' }));

    const resp = await authFetch(UPLOAD_API + '/files?uploadType=multipart&fields=id', {
      method: 'POST',
      body: body
    });
    const data = await resp.json();
    _fileId = data.id;
    return _fileId;
  }

  async function updateFile(fileId, content) {
    const resp = await authFetch(UPLOAD_API + '/files/' + fileId + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content)
    });
    return resp.json();
  }

  async function downloadFile(fileId) {
    const resp = await authFetch(DRIVE_API + '/files/' + fileId + '?alt=media');
    return resp.json();
  }

  async function getFileModifiedTime(fileId) {
    const resp = await authFetch(DRIVE_API + '/files/' + fileId + '?fields=modifiedTime');
    const data = await resp.json();
    return new Date(data.modifiedTime).getTime();
  }

  // ---- Sync logic (identical to extension) ----

  function setStatus(status, message) {
    if (_onStatusChange) _onStatusChange(status, message);
  }

  async function pushToDrive(localData) {
    setStatus('syncing', 'Uploading...');
    const payload = {
      app: 'SideScribe',
      version: '2.8',
      syncedAt: new Date().toISOString(),
      folders: localData.folders,
      notes: localData.notes
    };

    const fileId = await findFile();
    if (fileId) {
      await updateFile(fileId, payload);
    } else {
      await createFile(payload);
    }

    localStorage.setItem('sideScribeSyncTime', Date.now().toString());
    setStatus('synced', 'Synced just now');
  }

  async function sync(getLocalData) {
    if (_syncing) return { action: 'busy' };
    _syncing = true;

    try {
      setStatus('syncing', 'Syncing...');
      const fileId = await findFile();

      if (!fileId) {
        const localData = getLocalData();
        await pushToDrive(localData);
        _syncing = false;
        return { action: 'pushed' };
      }

      const remoteModified = await getFileModifiedTime(fileId);
      const localSyncTime = parseInt(localStorage.getItem('sideScribeSyncTime') || '0');

      if (remoteModified > localSyncTime + 2000) {
        const remoteData = await downloadFile(fileId);
        if (remoteData && remoteData.app === 'SideScribe') {
          setStatus('synced', 'Cloud data available');
          _syncing = false;
          return { action: 'conflict', data: remoteData };
        }
      }

      const localData = getLocalData();
      await pushToDrive(localData);
      _syncing = false;
      return { action: 'pushed' };

    } catch (err) {
      console.error('[SideScribe Sync] Error:', err);
      setStatus('error', err.message);
      _syncing = false;
      throw err;
    }
  }

  async function forcePull() {
    if (_syncing) return null;
    _syncing = true;
    try {
      setStatus('syncing', 'Downloading...');
      const fileId = await findFile();
      if (!fileId) {
        setStatus('synced', 'No cloud data');
        _syncing = false;
        return null;
      }
      const data = await downloadFile(fileId);
      localStorage.setItem('sideScribeSyncTime', Date.now().toString());
      setStatus('synced', 'Downloaded');
      _syncing = false;
      return (data && data.app === 'SideScribe') ? data : null;
    } catch (err) {
      setStatus('error', err.message);
      _syncing = false;
      throw err;
    }
  }

  function schedulePush(getLocalData) {
    if (_syncTimer) clearTimeout(_syncTimer);
    if (!_token) return;

    _syncTimer = setTimeout(async () => {
      if (_syncing) return;
      _syncing = true;
      try {
        const localData = getLocalData();
        await pushToDrive(localData);
      } catch (err) {
        console.error('[SideScribe Sync] Auto-push error:', err);
        setStatus('error', 'Sync failed');
      }
      _syncing = false;
    }, SYNC_DEBOUNCE_MS);
  }

  // ---- Public API ----
  return {
    signIn: function () {
      signInInteractive(); // This navigates away
    },

    signOut: async function () {
      if (_syncTimer) clearTimeout(_syncTimer);
      if (_token) {
        try {
          await fetch('https://accounts.google.com/o/oauth2/revoke?token=' + _token);
        } catch (e) { /* ignore */ }
      }
      clearToken();
      setStatus('offline', 'Signed out');
    },

    handleOAuthRedirect: handleOAuthRedirect,

    tryAutoSignIn: function () {
      return tryRestoreToken();
    },

    isSignedIn: function () {
      return !!_token;
    },

    getRedirectURI: getRedirectURI,

    sync: sync,
    forcePull: forcePull,
    schedulePush: schedulePush,

    pushNow: async function (getLocalData) {
      if (_syncing) return;
      _syncing = true;
      try {
        const localData = getLocalData();
        await pushToDrive(localData);
      } catch (err) {
        setStatus('error', 'Push failed');
      }
      _syncing = false;
    },

    onStatusChange: function (cb) {
      _onStatusChange = cb;
    }
  };
})();
