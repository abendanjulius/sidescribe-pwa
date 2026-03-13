// ==================== SideScribe PWA ====================
// Ported from Chrome extension sidepanel.js
// - chrome.storage.local → localStorage
// - chrome.identity → standard OAuth redirect (in gdrive-sync.js)
// - Added mobile sidebar overlay, PWA install prompt, SW registration

document.addEventListener('DOMContentLoaded', function() {

  // ---- Register Service Worker ----
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function(err) {
      console.warn('[SW] Registration failed:', err);
    });
  }

  // ---- Handle OAuth redirect on page load ----
  const wasOAuthRedirect = GDriveSync.handleOAuthRedirect();

  // ---- PWA Install Prompt ----
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('installBanner').classList.add('show');
  });

  document.getElementById('installBtn').addEventListener('click', function() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function() {
        deferredInstallPrompt = null;
        document.getElementById('installBanner').classList.remove('show');
      });
    }
  });

  document.getElementById('installDismiss').addEventListener('click', function() {
    document.getElementById('installBanner').classList.remove('show');
  });

  // ---- State ----
  let db = {
    folders: [{ id: 'default', name: 'General' }],
    notes: [],
    currentNoteId: null,
    currentFolderId: 'all',
    sidebarHidden: true, // Start hidden on mobile
    expandedFolders: new Set(['all', 'default']),
    darkMode: false
  };

  let saveTimeout;
  let modalMode = null;
  let noteToMove = null;
  let activePalette = null;
  let savedRange = null;
  let searchQuery = '';
  
  // Calculator state
  let calcValue = '0';
  let calcPrevious = null;
  let calcOperator = null;
  let calcResetNext = false;
  let breadcrumbTrail = [];

  const presetColors = [
    '#000000', '#333333', '#666666', '#999999', '#CCCCCC', '#DDDDDD', '#EEEEEE', '#FFFFFF',
    '#8B0000', '#DC143C', '#FF4500', '#FFD700', '#ADFF2F', '#00FFFF', '#1E90FF', '#0000FF', 
    '#8A2BE2', '#FF00FF',
    '#F0C0C0', '#F5D0C5', '#F5E6D3', '#F5F5DC', '#E6F0E6', '#E0F0F0', '#D6E5F5', '#D6E0F0',
    '#E6E0F0', '#F0E0F0',
    '#D4A574', '#E8B4B4', '#F0D5A8', '#F5E6A3', '#C5D5A8', '#B8D4D4', '#A8C5E8', '#B8D4E8',
    '#C5B8E8', '#D8B8D8',
    '#B85450', '#D47474', '#E8A858', '#E8D858', '#78B850', '#78A8A8', '#5A90D8', '#6A90C8',
    '#7A68B8', '#A86898',
    '#8B0000', '#A52A2A', '#D2691E', '#B8860B', '#556B2F', '#2F4F4F', '#1E90FF', '#104E8B',
    '#4B0082', '#8B008B',
    '#800000', '#8B4513', '#A0522D', '#6B8E23', '#006400', '#004040', '#000080', '#191970',
    '#2E0050', '#4B004B'
  ];

  const standardColors = ['#000000', '#FFFFFF', '#4285F4', '#EA4335', '#FBBC05', '#34A853', '#FF6D01', '#46BDC6'];

  const SIDESCRIBE_TYPE = 'application/x-sidescribe-html';
  const SIDESCRIBE_MARKER = '<!-- SideScribeInternal -->';

  const editor = document.getElementById('editor');
  const overlay = document.getElementById('sidebarOverlay');

  loadData();
  setupEventListeners();
  setupColorPalettes();
  setupToggle();
  setupSearch();
  setupCalculator();
  setupPercentageCalculator();
  setupHeaderNewNote();
  setupDarkMode();
  setupSmartPaste();
  setupExportImport();
  setupGDriveSync();
  setupNoteLinking();
  setupEditorEnhancements();
  setupMobileSidebar();

  // ==================== STORAGE HELPERS ====================
  // Replace chrome.storage.local with localStorage + JSON

  function storageGet(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch(e) {
      console.error('[SideScribe] Storage error:', e);
    }
  }

  function storageRemove(key) {
    localStorage.removeItem(key);
  }

  // ==================== DATA ====================

  function loadData() {
    const saved = storageGet('sideScribeDB');
    if (saved) {
      db = saved;
      if (!db.folders) db.folders = [{ id: 'default', name: 'General' }];
      if (!db.notes) db.notes = [];
      if (db.sidebarHidden === undefined) db.sidebarHidden = true;
      if (!db.expandedFolders) db.expandedFolders = new Set(['all', 'default']);
      if (Array.isArray(db.expandedFolders)) {
        db.expandedFolders = new Set(db.expandedFolders);
      }
      if (db.darkMode === undefined) db.darkMode = false;
    } else {
      createNote('Welcome to SideScribe', 
        '<h3>Getting Started</h3><p>Your notes are organized under folders!</p><ul><li>Tap the ☰ menu to see folders</li><li>Create notes and folders</li><li>Sync across devices with Google Drive</li></ul><p>Install as an app from your browser for the best experience!</p>', 
        'default');
    }
    
    applyDarkMode();
    render();
    applySidebarState();
  }

  function saveData() {
    const dataToSave = {
      ...db,
      expandedFolders: Array.from(db.expandedFolders)
    };
    storageSet('sideScribeDB', dataToSave);

    if (typeof GDriveSync !== 'undefined' && GDriveSync.isSignedIn()) {
      GDriveSync.schedulePush(getLocalSyncData);
    }
  }

  function getLocalSyncData() {
    return { folders: db.folders, notes: db.notes };
  }

  function applyRemoteData(remoteData) {
    if (remoteData.folders) db.folders = remoteData.folders;
    if (remoteData.notes) db.notes = remoteData.notes;
    db.currentNoteId = null;
    db.currentFolderId = 'all';
    db.expandedFolders = new Set(['all', ...db.folders.map(f => f.id)]);
    saveDataLocalOnly();
    render();
  }

  function saveDataLocalOnly() {
    const dataToSave = {
      ...db,
      expandedFolders: Array.from(db.expandedFolders)
    };
    storageSet('sideScribeDB', dataToSave);
  }

  function createNote(title, content, folderId) {
    const note = {
      id: Date.now().toString(),
      title: title || 'Untitled Note',
      content: content || '',
      folderId: folderId || 'default',
      updatedAt: Date.now()
    };
    db.notes.push(note);
    db.currentNoteId = note.id;
    db.expandedFolders.add(folderId || 'default');
    saveData();
    return note;
  }

  function createFolder(name) {
    const folder = {
      id: Date.now().toString(),
      name: name || 'New Folder'
    };
    db.folders.push(folder);
    db.expandedFolders.add(folder.id);
    saveData();
    return folder;
  }

  function deleteFolder(folderId) {
    if (folderId === 'default' || folderId === 'all') return;
    const folder = db.folders.find(f => f.id === folderId);
    if (!folder) return;
    const notesInFolder = db.notes.filter(n => n.folderId === folderId);
    const noteCount = notesInFolder.length;
    let message = 'Delete folder "' + folder.name + '"?';
    if (noteCount > 0) message += '\n\n' + noteCount + ' note(s) will be moved to All Notes.';
    if (!confirm(message)) return;
    notesInFolder.forEach(n => { n.folderId = 'default'; });
    db.folders = db.folders.filter(f => f.id !== folderId);
    db.expandedFolders.delete(folderId);
    if (db.currentFolderId === folderId) db.currentFolderId = 'all';
    saveData();
    render();
  }

  function renameFolder(folderId) {
    if (folderId === 'default' || folderId === 'all') return;
    const folder = db.folders.find(f => f.id === folderId);
    if (!folder) return;
    const newName = prompt('Rename folder:', folder.name);
    if (newName === null || !newName.trim()) return;
    folder.name = newName.trim();
    saveData();
    render();
  }

  function renameNoteInSidebar(noteId) {
    const note = db.notes.find(n => n.id === noteId);
    if (!note) return;
    const newTitle = prompt('Rename note:', note.title || 'Untitled');
    if (newTitle === null || !newTitle.trim()) return;
    note.title = newTitle.trim();
    note.updatedAt = Date.now();
    saveData();
    render();
  }

  function getCurrentNote() {
    return db.notes.find(n => n.id === db.currentNoteId);
  }

  function deleteCurrentNote() {
    if (!db.currentNoteId) return;
    if (!confirm('Delete this note?')) return;
    db.notes = db.notes.filter(n => n.id !== db.currentNoteId);
    db.currentNoteId = null;
    saveData();
    render();
  }

  function moveNoteToFolder(noteId, folderId) {
    const note = db.notes.find(n => n.id === noteId);
    if (note) {
      note.folderId = folderId;
      note.updatedAt = Date.now();
      saveData();
      render();
    }
  }

  // ==================== MOBILE SIDEBAR ====================

  function setupMobileSidebar() {
    overlay.addEventListener('click', function() {
      db.sidebarHidden = true;
      applySidebarState();
      saveData();
    });
  }

  function isMobile() {
    return window.innerWidth <= 768;
  }

  // ==================== EXPORT / IMPORT ====================

  function setupExportImport() {
    const exportBtn = document.getElementById('btn-export');
    const importBtn = document.getElementById('btn-import');
    const fileInput = document.getElementById('importFileInput');
    const importModal = document.getElementById('importModal');
    const importCancel = document.getElementById('importCancel');
    const importConfirm = document.getElementById('importConfirm');
    let pendingImportData = null;

    exportBtn.addEventListener('click', function() {
      const exportData = {
        version: '2.8',
        exportedAt: new Date().toISOString(),
        app: 'SideScribe',
        folders: db.folders,
        notes: db.notes
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SideScribe-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      updateSaveStatus('saved');
    });

    importBtn.addEventListener('click', function() {
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.app || data.app !== 'SideScribe') {
            alert('This file is not a valid SideScribe backup.');
            return;
          }
          if (!Array.isArray(data.folders) || !Array.isArray(data.notes)) {
            alert('Invalid backup file: missing folders or notes.');
            return;
          }
          pendingImportData = data;
          const preview = document.getElementById('importPreview');
          const exportDate = data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'Unknown';
          preview.innerHTML = '<div><strong>File:</strong> ' + file.name + '</div>' +
            '<div><strong>Exported:</strong> ' + exportDate + '</div>' +
            '<div><strong>Folders:</strong> ' + data.folders.length + '</div>' +
            '<div><strong>Notes:</strong> ' + data.notes.length + '</div>';
          document.getElementById('importMerge').checked = true;
          importModal.classList.add('show');
        } catch (err) {
          alert('Could not read file. Make sure it is a valid SideScribe JSON backup.');
        }
      };
      reader.readAsText(file);
    });

    importCancel.addEventListener('click', function() {
      pendingImportData = null;
      importModal.classList.remove('show');
    });

    importConfirm.addEventListener('click', function() {
      if (!pendingImportData) return;
      const mode = document.querySelector('input[name="importMode"]:checked').value;
      if (mode === 'replace') {
        if (!confirm('This will replace ALL your current notes and folders. Are you sure?')) return;
        db.folders = pendingImportData.folders;
        db.notes = pendingImportData.notes;
        db.currentNoteId = null;
        db.currentFolderId = 'all';
      } else {
        const existingFolderIds = new Set(db.folders.map(f => f.id));
        pendingImportData.folders.forEach(folder => {
          if (!existingFolderIds.has(folder.id)) {
            db.folders.push(folder);
            existingFolderIds.add(folder.id);
          }
        });
        const existingNoteIds = new Set(db.notes.map(n => n.id));
        pendingImportData.notes.forEach(note => {
          if (existingNoteIds.has(note.id)) {
            note.id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
          }
          if (!existingFolderIds.has(note.folderId)) note.folderId = 'default';
          db.notes.push(note);
          existingNoteIds.add(note.id);
        });
      }
      db.folders.forEach(f => db.expandedFolders.add(f.id));
      db.expandedFolders.add('all');
      saveData();
      render();
      pendingImportData = null;
      importModal.classList.remove('show');
      alert('Import successful! Data ' + (mode === 'replace' ? 'replaced' : 'merged') + '.');
    });
  }

  // ==================== GOOGLE DRIVE SYNC ====================

  function setupGDriveSync() {
    const syncBtn = document.getElementById('btn-sync');
    const syncIcon = document.getElementById('syncIcon');
    const syncLabel = document.getElementById('syncLabel');
    const syncStatusText = document.getElementById('syncStatusText');
    const syncActions = document.getElementById('syncActions');
    const btnForcePull = document.getElementById('btn-force-pull');
    const btnForcePush = document.getElementById('btn-force-push');
    const btnSignOut = document.getElementById('btn-sign-out');
    const conflictModal = document.getElementById('syncConflictModal');
    const conflictCancel = document.getElementById('conflictCancel');
    const conflictConfirm = document.getElementById('conflictConfirm');
    let pendingConflictData = null;

    GDriveSync.onStatusChange(function(status, message) {
      syncStatusText.textContent = message || '';
      if (status === 'syncing') {
        syncIcon.textContent = '🔄';
        syncIcon.classList.add('spinning');
        syncLabel.textContent = 'Syncing...';
        syncBtn.disabled = true;
      } else if (status === 'synced') {
        syncIcon.textContent = '☁️';
        syncIcon.classList.remove('spinning');
        syncLabel.textContent = 'Synced';
        syncBtn.classList.add('signed-in');
        syncBtn.disabled = false;
        syncActions.style.display = 'flex';
      } else if (status === 'error') {
        syncIcon.textContent = '⚠️';
        syncIcon.classList.remove('spinning');
        syncLabel.textContent = 'Sync error';
        syncBtn.disabled = false;
      } else if (status === 'offline') {
        syncIcon.textContent = '☁️';
        syncIcon.classList.remove('spinning');
        syncLabel.textContent = 'Sign in to sync';
        syncBtn.classList.remove('signed-in');
        syncBtn.disabled = false;
        syncActions.style.display = 'none';
        syncStatusText.textContent = '';
      }
    });

    syncBtn.addEventListener('click', async function() {
      if (!GDriveSync.isSignedIn()) {
        // This navigates to Google OAuth — user will return with token in URL hash
        syncLabel.textContent = 'Redirecting...';
        syncBtn.disabled = true;
        GDriveSync.signIn();
      } else {
        await doSync();
      }
    });

    async function doSync() {
      try {
        const result = await GDriveSync.sync(getLocalSyncData);
        if (result && result.action === 'conflict' && result.data) {
          pendingConflictData = result.data;
          showConflictModal();
        }
      } catch (err) {
        console.error('[SideScribe] Sync error:', err);
      }
    }

    function showConflictModal() {
      document.getElementById('conflictPull').checked = true;
      conflictModal.classList.add('show');
    }

    conflictCancel.addEventListener('click', function() {
      pendingConflictData = null;
      conflictModal.classList.remove('show');
    });

    conflictConfirm.addEventListener('click', async function() {
      if (!pendingConflictData) return;
      const mode = document.querySelector('input[name="conflictMode"]:checked').value;
      if (mode === 'pull') {
        applyRemoteData(pendingConflictData);
        localStorage.setItem('sideScribeSyncTime', Date.now().toString());
      } else if (mode === 'push') {
        await GDriveSync.pushNow(getLocalSyncData);
      } else if (mode === 'merge') {
        mergeRemoteData(pendingConflictData);
        await GDriveSync.pushNow(getLocalSyncData);
      }
      pendingConflictData = null;
      conflictModal.classList.remove('show');
    });

    btnForcePull.addEventListener('click', async function() {
      try {
        const data = await GDriveSync.forcePull();
        if (data) {
          applyRemoteData(data);
          alert('Downloaded cloud data successfully.');
        } else {
          alert('No cloud data found.');
        }
      } catch (err) { alert('Pull failed: ' + err.message); }
    });

    btnForcePush.addEventListener('click', async function() {
      if (!confirm('This will overwrite your cloud data with local data. Continue?')) return;
      try {
        await GDriveSync.pushNow(getLocalSyncData);
        alert('Uploaded local data to cloud.');
      } catch (err) { alert('Push failed: ' + err.message); }
    });

    btnSignOut.addEventListener('click', async function() {
      if (!confirm('Sign out of Google Drive sync?')) return;
      await GDriveSync.signOut();
    });

    function mergeRemoteData(remoteData) {
      const existingFolderIds = new Set(db.folders.map(f => f.id));
      const existingNoteIds = new Set(db.notes.map(n => n.id));
      if (remoteData.folders) {
        remoteData.folders.forEach(folder => {
          if (!existingFolderIds.has(folder.id)) {
            db.folders.push(folder);
            existingFolderIds.add(folder.id);
          }
        });
      }
      if (remoteData.notes) {
        remoteData.notes.forEach(remoteNote => {
          const localNote = db.notes.find(n => n.id === remoteNote.id);
          if (!localNote) {
            if (!existingFolderIds.has(remoteNote.folderId)) remoteNote.folderId = 'default';
            db.notes.push(remoteNote);
          } else if (remoteNote.updatedAt > localNote.updatedAt) {
            Object.assign(localNote, remoteNote);
          }
        });
      }
      db.expandedFolders = new Set(['all', ...db.folders.map(f => f.id)]);
      saveDataLocalOnly();
      render();
    }

    // Auto sign-in on load
    const autoSignedIn = GDriveSync.tryAutoSignIn();
    if (autoSignedIn || wasOAuthRedirect) {
      syncBtn.classList.add('signed-in');
      syncLabel.textContent = 'Synced';
      syncIcon.textContent = '☁️';
      syncActions.style.display = 'flex';
      // Auto-sync
      setTimeout(function() { doSync().catch(function(err) { console.error('[SideScribe] Auto-sync failed:', err); }); }, 500);
    }
  }

  // ==================== TOGGLE & SIDEBAR ====================

  function setupToggle() {
    document.getElementById('toggleSidebar').addEventListener('click', function() {
      db.sidebarHidden = !db.sidebarHidden;
      applySidebarState();
      saveData();
    });
  }

  function applySidebarState() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('toggleSidebar');
    
    if (db.sidebarHidden) {
      sidebar.classList.add('hidden');
      overlay.classList.remove('show');
      toggleBtn.innerHTML = '<span id="toggleIcon">☰</span> <span>Menu</span>';
    } else {
      sidebar.classList.remove('hidden');
      if (isMobile()) overlay.classList.add('show');
      toggleBtn.innerHTML = '<span id="toggleIcon">✕</span> <span>Close</span>';
    }
  }

  // ==================== DARK MODE ====================

  function setupDarkMode() {
    document.getElementById('themeToggle').addEventListener('click', function() {
      db.darkMode = !db.darkMode;
      applyDarkMode();
      saveData();
    });
  }

  function applyDarkMode() {
    const body = document.body;
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');
    if (db.darkMode) {
      body.setAttribute('data-theme', 'dark');
      themeIcon.textContent = '☀️';
      themeText.textContent = 'Light';
    } else {
      body.removeAttribute('data-theme');
      themeIcon.textContent = '🌙';
      themeText.textContent = 'Dark';
    }
  }

  // ==================== NEW NOTE ====================

  function setupHeaderNewNote() {
    document.getElementById('headerNewNote').addEventListener('click', function() {
      const folderId = db.currentFolderId === 'all' ? 'default' : db.currentFolderId;
      createNote('', '', folderId);
      render();
      // Close sidebar on mobile after creating note
      if (isMobile() && !db.sidebarHidden) {
        db.sidebarHidden = true;
        applySidebarState();
        saveData();
      }
      setTimeout(function() {
        const titleInput = document.getElementById('noteTitle');
        if (titleInput) { titleInput.focus(); titleInput.select(); }
      }, 50);
    });
  }

  // ==================== SMART PASTE ====================

  function setupSmartPaste() {
    editor.addEventListener('copy', function(e) {
      if (!editor.contains(window.getSelection().anchorNode)) return;
      e.preventDefault();
      const selection = window.getSelection();
      const range = selection.getRangeAt(0);
      const plainText = selection.toString();
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      const htmlWithMarker = SIDESCRIBE_MARKER + container.innerHTML;
      e.clipboardData.setData('text/plain', plainText);
      e.clipboardData.setData(SIDESCRIBE_TYPE, htmlWithMarker);
    });
    
    editor.addEventListener('paste', function(e) {
      e.preventDefault();
      const internalHtml = e.clipboardData.getData(SIDESCRIBE_TYPE);
      if (internalHtml && internalHtml.includes(SIDESCRIBE_MARKER)) {
        const cleanHtml = internalHtml.replace(SIDESCRIBE_MARKER, '');
        document.execCommand('insertHTML', false, cleanHtml);
      } else {
        // Check for pasted images
        const items = e.clipboardData && e.clipboardData.items;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              const file = items[i].getAsFile();
              if (file) { processAndEmbedImage(file); return; }
            }
          }
        }
        const plainText = e.clipboardData.getData('text/plain');
        if (plainText) document.execCommand('insertText', false, plainText);
      }
      const note = getCurrentNote();
      if (note) {
        note.content = editor.innerHTML;
        note.updatedAt = Date.now();
        updateWordCount(note.content);
        delayedSave();
      }
    });
  }

  // ==================== CALCULATOR ====================

  function setupCalculator() {
    const calcBtn = document.getElementById('calc-btn');
    const calcDropdown = document.getElementById('calculatorDropdown');
    const calcInsert = document.getElementById('calcInsert');
    
    calcBtn.addEventListener('click', function(e) { e.stopPropagation(); toggleCalculator(); });
    document.addEventListener('click', function(e) {
      if (!calcDropdown.contains(e.target) && e.target !== calcBtn) closeCalculator();
    });
    
    calcDropdown.querySelectorAll('.calc-btn-reg').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const action = this.dataset.action;
        const value = this.dataset.value;
        switch(action) {
          case 'number': inputNumber(value); break;
          case 'operator': inputOperator(value); break;
          case 'calculate': calculateCalc(); break;
          case 'clear': clearCalc(); break;
          case 'backspace': backspaceCalc(); break;
        }
        updateCalcDisplay();
      });
    });
    
    calcInsert.addEventListener('click', function(e) {
      e.stopPropagation();
      const result = document.getElementById('calcDisplay').textContent;
      if (result !== '0' && result !== 'Error') { insertTextAtCursor(result); closeCalculator(); }
    });
  }
  
  function toggleCalculator() {
    const calcDropdown = document.getElementById('calculatorDropdown');
    const calcBtn = document.getElementById('calc-btn');
    closePercentageCalculator();
    if (calcDropdown.classList.contains('show')) { closeCalculator(); return; }
    closePalettes();
    const btnRect = calcBtn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = btnRect.left;
    let right = 'auto';
    if (btnRect.left + 220 > vw) { left = 'auto'; right = vw - btnRect.right; }
    let top = btnRect.bottom + 4;
    if (top + 280 > vh) top = btnRect.top - 280 - 4;
    calcDropdown.style.left = left === 'auto' ? 'auto' : left + 'px';
    calcDropdown.style.right = right === 'auto' ? 'auto' : right + 'px';
    calcDropdown.style.top = top + 'px';
    calcDropdown.classList.add('show');
  }
  
  function closeCalculator() { document.getElementById('calculatorDropdown').classList.remove('show'); }
  
  function inputNumber(num) {
    if (calcResetNext) { calcValue = num === '.' ? '0.' : num; calcResetNext = false; }
    else {
      if (num === '.' && calcValue.includes('.')) return;
      calcValue = calcValue === '0' && num !== '.' ? num : calcValue + num;
    }
  }
  
  function inputOperator(op) {
    if (calcOperator && !calcResetNext) calculateCalc();
    calcPrevious = parseFloat(calcValue);
    calcOperator = op;
    calcResetNext = true;
  }
  
  function calculateCalc() {
    if (calcOperator === null || calcPrevious === null) return;
    const current = parseFloat(calcValue);
    let result;
    switch(calcOperator) {
      case '+': result = calcPrevious + current; break;
      case '-': result = calcPrevious - current; break;
      case '*': result = calcPrevious * current; break;
      case '/':
        if (current === 0) { calcValue = 'Error'; calcPrevious = null; calcOperator = null; calcResetNext = true; return; }
        result = calcPrevious / current; break;
    }
    calcValue = String(Math.round(result * 100000000) / 100000000);
    calcPrevious = null;
    calcOperator = null;
    calcResetNext = true;
  }
  
  function clearCalc() { calcValue = '0'; calcPrevious = null; calcOperator = null; calcResetNext = false; }
  function backspaceCalc() { calcValue = calcValue.length > 1 ? calcValue.slice(0, -1) : '0'; }
  function updateCalcDisplay() { document.getElementById('calcDisplay').textContent = calcValue; }

  // ==================== PERCENTAGE CALCULATOR ====================

  function setupPercentageCalculator() {
    const percBtn = document.getElementById('perc-btn');
    const percDropdown = document.getElementById('percentageDropdown');
    
    percBtn.addEventListener('click', function(e) { e.stopPropagation(); togglePercentageCalculator(); });
    document.addEventListener('click', function(e) {
      if (!percDropdown.contains(e.target) && e.target !== percBtn) closePercentageCalculator();
    });

    percDropdown.querySelectorAll('.perc-calculate').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); calculatePercentage(parseInt(this.dataset.mode)); });
    });

    percDropdown.querySelectorAll('.perc-insert').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const resultEl = document.getElementById('result' + this.dataset.result);
        const resultText = resultEl.textContent.trim();
        if (resultText && resultText !== '--' && !resultText.includes('Enter') && !resultText.includes('Cannot')) {
          insertTextAtCursor(resultText.replace(/Result:\s*/, '').trim());
          closePercentageCalculator();
        }
      });
    });

    document.getElementById('percClearAll').addEventListener('click', function(e) {
      e.stopPropagation();
      ['p1-percent','p1-of','p2-is','p2-of','p3-from','p3-to'].forEach(function(id) { document.getElementById(id).value = ''; });
      ['result1','result2','result3'].forEach(function(id) { document.getElementById(id).textContent = ''; });
    });

    percDropdown.querySelectorAll('.perc-input').forEach(function(input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); var cb = this.closest('.perc-section').querySelector('.perc-calculate'); if (cb) cb.click(); }
      });
    });
  }

  function togglePercentageCalculator() {
    const percDropdown = document.getElementById('percentageDropdown');
    const percBtn = document.getElementById('perc-btn');
    closeCalculator();
    if (percDropdown.classList.contains('show')) { closePercentageCalculator(); return; }
    closePalettes();
    const btnRect = percBtn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = Math.min(340, vw - 32);
    let left = btnRect.left;
    let right = 'auto';
    if (btnRect.left + pw > vw) { left = 'auto'; right = Math.max(0, vw - btnRect.right); }
    let top = btnRect.bottom + 4;
    if (top + 420 > vh) top = btnRect.top - 420 - 4;
    percDropdown.style.left = left === 'auto' ? 'auto' : left + 'px';
    percDropdown.style.right = right === 'auto' ? 'auto' : right + 'px';
    percDropdown.style.top = Math.max(0, top) + 'px';
    percDropdown.classList.add('show');
  }
  
  function closePercentageCalculator() { document.getElementById('percentageDropdown').classList.remove('show'); }

  function calculatePercentage(mode) {
    if (mode === 1) {
      const p = parseFloat(document.getElementById('p1-percent').value);
      const o = parseFloat(document.getElementById('p1-of').value);
      document.getElementById('result1').textContent = (!isNaN(p) && !isNaN(o)) ? 'Result: ' + formatNum((p / 100) * o) : 'Enter numbers';
    } else if (mode === 2) {
      const is = parseFloat(document.getElementById('p2-is').value);
      const of2 = parseFloat(document.getElementById('p2-of').value);
      if (of2 === 0) document.getElementById('result2').textContent = 'Cannot divide by 0';
      else document.getElementById('result2').textContent = (!isNaN(is) && !isNaN(of2)) ? 'Result: ' + formatNum((is / of2) * 100) + '%' : 'Enter numbers';
    } else if (mode === 3) {
      const from = parseFloat(document.getElementById('p3-from').value);
      const to = parseFloat(document.getElementById('p3-to').value);
      if (from === 0) document.getElementById('result3').textContent = 'Cannot calculate from 0';
      else if (!isNaN(from) && !isNaN(to)) {
        const c = ((to - from) / Math.abs(from)) * 100;
        document.getElementById('result3').textContent = 'Result: ' + (c >= 0 ? '+' : '') + formatNum(c) + '% ' + (c >= 0 ? 'increase' : 'decrease');
      } else document.getElementById('result3').textContent = 'Enter numbers';
    }
  }

  function formatNum(n) { return parseFloat(n.toFixed(2)).toString(); }
  
  function insertTextAtCursor(text) {
    editor.focus();
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(range);
      const note = getCurrentNote();
      if (note) { note.content = editor.innerHTML; note.updatedAt = Date.now(); updateWordCount(note.content); delayedSave(); }
    }
  }

  // ==================== RENDER ====================

  function render() {
    renderFolderTree();
    renderEditor();
    updateSaveStatus('ready');
  }

  function renderFolderTree() {
    const tree = document.getElementById('folderTree');
    if (searchQuery) { renderSearchResults(tree); return; }
    const allCount = db.notes.length;
    const isAllExpanded = db.expandedFolders.has('all');
    const isAllActive = db.currentFolderId === 'all';
    
    let html = '<div class="folder-section">' +
      '<div class="folder-header ' + (isAllActive ? 'active' : '') + ' ' + (isAllExpanded ? 'expanded' : '') + '" data-folder="all">' +
      '<span class="arrow">▶</span><span class="icon">📁</span><span class="name">All Notes</span><span class="count">' + allCount + '</span></div>' +
      '<div class="folder-notes ' + (isAllExpanded ? 'expanded' : '') + ' ' + (isAllActive ? 'active-folder' : '') + '">' +
      renderNotesForFolder('all') + '</div></div>';
    
    db.folders.forEach(function(folder) {
      if (folder.id === 'default') return;
      const count = db.notes.filter(n => n.folderId === folder.id).length;
      const isExpanded = db.expandedFolders.has(folder.id);
      const isActive = db.currentFolderId === folder.id;
      html += '<div class="folder-section">' +
        '<div class="folder-header ' + (isActive ? 'active' : '') + ' ' + (isExpanded ? 'expanded' : '') + '" data-folder="' + folder.id + '">' +
        '<span class="arrow">▶</span><span class="icon">📂</span><span class="name">' + escapeHtml(folder.name) + '</span><span class="count">' + count + '</span>' +
        '<button class="folder-rename-btn" data-rename-folder="' + folder.id + '" title="Rename">✏</button>' +
        '<button class="folder-delete-btn" data-delete-folder="' + folder.id + '" title="Delete">🗑</button>' +
        '</div>' +
        '<div class="folder-notes ' + (isExpanded ? 'expanded' : '') + ' ' + (isActive ? 'active-folder' : '') + '">' +
        renderNotesForFolder(folder.id) + '</div></div>';
    });
    
    tree.innerHTML = html;
    attachFolderTreeListeners();
  }

  function renderSearchResults(container) {
    const query = searchQuery.toLowerCase();
    const results = db.notes.filter(function(note) {
      return (note.title || '').toLowerCase().includes(query) || (note.content || '').toLowerCase().includes(query);
    }).sort(function(a, b) { return b.updatedAt - a.updatedAt; });
    
    let html = '<div class="folder-section"><div class="folder-header active expanded" data-folder="search">' +
      '<span class="arrow">▶</span><span class="icon">🔍</span><span class="name">Search Results</span><span class="count">' + results.length + '</span>' +
      '</div><div class="folder-notes expanded active-folder">';
    
    if (results.length === 0) {
      html += '<div class="empty-state">No notes found</div>';
    } else {
      results.forEach(function(note) {
        const date = new Date(note.updatedAt).toLocaleDateString();
        const isActive = note.id === db.currentNoteId;
        const folder = db.folders.find(f => f.id === note.folderId);
        const folderName = (folder && folder.id !== 'default') ? folder.name : 'All Notes';
        let title = escapeHtml(note.title) || 'Untitled';
        if (title.toLowerCase().includes(query)) title = highlightMatch(title, query);
        html += '<div class="note-item ' + (isActive ? 'active' : '') + '" data-note="' + note.id + '">' +
          '<div class="title">' + title + '</div><div class="date">' + folderName + ' • ' + date + '</div>' +
          '<button class="move-btn" data-note="' + note.id + '" title="Move to folder">→</button></div>';
      });
    }
    
    html += '</div></div>';
    container.innerHTML = html;
    attachFolderTreeListeners();
  }

  function getTextContent(html) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    return div.textContent || '';
  }

  function highlightMatch(text, query) {
    return text.replace(new RegExp('(' + escapeRegex(query) + ')', 'gi'), '<span class="search-match">$1</span>');
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function attachFolderTreeListeners() {
    const tree = document.getElementById('folderTree');
    
    tree.querySelectorAll('.folder-header').forEach(function(header) {
      header.addEventListener('click', function(e) {
        if (e.target.classList.contains('move-btn')) return;
        const folderId = this.dataset.folder;
        if (folderId === 'search') return;
        if (db.expandedFolders.has(folderId)) db.expandedFolders.delete(folderId);
        else db.expandedFolders.add(folderId);
        db.currentFolderId = folderId;
        render();
        saveData();
      });
    });
    
    tree.querySelectorAll('.note-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.classList.contains('move-btn')) return;
        saveCurrentNote();
        db.currentNoteId = this.dataset.note;
        render();
        // Close sidebar on mobile
        if (isMobile() && !db.sidebarHidden) {
          db.sidebarHidden = true;
          applySidebarState();
          saveData();
        }
      });
    });
    
    tree.querySelectorAll('.move-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); showMoveModal(this.dataset.note); });
    });

    tree.querySelectorAll('.folder-delete-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); deleteFolder(this.dataset.deletefolder || this.dataset.deleteFolder); });
    });

    tree.querySelectorAll('.folder-rename-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); renameFolder(this.dataset.renameFolder || this.dataset.renamefolder); });
    });

    tree.querySelectorAll('.note-item .title').forEach(function(titleEl) {
      titleEl.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        renameNoteInSidebar(this.closest('.note-item').dataset.note);
      });
    });
  }

  function renderNotesForFolder(folderId) {
    let notes = db.notes;
    if (folderId !== 'all') notes = notes.filter(n => n.folderId === folderId);
    notes.sort(function(a, b) { return b.updatedAt - a.updatedAt; });
    if (notes.length === 0) return '<div class="empty-state">No notes</div>';
    let html = '';
    notes.forEach(function(note) {
      const date = new Date(note.updatedAt).toLocaleDateString();
      const isActive = note.id === db.currentNoteId;
      html += '<div class="note-item ' + (isActive ? 'active' : '') + '" data-note="' + note.id + '">' +
        '<div class="title">' + (escapeHtml(note.title) || 'Untitled') + '</div>' +
        '<div class="date">' + date + '</div>' +
        '<button class="move-btn" data-note="' + note.id + '" title="Move to folder">→</button></div>';
    });
    return html;
  }

  function renderEditor() {
    const note = getCurrentNote();
    const titleInput = document.getElementById('noteTitle');
    const editorEl = document.getElementById('editor');
    const deleteBtn = document.getElementById('btn-delete');
    const linkNoteBtn = document.getElementById('btn-link-note');
    const checklistBtn = document.getElementById('btn-checklist');
    const tableBtn = document.getElementById('btn-table');
    const imageBtn = document.getElementById('btn-image');
    const codeBtn = document.getElementById('btn-code');
    
    if (!note) {
      titleInput.value = '';
      editorEl.innerHTML = '<div class="empty-state">Select a note or create a new one</div>';
      editorEl.contentEditable = false;
      deleteBtn.style.display = 'none';
      linkNoteBtn.style.display = 'none';
      checklistBtn.style.display = 'none';
      tableBtn.style.display = 'none';
      imageBtn.style.display = 'none';
      codeBtn.style.display = 'none';
      updateWordCount('');
      return;
    }
    
    editorEl.contentEditable = true;
    deleteBtn.style.display = 'inline-flex';
    linkNoteBtn.style.display = 'inline-flex';
    checklistBtn.style.display = 'inline-flex';
    tableBtn.style.display = 'inline-flex';
    imageBtn.style.display = 'inline-flex';
    codeBtn.style.display = 'inline-flex';
    titleInput.value = note.title;
    editorEl.innerHTML = note.content;
    updateWordCount(note.content);
    updateBreadcrumbs();
  }

  // ==================== EDITOR ENHANCEMENTS ====================

  function setupEditorEnhancements() {
    setupChecklist();
    setupTableInsert();
    setupImageEmbed();
    setupCodeBlock();
    setupHorizontalRule();
  }

  function setupHorizontalRule() {
    document.getElementById('btn-hr').addEventListener('click', function() {
      editor.focus();
      document.execCommand('insertHTML', false, '<hr><p><br></p>');
      delayedSave();
    });
  }

  // ---- CHECKLISTS ----
  function setupChecklist() {
    document.getElementById('btn-checklist').addEventListener('click', function() {
      editor.focus();
      document.execCommand('insertHTML', false,
        '<div class="checklist-item"><input type="checkbox"><span class="checklist-text" contenteditable="true">New item</span></div>');
      delayedSave();
    });

    editor.addEventListener('change', function(e) {
      if (e.target.type === 'checkbox') {
        const item = e.target.closest('.checklist-item');
        if (item) { item.classList.toggle('checked', e.target.checked); delayedSave(); }
      }
    });

    editor.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        const sel = window.getSelection();
        const checklistItem = sel.anchorNode && sel.anchorNode.closest ? sel.anchorNode.closest('.checklist-item') : null;
        const parentItem = checklistItem || (sel.anchorNode && sel.anchorNode.parentElement ? sel.anchorNode.parentElement.closest('.checklist-item') : null);
        if (parentItem) {
          e.preventDefault();
          const textSpan = parentItem.querySelector('.checklist-text');
          const textContent = textSpan ? textSpan.textContent.replace(/\u200B/g, '').trim() : '';
          if (!textContent) {
            const div = document.createElement('div');
            div.innerHTML = '<br>';
            parentItem.after(div);
            parentItem.remove();
            setTimeout(function() {
              const range = document.createRange();
              range.selectNodeContents(div);
              range.collapse(true);
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(range);
            }, 0);
          } else {
            const newItem = document.createElement('div');
            newItem.className = 'checklist-item';
            newItem.innerHTML = '<input type="checkbox"><span class="checklist-text" contenteditable="true">\u200B</span>';
            parentItem.after(newItem);
            setTimeout(function() {
              const newTextSpan = newItem.querySelector('.checklist-text');
              newTextSpan.focus();
              const range = document.createRange();
              range.selectNodeContents(newTextSpan);
              range.collapse(false);
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(range);
            }, 0);
          }
          delayedSave();
        }
      }
    });
  }

  // ---- TABLE INSERT ----
  function setupTableInsert() {
    const btn = document.getElementById('btn-table');
    const picker = document.getElementById('tableSizePicker');
    const grid = document.getElementById('tableSizeGrid');
    const label = document.getElementById('tableSizeLabel');
    let selectedRows = 0, selectedCols = 0, tableInsertRange = null;

    for (let r = 1; r <= 6; r++) {
      for (let c = 1; c <= 6; c++) {
        const cell = document.createElement('div');
        cell.className = 'table-size-cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        grid.appendChild(cell);
      }
    }

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      const isOpen = picker.classList.contains('show');
      document.querySelectorAll('.table-size-picker.show, .link-note-dropdown.show').forEach(function(el) { el.classList.remove('show'); });
      if (!isOpen) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) tableInsertRange = sel.getRangeAt(0).cloneRange();
        picker.classList.add('show');
        selectedRows = 0; selectedCols = 0; updateGrid();
      }
    });

    grid.addEventListener('mouseover', function(e) {
      const cell = e.target.closest('.table-size-cell');
      if (!cell) return;
      selectedRows = parseInt(cell.dataset.row);
      selectedCols = parseInt(cell.dataset.col);
      updateGrid();
    });

    // Touch support for table size grid
    grid.addEventListener('touchmove', function(e) {
      const touch = e.touches[0];
      const elem = document.elementFromPoint(touch.clientX, touch.clientY);
      if (elem && elem.classList.contains('table-size-cell')) {
        selectedRows = parseInt(elem.dataset.row);
        selectedCols = parseInt(elem.dataset.col);
        updateGrid();
      }
    });

    grid.addEventListener('click', function(e) {
      const cell = e.target.closest('.table-size-cell');
      if (!cell) return;
      e.stopPropagation();
      insertTable(parseInt(cell.dataset.row), parseInt(cell.dataset.col));
      picker.classList.remove('show');
    });

    picker.addEventListener('click', function(e) { e.stopPropagation(); });
    document.addEventListener('click', function() { picker.classList.remove('show'); });

    function updateGrid() {
      grid.querySelectorAll('.table-size-cell').forEach(function(cell) {
        const r = parseInt(cell.dataset.row);
        const c = parseInt(cell.dataset.col);
        cell.classList.toggle('active', r <= selectedRows && c <= selectedCols);
      });
      label.textContent = selectedRows && selectedCols ? selectedRows + ' × ' + selectedCols : 'Select size';
    }

    function insertTable(rows, cols) {
      let html = '<table><tr>';
      for (let c = 0; c < cols; c++) html += '<th contenteditable="true">Header</th>';
      html += '</tr>';
      for (let r = 1; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td contenteditable="true"></td>';
        html += '</tr>';
      }
      html += '</table><p><br></p>';
      if (tableInsertRange && editor.contains(tableInsertRange.startContainer)) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(tableInsertRange);
      } else editor.focus();
      document.execCommand('insertHTML', false, html);
      tableInsertRange = null;
      delayedSave();
    }

    // Table context bar
    const contextBar = document.getElementById('tableContextBar');
    const editorContainer = document.querySelector('.editor-container');
    let activeCell = null;

    editor.addEventListener('click', function(e) {
      const cell = e.target.closest('td, th');
      if (cell && editor.contains(cell)) { activeCell = cell; showTableContextBar(cell); }
      else hideTableContextBar();
    });

    editor.addEventListener('keyup', function() {
      if (activeCell && editor.contains(activeCell)) showTableContextBar(activeCell);
    });

    function showTableContextBar(cell) {
      const containerRect = editorContainer.getBoundingClientRect();
      const row = cell.closest('tr');
      const table = cell.closest('table');
      const rowRect = row.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      contextBar.classList.add('show');
      contextBar.style.top = (rowRect.bottom - containerRect.top + editorContainer.scrollTop + 2) + 'px';
      contextBar.style.left = (tableRect.left - containerRect.left) + 'px';
    }

    function hideTableContextBar() { contextBar.classList.remove('show'); activeCell = null; }

    document.addEventListener('click', function(e) { if (!e.target.closest('td, th, .table-context-bar')) hideTableContextBar(); });
    contextBar.addEventListener('click', function(e) { e.stopPropagation(); });

    function addRow(above) {
      if (!activeCell) return;
      const row = activeCell.closest('tr');
      const table = row.closest('table');
      const cols = row.cells.length;
      const newRow = table.insertRow(above ? row.rowIndex : row.rowIndex + 1);
      for (let i = 0; i < cols; i++) { const td = newRow.insertCell(); td.contentEditable = 'true'; }
      delayedSave();
    }

    function addCol(left) {
      if (!activeCell) return;
      const colIdx = left ? activeCell.cellIndex : activeCell.cellIndex + 1;
      const table = activeCell.closest('table');
      Array.from(table.rows).forEach(function(row) {
        const cell = row.insertCell(colIdx);
        cell.contentEditable = 'true';
        const ref = left ? row.cells[colIdx + 1] : row.cells[colIdx - 1];
        if (ref && ref.tagName === 'TH') {
          const th = document.createElement('th');
          th.contentEditable = 'true';
          th.textContent = 'Header';
          row.replaceChild(th, cell);
        }
      });
      delayedSave();
    }

    document.getElementById('tbl-add-row-above').addEventListener('click', function() { addRow(true); });
    document.getElementById('tbl-add-row-below').addEventListener('click', function() { addRow(false); });
    document.getElementById('tbl-add-col-left').addEventListener('click', function() { addCol(true); });
    document.getElementById('tbl-add-col-right').addEventListener('click', function() { addCol(false); });

    document.getElementById('tbl-del-row').addEventListener('click', function() {
      if (!activeCell) return;
      const row = activeCell.closest('tr');
      const table = row.closest('table');
      if (table.rows.length <= 1) table.remove(); else row.remove();
      hideTableContextBar();
      delayedSave();
    });

    document.getElementById('tbl-del-col').addEventListener('click', function() {
      if (!activeCell) return;
      const colIdx = activeCell.cellIndex;
      const table = activeCell.closest('table');
      if (table.rows[0].cells.length <= 1) table.remove();
      else Array.from(table.rows).forEach(function(row) { if (row.cells[colIdx]) row.deleteCell(colIdx); });
      hideTableContextBar();
      delayedSave();
    });

    document.getElementById('tbl-del-table').addEventListener('click', function() {
      if (!activeCell) return;
      activeCell.closest('table').remove();
      hideTableContextBar();
      delayedSave();
    });
  }

  // ---- IMAGE EMBED ----
  let selectedImg = null;

  function setupImageEmbed() {
    const btn = document.getElementById('btn-image');
    const fileInput = document.getElementById('imageFileInput');
    const imageToolbar = document.getElementById('imageToolbar');
    const editorContainer = document.querySelector('.editor-container');

    btn.addEventListener('click', function() { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', function(e) { if (e.target.files[0]) processAndEmbedImage(e.target.files[0]); });

    editor.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    editor.addEventListener('drop', function(e) {
      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type.startsWith('image/')) { e.preventDefault(); processAndEmbedImage(files[0]); }
    });

    editor.addEventListener('click', function(e) {
      const img = e.target.closest('img.embedded-image');
      if (selectedImg && selectedImg !== img) selectedImg.classList.remove('selected');
      if (img && editor.contains(img)) { selectedImg = img; img.classList.add('selected'); showImageToolbar(img); }
      else hideImageToolbar();
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('img.embedded-image, .image-toolbar')) hideImageToolbar();
    });

    imageToolbar.addEventListener('click', function(e) { e.stopPropagation(); });

    function showImageToolbar(img) {
      const containerRect = editorContainer.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      imageToolbar.classList.add('show');
      imageToolbar.style.top = (imgRect.bottom - containerRect.top + editorContainer.scrollTop + 4) + 'px';
      imageToolbar.style.left = Math.max(0, imgRect.left - containerRect.left) + 'px';
      updateImgToolbarActive(img);
    }

    function hideImageToolbar() {
      imageToolbar.classList.remove('show');
      if (selectedImg) { selectedImg.classList.remove('selected'); selectedImg = null; }
    }

    function updateImgToolbarActive(img) {
      document.getElementById('img-small').classList.toggle('active', img.classList.contains('img-small'));
      document.getElementById('img-medium').classList.toggle('active', img.classList.contains('img-medium'));
      document.getElementById('img-bestfit').classList.toggle('active', img.classList.contains('img-bestfit') || (!img.classList.contains('img-small') && !img.classList.contains('img-medium')));
    }

    function setImageSize(cls) {
      if (!selectedImg) return;
      selectedImg.classList.remove('img-small', 'img-medium', 'img-bestfit');
      if (cls) selectedImg.classList.add(cls);
      updateImgToolbarActive(selectedImg);
      showImageToolbar(selectedImg);
      delayedSave();
    }

    document.getElementById('img-small').addEventListener('click', function() { setImageSize('img-small'); });
    document.getElementById('img-medium').addEventListener('click', function() { setImageSize('img-medium'); });
    document.getElementById('img-bestfit').addEventListener('click', function() { setImageSize('img-bestfit'); });
    document.getElementById('img-remove').addEventListener('click', function() { if (selectedImg) { selectedImg.remove(); hideImageToolbar(); delayedSave(); } });
  }

  function processAndEmbedImage(file) {
    const MAX_SIZE = 2 * 1024 * 1024;
    if (file.size <= MAX_SIZE) {
      readAndInsertImage(file);
    } else {
      compressImage(file, MAX_SIZE, function(url) { insertImageHtml(url); });
    }
  }

  function readAndInsertImage(file) {
    const reader = new FileReader();
    reader.onload = function(e) { insertImageHtml(e.target.result); };
    reader.readAsDataURL(file);
  }

  function insertImageHtml(dataUrl) {
    const html = '<img src="' + dataUrl + '" class="embedded-image img-bestfit" alt="Embedded image"><p><br></p>';
    editor.focus();
    document.execCommand('insertHTML', false, html);
    delayedSave();
  }

  function compressImage(file, maxBytes, callback) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const url = e.target.result;
      const img = new Image();
      img.onload = function() {
        let width = img.width, height = img.height;
        const maxDim = 1200;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        function tryCompress(q) {
          const dataUrl = canvas.toDataURL('image/jpeg', q);
          const est = Math.round((dataUrl.length - 23) * 0.75);
          if (est <= maxBytes || q <= 0.1) callback(dataUrl);
          else tryCompress(q - 0.1);
        }
        tryCompress(0.8);
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  }

  // ---- CODE BLOCK ----
  function setupCodeBlock() {
    document.getElementById('btn-code').addEventListener('click', function() {
      const sel = window.getSelection();
      const selectedText = sel.toString().trim();
      const codeContent = selectedText || '// Your code here';
      const codeHtml = '<pre class="code-block" contenteditable="true"><code>' + escapeHtmlForCode(codeContent) + '</code></pre><p><br></p>';
      editor.focus();
      document.execCommand('insertHTML', false, codeHtml);
      delayedSave();
    });

    editor.addEventListener('input', function() {
      const sel = window.getSelection();
      if (!sel.anchorNode) return;
      const codeBlock = sel.anchorNode.closest ? sel.anchorNode.closest('pre.code-block') : null;
      const parentBlock = codeBlock || (sel.anchorNode.parentElement ? sel.anchorNode.parentElement.closest('pre.code-block') : null);
      if (parentBlock) applySyntaxHighlight(parentBlock);
    });

    editor.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        const sel = window.getSelection();
        const anchor = sel.anchorNode;
        const tableCell = anchor && anchor.closest ? anchor.closest('td, th') : (anchor && anchor.parentElement ? anchor.parentElement.closest('td, th') : null);
        if (tableCell && editor.contains(tableCell)) return; // Handled in table code
        const codeBlock = anchor && anchor.closest ? anchor.closest('pre.code-block') : (anchor && anchor.parentElement ? anchor.parentElement.closest('pre.code-block') : null);
        if (codeBlock) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      }
      if (e.key === 'Enter') {
        const sel = window.getSelection();
        const codeBlock = sel.anchorNode && sel.anchorNode.closest ? sel.anchorNode.closest('pre.code-block') : null;
        const parentBlock = codeBlock || (sel.anchorNode && sel.anchorNode.parentElement ? sel.anchorNode.parentElement.closest('pre.code-block') : null);
        if (parentBlock) { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
      }
    });
  }

  function escapeHtmlForCode(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function applySyntaxHighlight(pre) {
    const code = pre.querySelector('code');
    if (!code) return;
    const sel = window.getSelection();
    let cursorOffset = 0, inCode = false;
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (pre.contains(range.startContainer)) {
        inCode = true;
        const preRange = document.createRange();
        preRange.selectNodeContents(code);
        preRange.setEnd(range.startContainer, range.startOffset);
        cursorOffset = preRange.toString().length;
      }
    }
    const text = code.textContent;
    const highlighted = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/(\/\/.*)/gm, '<span class="cmt">$1</span>')
      .replace(/(&quot;[^&]*&quot;|'[^']*'|`[^`]*`)/g, '<span class="str">$1</span>')
      .replace(/("[^"]*")/g, '<span class="str">$1</span>')
      .replace(/\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|true|false|null|undefined|try|catch|throw|switch|case|break|default|typeof|instanceof)\b/g, '<span class="kw">$1</span>')
      .replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
    code.innerHTML = highlighted;

    if (inCode && cursorOffset >= 0) {
      try {
        const newRange = document.createRange();
        let charCount = 0, found = false;
        function walkNodes(node) {
          if (found) return;
          if (node.nodeType === 3) {
            const nextCount = charCount + node.length;
            if (cursorOffset <= nextCount) { newRange.setStart(node, cursorOffset - charCount); newRange.collapse(true); found = true; return; }
            charCount = nextCount;
          } else { for (let child of node.childNodes) { walkNodes(child); if (found) return; } }
        }
        walkNodes(code);
        if (found) { sel.removeAllRanges(); sel.addRange(newRange); }
      } catch (e) {}
    }
  }

  // ==================== NOTE LINKING & BREADCRUMBS ====================

  function setupNoteLinking() {
    const linkBtn = document.getElementById('btn-link-note');
    const dropdown = document.getElementById('linkNoteDropdown');
    const searchInput = document.getElementById('linkNoteSearch');
    const listEl = document.getElementById('linkNoteList');
    const breadcrumbBar = document.getElementById('breadcrumbBar');
    const breadcrumbClose = document.getElementById('breadcrumbClose');

    linkBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('show');
      closeAllDropdowns();
      if (!isOpen) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) savedRange = sel.getRangeAt(0);
        dropdown.classList.add('show');
        searchInput.value = '';
        searchInput.focus();
        populateLinkNoteList('');
      }
    });

    searchInput.addEventListener('input', function() { populateLinkNoteList(this.value.trim().toLowerCase()); });
    dropdown.addEventListener('click', function(e) { e.stopPropagation(); });
    document.addEventListener('click', function() { dropdown.classList.remove('show'); });

    function populateLinkNoteList(query) {
      let notes = db.notes.filter(n => n.id !== db.currentNoteId);
      if (query) notes = notes.filter(n => (n.title || '').toLowerCase().includes(query));
      notes.sort(function(a, b) { return b.updatedAt - a.updatedAt; });
      if (notes.length === 0) { listEl.innerHTML = '<div class="link-note-empty">No notes found</div>'; return; }
      let html = '';
      notes.forEach(function(note) {
        const folder = db.folders.find(f => f.id === note.folderId);
        const folderName = (folder && folder.id !== 'default') ? folder.name : '';
        html += '<div class="link-note-item" data-note-id="' + note.id + '">' +
          '<span class="link-note-title">' + escapeHtml(note.title || 'Untitled') + '</span>' +
          (folderName ? '<span class="link-note-folder">' + escapeHtml(folderName) + '</span>' : '') + '</div>';
      });
      listEl.innerHTML = html;
      listEl.querySelectorAll('.link-note-item').forEach(function(item) {
        item.addEventListener('click', function() { insertNoteLink(this.dataset.noteId); dropdown.classList.remove('show'); });
      });
    }

    function insertNoteLink(targetNoteId) {
      const targetNote = db.notes.find(n => n.id === targetNoteId);
      if (!targetNote) return;
      const sel = window.getSelection();
      if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
      if (!editor.contains(sel.anchorNode)) {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const selectedText = sel.toString().trim();
      const linkLabel = selectedText || ('📎 ' + escapeHtml(targetNote.title || 'Untitled'));
      document.execCommand('insertHTML', false, '<a class="note-link" data-note-link="' + targetNoteId + '" href="#" title="Go to: ' + escapeHtml(targetNote.title || 'Untitled') + '">' + linkLabel + '</a>&nbsp;');
      delayedSave();
    }

    editor.addEventListener('click', function(e) {
      const link = e.target.closest('.note-link, [data-note-link]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const targetId = link.dataset.noteLink;
      if (!targetId) return;
      const targetNote = db.notes.find(n => n.id === targetId);
      if (!targetNote) { alert('Linked note not found.'); return; }
      saveCurrentNoteContent();
      const currentNote = getCurrentNote();
      if (currentNote) {
        if (breadcrumbTrail.length === 0 || breadcrumbTrail[breadcrumbTrail.length - 1].noteId !== currentNote.id) {
          breadcrumbTrail.push({ noteId: currentNote.id, title: currentNote.title || 'Untitled' });
        }
      }
      db.currentNoteId = targetId;
      render();
    });

    breadcrumbClose.addEventListener('click', function() { breadcrumbTrail = []; updateBreadcrumbs(); });
  }

  function updateBreadcrumbs() {
    const bar = document.getElementById('breadcrumbBar');
    const currentNote = getCurrentNote();
    if (breadcrumbTrail.length === 0 || !currentNote) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    let html = '';
    breadcrumbTrail.forEach(function(crumb, i) {
      const note = db.notes.find(n => n.id === crumb.noteId);
      const title = note ? (note.title || 'Untitled') : crumb.title;
      html += '<span class="breadcrumb-item" data-crumb-index="' + i + '" data-note-id="' + crumb.noteId + '" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</span>';
      html += '<span class="breadcrumb-sep">▶</span>';
    });
    html += '<span class="breadcrumb-current" title="' + escapeHtml(currentNote.title || 'Untitled') + '">' + escapeHtml(currentNote.title || 'Untitled') + '</span>';
    const closeBtn = bar.querySelector('.breadcrumb-close');
    bar.innerHTML = html;
    bar.appendChild(closeBtn);
    bar.querySelectorAll('.breadcrumb-item').forEach(function(item) {
      item.addEventListener('click', function() {
        const index = parseInt(this.dataset.crumbIndex);
        const noteId = this.dataset.noteId;
        const targetNote = db.notes.find(n => n.id === noteId);
        if (!targetNote) { breadcrumbTrail.splice(index, 1); updateBreadcrumbs(); return; }
        saveCurrentNoteContent();
        breadcrumbTrail = breadcrumbTrail.slice(0, index);
        db.currentNoteId = noteId;
        render();
      });
    });
  }

  function saveCurrentNoteContent() {
    const note = getCurrentNote();
    if (!note) return;
    const titleInput = document.getElementById('noteTitle');
    if (titleInput.value !== note.title || editor.innerHTML !== note.content) {
      note.title = titleInput.value;
      note.content = editor.innerHTML;
      note.updatedAt = Date.now();
      saveData();
    }
  }

  function closeAllDropdowns() { document.getElementById('linkNoteDropdown').classList.remove('show'); }

  // ==================== SEARCH ====================

  function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchClear = document.getElementById('searchClear');
    const searchContainer = document.getElementById('searchContainer');
    searchInput.addEventListener('input', function() {
      searchQuery = this.value.trim();
      searchContainer.classList.toggle('has-text', !!searchQuery);
      renderFolderTree();
    });
    searchClear.addEventListener('click', function() {
      searchInput.value = '';
      searchQuery = '';
      searchContainer.classList.remove('has-text');
      renderFolderTree();
      searchInput.focus();
    });
  }

  function updateWordCount(content) {
    const text = getTextContent(content);
    document.getElementById('wordCount').textContent = text.trim() ? text.trim().split(/\s+/).length : 0;
    document.getElementById('charCount').textContent = text.length;
  }

  function showMoveModal(noteId) {
    noteToMove = noteId;
    document.getElementById('modalTitle').textContent = 'Move to Folder';
    const select = document.getElementById('folderSelect');
    let html = '<option value="default">All Notes (no folder)</option>';
    db.folders.forEach(function(folder) {
      if (folder.id !== 'default') html += '<option value="' + folder.id + '">' + escapeHtml(folder.name) + '</option>';
    });
    select.innerHTML = html;
    const note = db.notes.find(n => n.id === noteId);
    if (note) select.value = note.folderId;
    document.getElementById('modal').classList.add('show');
  }

  function hideModal() { document.getElementById('modal').classList.remove('show'); noteToMove = null; modalMode = null; }

  function handleModalConfirm() {
    if (noteToMove) { moveNoteToFolder(noteToMove, document.getElementById('folderSelect').value); hideModal(); }
  }

  function saveSelection() {
    const sel = window.getSelection();
    if (sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
  }

  function restoreAndFormat(command, value) {
    editor.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (savedRange) sel.addRange(savedRange);
    document.execCommand(command, false, value);
    if (sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
    const note = getCurrentNote();
    if (note) { note.content = editor.innerHTML; note.updatedAt = Date.now(); updateWordCount(note.content); delayedSave(); }
  }

  // ==================== COLOR PALETTES ====================

  function setupColorPalettes() {
    const fontGrid = document.getElementById('fontColorGrid');
    const fontStandard = document.getElementById('fontStandardColors');
    const highlightGrid = document.getElementById('highlightColorGrid');
    const highlightStandard = document.getElementById('highlightStandardColors');

    presetColors.forEach(function(color) {
      fontGrid.appendChild(createSwatch(color, function() { restoreAndFormat('foreColor', color); closePalettes(); }));
      highlightGrid.appendChild(createSwatch(color, function() { restoreAndFormat('hiliteColor', color); closePalettes(); }));
    });

    standardColors.forEach(function(color) {
      fontStandard.appendChild(createStdSwatch(color, function() { restoreAndFormat('foreColor', color); closePalettes(); }));
      highlightStandard.appendChild(createStdSwatch(color, function() { restoreAndFormat('hiliteColor', color); closePalettes(); }));
    });

    document.getElementById('reset-font-color').addEventListener('mousedown', function(e) { e.preventDefault(); restoreAndFormat('foreColor', '#000000'); closePalettes(); });
    document.getElementById('reset-highlight').addEventListener('mousedown', function(e) { e.preventDefault(); restoreAndFormat('hiliteColor', 'transparent'); closePalettes(); });

    document.getElementById('font-color-btn').addEventListener('click', function(e) { e.stopPropagation(); saveSelection(); togglePalette('font', this); });
    document.getElementById('highlight-btn').addEventListener('click', function(e) { e.stopPropagation(); saveSelection(); togglePalette('highlight', this); });
    document.addEventListener('click', closePalettes);

    function createSwatch(color, cb) {
      const s = document.createElement('div');
      s.className = 'color-swatch';
      s.style.backgroundColor = color;
      s.addEventListener('mousedown', function(e) { e.preventDefault(); cb(); });
      s.addEventListener('touchstart', function(e) { e.preventDefault(); cb(); }, { passive: false });
      return s;
    }

    function createStdSwatch(color, cb) {
      const s = document.createElement('div');
      s.className = 'standard-swatch';
      s.style.backgroundColor = color;
      s.addEventListener('mousedown', function(e) { e.preventDefault(); cb(); });
      s.addEventListener('touchstart', function(e) { e.preventDefault(); cb(); }, { passive: false });
      return s;
    }
  }

  function togglePalette(type, btnElement) {
    const fontPalette = document.getElementById('fontColorPalette');
    const highlightPalette = document.getElementById('highlightPalette');
    closeCalculator();
    closePercentageCalculator();
    if (activePalette === type) { closePalettes(); return; }
    activePalette = type;
    const palette = type === 'font' ? fontPalette : highlightPalette;
    const btnRect = btnElement.getBoundingClientRect();
    const pw = 220, ph = 320, vw = window.innerWidth, vh = window.innerHeight;
    let left = btnRect.left, right = 'auto';
    if (btnRect.left + pw > vw) { left = 'auto'; right = vw - btnRect.right; }
    let top = btnRect.bottom + 4;
    if (top + ph > vh) top = btnRect.top - ph - 4;
    palette.style.left = left === 'auto' ? 'auto' : left + 'px';
    palette.style.right = right === 'auto' ? 'auto' : right + 'px';
    palette.style.top = Math.max(0, top) + 'px';
    if (type === 'font') { fontPalette.classList.add('show'); highlightPalette.classList.remove('show'); }
    else { highlightPalette.classList.add('show'); fontPalette.classList.remove('show'); }
  }

  function closePalettes() {
    activePalette = null;
    document.getElementById('fontColorPalette').classList.remove('show');
    document.getElementById('highlightPalette').classList.remove('show');
    savedRange = null;
  }

  // ==================== EVENT LISTENERS ====================

  function setupEventListeners() {
    document.getElementById('btn-new-note').addEventListener('click', function() {
      const folderId = db.currentFolderId === 'all' ? 'default' : db.currentFolderId;
      createNote('', '', folderId);
      render();
      if (isMobile() && !db.sidebarHidden) { db.sidebarHidden = true; applySidebarState(); saveData(); }
      document.getElementById('noteTitle').focus();
    });
    
    document.getElementById('btn-new-folder').addEventListener('click', function() {
      const name = prompt('Folder name:');
      if (name && name.trim()) { createFolder(name.trim()); render(); }
    });
    
    document.getElementById('btn-delete').addEventListener('click', deleteCurrentNote);
    
    document.getElementById('noteTitle').addEventListener('input', function() {
      const note = getCurrentNote();
      if (note) { note.title = this.value; note.updatedAt = Date.now(); saveData(); renderFolderTree(); }
    });
    
    editor.addEventListener('input', function() {
      const note = getCurrentNote();
      if (note) { note.content = this.innerHTML; note.updatedAt = Date.now(); updateWordCount(note.content); delayedSave(); }
    });
    
    document.querySelectorAll('.tool-btn[data-cmd]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const cmd = this.dataset.cmd;
        if (cmd === 'indent' || cmd === 'outdent') handleIndentation(cmd);
        else { editor.focus(); document.execCommand(cmd, false, null); }
      });
    });
    
    document.getElementById('headingSelect').addEventListener('change', function() {
      document.execCommand('formatBlock', false, this.value);
      editor.focus();
    });
    
    document.getElementById('fontSizeSelect').addEventListener('change', function() {
      editor.focus();
      document.execCommand('fontSize', false, this.value);
      const note = getCurrentNote();
      if (note) { note.content = editor.innerHTML; note.updatedAt = Date.now(); updateWordCount(note.content); delayedSave(); }
    });
    
    document.getElementById('modalCancel').addEventListener('click', hideModal);
    document.getElementById('modalConfirm').addEventListener('click', handleModalConfirm);
    
    editor.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentNote(); }
      if (e.key === 'Tab') {
        const sel = window.getSelection();
        const anchor = sel.anchorNode;
        const inTable = anchor && (anchor.closest ? anchor.closest('td, th') : (anchor.parentElement ? anchor.parentElement.closest('td, th') : null));
        const inCode = anchor && (anchor.closest ? anchor.closest('pre.code-block') : (anchor.parentElement ? anchor.parentElement.closest('pre.code-block') : null));
        if (inTable || inCode) return;
        e.preventDefault();
        e.stopPropagation();
        handleIndentation(e.shiftKey ? 'outdent' : 'indent');
      }
    });
    
    window.addEventListener('resize', function() { closePalettes(); closeCalculator(); closePercentageCalculator(); });
  }

  function handleIndentation(type) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const saved = sel.getRangeAt(0).cloneRange();
    editor.focus();
    sel.removeAllRanges();
    sel.addRange(saved);
    document.execCommand(type, false, null);
    const note = getCurrentNote();
    if (note) { note.content = editor.innerHTML; note.updatedAt = Date.now(); updateWordCount(note.content); delayedSave(); }
  }

  function delayedSave() {
    updateSaveStatus('saving');
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveCurrentNote, 1000);
  }

  function saveCurrentNote() {
    saveData();
    updateSaveStatus('saved');
  }

  function updateSaveStatus(status) {
    const el = document.getElementById('saveStatus');
    el.textContent = status === 'saving' ? 'Saving...' : status === 'saved' ? 'Saved!' : 'Ready';
    el.className = 'save-status ' + status;
    if (status === 'saved') setTimeout(function() { updateSaveStatus('ready'); }, 2000);
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

}); // end DOMContentLoaded
