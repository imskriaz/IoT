// Storage Manager JavaScript - Professional File Manager
(function() {
    'use strict';

    // ==================== STATE MANAGEMENT ====================
    let state = {
        currentPath: '',
        storageType: 'sd',
        storageInfo: null,
        viewMode: localStorage.getItem('storageViewMode') || 'grid',
        items: [],
        selectedItems: new Set(),
        clipboard: {
            items: [],
            action: null // 'cut' or 'copy'
        },
        history: [],
        historyIndex: -1,
        sortBy: 'name',
        sortDirection: 'asc',
        currentFile: null,
        socket: null
    };

    // ==================== INITIALIZATION ====================
    document.addEventListener('DOMContentLoaded', () => {
        initFileManager();
        initSocket();
        initEventListeners();
        loadStorageInfo();
        loadFileList();
    });

    function initFileManager() {
        // Set initial view mode
        updateViewModeButtons();
        
        // Add to history
        pushToHistory('');
        
        // Load user preferences
        loadPreferences();
    }

    function initSocket() {
        state.socket = io();
        
        state.socket.on('connect', () => {
            console.log('Socket connected');
            const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
            if (activeDeviceId) {
                state.socket.emit('subscribe:device', { deviceId: activeDeviceId });
            }
        });

        state.socket.on('file:changed', (data) => {
            if (data.path.startsWith(state.currentPath)) {
                refreshFileList();
            }
        });
    }

    function initEventListeners() {
        // Keyboard shortcuts
        document.addEventListener('keydown', handleKeyboardShortcuts);
        
        // Context menu
        document.addEventListener('contextmenu', handleContextMenu);
        document.addEventListener('click', () => {
            document.getElementById('contextMenu').classList.remove('show');
        });

        // File input change
        document.getElementById('fileInput').addEventListener('change', handleFileSelect);

        // Drag and drop
        const dropZone = document.getElementById('dropZone');
        if (dropZone) {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('dragover');
            });

            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('dragover');
            });

            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('dragover');
                handleFileDrop(e.dataTransfer.files);
            });
        }

        // Search input
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', debounce(handleSearch, 300));
        }
        initQuickFileFilters();
    }

    // ==================== FILE LIST MANAGEMENT ====================
    async function loadFileList() {
        showLoading(true);
        
        try {
            const response = await fetch(`/api/storage/list?path=${encodeURIComponent(state.currentPath)}&storage=${state.storageType}`);
            const data = await response.json();

            if (data.success) {
                state.items = data.data.items;
                updateBreadcrumbs(data.data.breadcrumbs);
                updateAddressBar();
                renderFileList();
                updateStorageStats(data.data.stats);
                updateStatusBar();
            } else {
                showError(data.message);
            }
        } catch (error) {
            showError('Failed to load files: ' + error.message);
        } finally {
            showLoading(false);
        }
    }

    function renderFileList() {
        const container = document.getElementById('fileContainer');
        const emptyState = document.getElementById('emptyState');
        const gridView = document.getElementById('fileGrid');
        const listView = document.getElementById('fileList');

        if (state.items.length === 0) {
            emptyState.style.display = 'block';
            gridView.style.display = 'none';
            listView.style.display = 'none';
            return;
        }

        emptyState.style.display = 'none';

        // Sort items
        const sortedItems = sortItems(state.items);

        if (state.viewMode === 'grid') {
            renderGridView(sortedItems);
            gridView.style.display = 'grid';
            listView.style.display = 'none';
        } else {
            renderListView(sortedItems);
            gridView.style.display = 'none';
            listView.style.display = 'table';
        }
    }

    function renderGridView(items) {
        const grid = document.getElementById('fileGrid');
        let html = '';

        items.forEach(item => {
            const selected = state.selectedItems.has(item.path) ? 'selected' : '';
            const icon = getFileIcon(item);
            
            html += `
                <div class="file-item ${selected}" data-path="${item.path}" data-type="${item.isDirectory ? 'folder' : 'file'}" 
                     onclick="handleFileClick(event, '${item.path}')" ondblclick="openItem('${item.path}', ${item.isDirectory})">
                    <div class="file-checkbox" onclick="toggleSelect(event, '${item.path}')"></div>
                    <div class="file-icon">
                        <i class="bi ${icon.icon} ${icon.color}" style="font-size: 3rem;"></i>
                    </div>
                    <div class="file-name">${escapeHtml(item.name)}</div>
                    <div class="file-size">${formatSize(item.size)}</div>
                </div>
            `;
        });

        grid.innerHTML = html;
    }

    function renderListView(items) {
        const tbody = document.getElementById('fileListBody');
        let html = '';

        items.forEach(item => {
            const selected = state.selectedItems.has(item.path) ? 'selected' : '';
            const icon = getFileIcon(item);
            const size = item.isDirectory ? '—' : formatSize(item.size);
            const modified = formatDate(item.modified);
            const type = item.isDirectory ? 'Folder' : getFileType(item.extension);

            html += `
                <tr class="${selected}" data-path="${item.path}" data-type="${item.isDirectory ? 'folder' : 'file'}"
                    onclick="handleFileClick(event, '${item.path}')" ondblclick="openItem('${item.path}', ${item.isDirectory})">
                    <td>
                        <div class="file-checkbox" onclick="toggleSelect(event, '${item.path}')"></div>
                    </td>
                    <td>
                        <i class="bi ${icon.icon} ${icon.color} me-2"></i>
                        ${escapeHtml(item.name)}
                    </td>
                    <td>${size}</td>
                    <td>${modified}</td>
                    <td>${type}</td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    }

    // ==================== NAVIGATION ====================
    window.navigateTo = function(path) {
        state.currentPath = path;
        state.selectedItems.clear();
        pushToHistory(path);
        loadFileList();
    };

    window.goBack = function() {
        if (state.historyIndex > 0) {
            state.historyIndex--;
            state.currentPath = state.history[state.historyIndex];
            loadFileList();
        }
    };

    window.goForward = function() {
        if (state.historyIndex < state.history.length - 1) {
            state.historyIndex++;
            state.currentPath = state.history[state.historyIndex];
            loadFileList();
        }
    };

    window.openItem = function(path, isDirectory) {
        if (isDirectory) {
            navigateTo(path);
        } else {
            previewFile(path);
        }
    };

    function pushToHistory(path) {
        // Remove forward history
        if (state.historyIndex < state.history.length - 1) {
            state.history = state.history.slice(0, state.historyIndex + 1);
        }
        
        state.history.push(path);
        state.historyIndex = state.history.length - 1;
    }

    // ==================== SELECTION MANAGEMENT ====================
    window.handleFileClick = function(event, path) {
        if (event.ctrlKey || event.metaKey) {
            toggleSelect(event, path);
        } else if (event.shiftKey) {
            selectRange(path);
        } else if (!event.target.classList.contains('file-checkbox')) {
            clearSelection();
            toggleSelect(event, path);
        }
    };

    window.toggleSelect = function(event, path) {
        event.stopPropagation();
        
        if (state.selectedItems.has(path)) {
            state.selectedItems.delete(path);
        } else {
            state.selectedItems.add(path);
        }
        
        updateSelectionUI();
        updateStatusBar();
    };

    window.toggleSelectAll = function() {
        if (state.selectedItems.size === state.items.length) {
            state.selectedItems.clear();
        } else {
            state.items.forEach(item => state.selectedItems.add(item.path));
        }
        
        updateSelectionUI();
        updateStatusBar();
    };

    function clearSelection() {
        state.selectedItems.clear();
        updateSelectionUI();
        updateStatusBar();
    }

    function selectRange(targetPath) {
        const paths = state.items.map(item => item.path);
        const lastSelected = Array.from(state.selectedItems).pop();
        
        if (!lastSelected) {
            state.selectedItems.add(targetPath);
        } else {
            const startIndex = paths.indexOf(lastSelected);
            const endIndex = paths.indexOf(targetPath);
            
            if (startIndex !== -1 && endIndex !== -1) {
                const [low, high] = [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)];
                for (let i = low; i <= high; i++) {
                    state.selectedItems.add(paths[i]);
                }
            }
        }
        
        updateSelectionUI();
        updateStatusBar();
    }

    function updateSelectionUI() {
        // Update grid items
        document.querySelectorAll('.file-item').forEach(el => {
            const path = el.dataset.path;
            if (state.selectedItems.has(path)) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });

        // Update list rows
        document.querySelectorAll('#fileListBody tr').forEach(el => {
            const path = el.dataset.path;
            if (state.selectedItems.has(path)) {
                el.classList.add('selected');
            } else {
                el.classList.remove('selected');
            }
        });
    }

    // ==================== FILE OPERATIONS ====================
    window.cutSelected = function() {
        if (state.selectedItems.size === 0) return;
        
        state.clipboard = {
            items: Array.from(state.selectedItems),
            action: 'cut'
        };
        
        showToast('Items cut to clipboard', 'info');
    };

    window.copySelected = function() {
        if (state.selectedItems.size === 0) return;
        
        state.clipboard = {
            items: Array.from(state.selectedItems),
            action: 'copy'
        };
        
        showToast('Items copied to clipboard', 'info');
    };

    window.paste = async function() {
        if (!state.clipboard.items || state.clipboard.items.length === 0) return;

        try {
            if (state.clipboard.action === 'cut') {
                await moveItems(state.clipboard.items, state.currentPath);
                state.clipboard = { items: [], action: null };
            } else if (state.clipboard.action === 'copy') {
                await copyItems(state.clipboard.items, state.currentPath);
            }
            
            refreshFileList();
        } catch (error) {
            showToast('Paste failed: ' + error.message, 'danger');
        }
    };

    async function moveItems(items, destination) {
        const response = await fetch('/api/storage/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items,
                destination,
                storageType: state.storageType
            })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.message);
        
        showToast(`Moved ${items.length} items`, 'success');
    }

    async function copyItems(items, destination) {
        const response = await fetch('/api/storage/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items,
                destination,
                storageType: state.storageType
            })
        });

        const data = await response.json();
        if (!data.success) throw new Error(data.message);
        
        showToast(`Copied ${items.length} items`, 'success');
    }

    window.deleteSelected = async function() {
        if (state.selectedItems.size === 0) return;

        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Delete Selected Items',
                message: `Delete ${state.selectedItems.size} item(s)? This cannot be undone.`,
                requiredText: state.selectedItems.size > 1 ? 'DELETE' : '',
                confirmText: 'Delete',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm(`Delete ${state.selectedItems.size} item(s)?`);
            if (approved && state.selectedItems.size > 1) {
                approved = prompt('Type DELETE to continue:') === 'DELETE';
            }
        }
        if (!approved) return;

        try {
            const response = await fetch('/api/storage/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: Array.from(state.selectedItems),
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast(`Deleted ${data.data.filter(r => r.success).length} items`, 'success');
                clearSelection();
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Delete failed: ' + error.message, 'danger');
        }
    };

    window.renameSelected = function() {
        if (state.selectedItems.size !== 1) {
            showToast('Select exactly one item to rename', 'warning');
            return;
        }

        const path = Array.from(state.selectedItems)[0];
        const item = state.items.find(i => i.path === path);
        
        if (!item) return;

        const newName = prompt('Enter new name:', item.name);
        if (newName && newName !== item.name) {
            renameItem(path, newName);
        }
    };

    async function renameItem(oldPath, newName) {
        try {
            const response = await fetch('/api/storage/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: oldPath,
                    newName,
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast('Renamed successfully', 'success');
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Rename failed: ' + error.message, 'danger');
        }
    }

    window.downloadSelected = function() {
        if (state.selectedItems.size === 0) return;

        if (state.selectedItems.size === 1) {
            // Download single file
            const path = Array.from(state.selectedItems)[0];
            window.open(`/api/storage/download?path=${encodeURIComponent(path)}&storage=${state.storageType}`, '_blank');
        } else {
            // Download multiple as zip
            downloadMultiple(Array.from(state.selectedItems));
        }
    };

    async function downloadMultiple(items) {
        try {
            const response = await fetch('/api/storage/download-multiple', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    files: items,
                    storageType: state.storageType
                })
            });

            if (!response.ok) throw new Error('Download failed');

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `files-${Date.now()}.zip`;
            a.click();
            window.URL.revokeObjectURL(url);
        } catch (error) {
            showToast('Download failed: ' + error.message, 'danger');
        }
    }

    // ==================== FILE PREVIEW AND EDIT ====================
    async function previewFile(path) {
        const item = state.items.find(i => i.path === path);
        if (!item) return;

        state.currentFile = { path, name: item.name, isDirectory: item.isDirectory };

        const modal = new bootstrap.Modal(document.getElementById('previewModal'));
        document.getElementById('previewFileName').textContent = item.name;
        document.getElementById('previewContent').innerHTML = '<div class="text-center p-5"><div class="spinner-border text-primary"></div></div>';
        document.getElementById('previewFileInfo').textContent = `${formatSize(item.size)} • ${formatDate(item.modified)}`;
        modal.show();

        try {
            const response = await fetch(`/api/storage/read?path=${encodeURIComponent(path)}&storage=${state.storageType}`);
            
            if (response.headers.get('content-type').includes('application/json')) {
                const data = await response.json();
                if (data.success && data.data.type === 'text') {
                    document.getElementById('previewContent').innerHTML = `<pre class="m-0">${escapeHtml(data.data.content)}</pre>`;
                }
            } else if (response.headers.get('content-type').includes('image/')) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                document.getElementById('previewContent').innerHTML = `<img src="${url}" alt="${escapeHtml(item.name)}" class="img-fluid">`;
            } else {
                document.getElementById('previewContent').innerHTML = `
                    <div class="text-center p-5">
                        <i class="bi bi-file-earmark display-1 text-muted mb-3"></i>
                        <p class="text-muted">Preview not available for this file type</p>
                        <button class="btn btn-primary" onclick="downloadCurrentFile()">
                            <i class="bi bi-download me-2"></i>Download
                        </button>
                    </div>
                `;
            }
        } catch (error) {
            document.getElementById('previewContent').innerHTML = `
                <div class="alert alert-danger m-3">
                    <i class="bi bi-exclamation-triangle me-2"></i>
                    Error loading file: ${error.message}
                </div>
            `;
        }
    }

    window.editCurrentFile = function() {
        if (!state.currentFile) return;

        const modal = bootstrap.Modal.getInstance(document.getElementById('previewModal'));
        modal.hide();

        setTimeout(() => {
            editFile(state.currentFile.path, state.currentFile.name);
        }, 300);
    };

    window.downloadCurrentFile = function() {
        if (!state.currentFile || !state.currentFile.path) return;
        const path = state.currentFile.path;
        window.open(`/api/storage/download?path=${encodeURIComponent(path)}&storage=${state.storageType}`, '_blank');
    };

    async function editFile(path, filename) {
        document.getElementById('editFileName').textContent = filename;
        document.getElementById('editContent').value = 'Loading...';

        const modal = new bootstrap.Modal(document.getElementById('editModal'));
        modal.show();

        try {
            const response = await fetch(`/api/storage/read?path=${encodeURIComponent(path)}&storage=${state.storageType}`);
            const data = await response.json();
            
            if (data.success && data.data.type === 'text') {
                document.getElementById('editContent').value = data.data.content;
                state.currentFile = { path, name: filename };
            } else {
                throw new Error('File is not editable');
            }
        } catch (error) {
            document.getElementById('editContent').value = 'Error loading file: ' + error.message;
        }
    }

    window.saveFile = async function() {
        if (!state.currentFile) return;

        const content = document.getElementById('editContent').value;

        try {
            const response = await fetch('/api/storage/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: state.currentFile.path,
                    content,
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast('File saved successfully', 'success');
                const modal = bootstrap.Modal.getInstance(document.getElementById('editModal'));
                modal.hide();
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Save failed: ' + error.message, 'danger');
        }
    };

    // ==================== FOLDER AND FILE CREATION ====================
    window.showNewFolderModal = function() {
        document.getElementById('newFolderName').value = '';
        const modal = new bootstrap.Modal(document.getElementById('newFolderModal'));
        modal.show();
    };

    window.createFolder = async function() {
        const name = document.getElementById('newFolderName').value.trim();
        if (!name) {
            showToast('Folder name is required', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/storage/mkdir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: state.currentPath,
                    name,
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast('Folder created', 'success');
                const modal = bootstrap.Modal.getInstance(document.getElementById('newFolderModal'));
                modal.hide();
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Failed to create folder: ' + error.message, 'danger');
        }
    };

    window.showNewFileModal = function() {
        document.getElementById('newFileName').value = '';
        document.getElementById('newFileContent').value = '';
        const modal = new bootstrap.Modal(document.getElementById('newFileModal'));
        modal.show();
    };

    window.createFile = async function() {
        const name = document.getElementById('newFileName').value.trim();
        if (!name) {
            showToast('File name is required', 'warning');
            return;
        }

        const content = document.getElementById('newFileContent').value;

        try {
            const response = await fetch('/api/storage/touch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: state.currentPath,
                    name,
                    content,
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast('File created', 'success');
                const modal = bootstrap.Modal.getInstance(document.getElementById('newFileModal'));
                modal.hide();
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Failed to create file: ' + error.message, 'danger');
        }
    };

    // ==================== UPLOAD ====================
    window.showUploadModal = function() {
        document.getElementById('fileInput').value = '';
        document.getElementById('fileListPreview').style.display = 'none';
        document.getElementById('uploadProgressContainer').style.display = 'none';
        document.getElementById('selectedFilesList').innerHTML = '';
        const modal = new bootstrap.Modal(document.getElementById('uploadModal'));
        modal.show();
    };

    function handleFileSelect(event) {
        const files = event.target.files;
        if (files.length > 0) {
            displaySelectedFiles(files);
        }
    }

    function handleFileDrop(files) {
        displaySelectedFiles(files);
    }

    function displaySelectedFiles(files) {
        const list = document.getElementById('selectedFilesList');
        let html = '';

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            html += `
                <div class="list-group-item d-flex justify-content-between align-items-center">
                    <div>
                        <i class="bi bi-file-earmark me-2"></i>
                        ${escapeHtml(file.name)}
                    </div>
                    <span class="badge bg-secondary">${formatSize(file.size)}</span>
                </div>
            `;
        }

        list.innerHTML = html;
        document.getElementById('fileListPreview').style.display = 'block';
    }

    window.startUpload = async function() {
        const files = document.getElementById('fileInput').files;
        if (files.length === 0) {
            showToast('No files selected', 'warning');
            return;
        }

        const formData = new FormData();
        formData.append('path', state.currentPath);
        formData.append('storageType', state.storageType);
        
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
        }

        const progressBar = document.getElementById('uploadProgressBar');
        const progressContainer = document.getElementById('uploadProgressContainer');
        const uploadStatus = document.getElementById('uploadStatus');
        const uploadPercent = document.getElementById('uploadPercent');
        const uploadBtn = document.getElementById('uploadBtn');

        progressContainer.style.display = 'block';
        uploadBtn.disabled = true;

        const xhr = new XMLHttpRequest();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                uploadPercent.textContent = percent + '%';
                uploadStatus.textContent = `Uploading ${formatSize(e.loaded)} of ${formatSize(e.total)}`;
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                const data = JSON.parse(xhr.responseText);
                showToast(data.message, 'success');
                const modal = bootstrap.Modal.getInstance(document.getElementById('uploadModal'));
                modal.hide();
                refreshFileList();
            } else {
                showToast('Upload failed', 'danger');
            }
            uploadBtn.disabled = false;
        });

        xhr.addEventListener('error', () => {
            showToast('Upload failed', 'danger');
            uploadBtn.disabled = false;
        });

        xhr.open('POST', '/api/storage/upload');
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
        xhr.send(formData);
    };

    // ==================== STORAGE INFO ====================
    async function loadStorageInfo() {
        try {
            const response = await fetch('/api/storage/info', {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            const data = await response.json();

            if (data.success) {
                updateStorageDisplay(data.data);
            }
        } catch (error) {
            console.error('Failed to load storage info:', error);
        }
    }

    function getExternalStorageInfo(info = state.storageInfo) {
        return info?.sd || {};
    }

    function getExternalStorageLabel(info = state.storageInfo) {
        const storage = getExternalStorageInfo(info);
        const label = String(storage?.type || storage?.cardType || 'SSD').trim();
        return label || 'SSD';
    }

    function updateStorageDisplay(info) {
        state.storageInfo = info;
        const storageLabel = getExternalStorageLabel(info);
        const sdStatsLabel = document.getElementById('sdStatsLabel');
        const sdNameLabel = document.getElementById('sdNameLabel');

        if (sdStatsLabel) {
            sdStatsLabel.textContent = `Device ${storageLabel}`;
        }
        if (sdNameLabel) {
            sdNameLabel.textContent = `Device ${storageLabel}`;
        }

        document.getElementById('internalBar').style.width = '0%';
        document.getElementById('internalUsage').textContent = 'Not used';
        document.getElementById('internalSize').textContent = 'Device files use the SSD lane';

        if (info.sd.available) {
            const sdUsed = Math.round((info.sd.used / info.sd.total) * 100);
            document.getElementById('sdBar').style.width = sdUsed + '%';
            document.getElementById('sdUsage').textContent = sdUsed + '% used';
            document.getElementById('sdSize').textContent = formatSize(info.sd.total);
        } else {
            document.getElementById('sdBar').style.width = '0%';
            document.getElementById('sdUsage').textContent = 'Not detected';
            document.getElementById('sdSize').textContent = 'Not detected';
        }

        updateFormatButtonState();
    }

    function updateStorageStats(stats) {
        if (stats) {
            document.getElementById('freeSpace').textContent = `Free: ${formatSize(stats.free)}`;
            document.getElementById('totalSpace').textContent = `Total: ${formatSize(stats.total)}`;
        }
    }

    // ==================== UTILITY FUNCTIONS ====================
    function showLoading(show) {
        document.getElementById('loadingIndicator').style.display = show ? 'block' : 'none';
    }

    function showError(message) {
        const container = document.getElementById('fileContainer');
        container.innerHTML = `
            <div class="alert alert-danger m-3">
                <i class="bi bi-exclamation-triangle me-2"></i>
                ${message}
            </div>
        `;
    }

    function updateBreadcrumbs(breadcrumbs) {
        const container = document.getElementById('breadcrumbContainer');
        let html = '<div class="breadcrumb-item" onclick="navigateTo(\'\')"><i class="bi bi-house-door"></i><span>Root</span></div>';

        breadcrumbs.forEach(crumb => {
            html += `
                <span class="breadcrumb-separator">/</span>
                <div class="breadcrumb-item" onclick="navigateTo('${crumb.path}')">
                    <span>${escapeHtml(crumb.name)}</span>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    function updateAddressBar() {
        document.getElementById('addressPath').value = '/' + state.currentPath;
    }

    function updateStatusBar() {
        document.getElementById('itemCount').textContent = `${state.items.length} items`;
        document.getElementById('selectedCount').textContent = `${state.selectedItems.size} selected`;
    }

    function updateViewModeButtons() {
        document.getElementById('viewGridBtn').classList.toggle('active', state.viewMode === 'grid');
        document.getElementById('viewListBtn').classList.toggle('active', state.viewMode === 'list');
        document.getElementById('viewDetailsBtn').classList.toggle('active', state.viewMode === 'details');
    }

    window.setViewMode = function(mode) {
        state.viewMode = mode;
        localStorage.setItem('storageViewMode', mode);
        updateViewModeButtons();
        renderFileList();
    };

    window.switchStorage = function(type) {
        if (type !== 'sd') {
            showToast('Device files are available on the SSD lane only', 'info');
            return;
        }

        document.querySelectorAll('.storage-item').forEach(el => {
            el.classList.toggle('active', el.dataset.storage === type);
        });

        state.storageType = type;
        state.currentPath = '';
        state.selectedItems.clear();
        updateFormatButtonState();
        loadFileList();
    };

    function updateFormatButtonState() {
        const button = document.getElementById('formatStorageBtn');
        if (!button) return;

        const storageLabel = getExternalStorageLabel();
        const sdAvailable = Boolean(state.storageInfo?.sd?.available);
        const activeIsSd = state.storageType === 'sd';
        button.disabled = !(activeIsSd && sdAvailable);
        button.title = !activeIsSd
            ? `Switch to ${storageLabel} to format`
            : (sdAvailable ? `Format ${storageLabel}` : `No ${storageLabel} detected`);
    }

    window.formatStorage = async function() {
        const storageLabel = getExternalStorageLabel();
        if (state.storageType !== 'sd') {
            showToast(`Switch to ${storageLabel} first`, 'warning');
            return;
        }

        if (!state.storageInfo?.sd?.available) {
            showToast(`No ${storageLabel} detected`, 'warning');
            return;
        }

        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: `Format ${storageLabel}`,
                message: `This will permanently erase all files on the ${storageLabel}.`,
                requiredText: 'FORMAT',
                confirmText: 'Format',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = prompt(`Type FORMAT to erase the ${storageLabel}:`) === 'FORMAT';
        }

        if (!approved) return;

        try {
            const response = await fetch('/api/storage/format', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    storageType: 'sd',
                    deviceId: window.DEVICE_ID || ''
                })
            });

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.message || `Failed to format ${storageLabel}`);
            }

            showToast(data.message || `${storageLabel} formatted successfully`, 'success');
            clearSelection();
            await loadStorageInfo();
            await loadFileList();
        } catch (error) {
            showToast('Format failed: ' + error.message, 'danger');
        }
    };

    window.refreshFileList = function() {
        loadFileList();
    };

    window.sortBy = function(field) {
        if (state.sortBy === field) {
            state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            state.sortBy = field;
            state.sortDirection = 'asc';
        }
        renderFileList();
    };

    function sortItems(items) {
        return [...items].sort((a, b) => {
            // Directories first
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;

            let comparison = 0;
            switch (state.sortBy) {
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'size':
                    comparison = (a.size || 0) - (b.size || 0);
                    break;
                case 'modified':
                    comparison = new Date(b.modified) - new Date(a.modified);
                    break;
                case 'type':
                    comparison = (a.extension || '').localeCompare(b.extension || '');
                    if (comparison === 0) comparison = a.name.localeCompare(b.name);
                    break;
            }

            return state.sortDirection === 'asc' ? comparison : -comparison;
        });
    }

    function getFileIcon(item) {
        if (item.isDirectory) {
            return { icon: 'bi-folder-fill', color: 'text-warning' };
        }

        const ext = item.extension || '';
        const icons = {
            '.txt': { icon: 'bi-file-text-fill', color: 'text-secondary' },
            '.log': { icon: 'bi-file-text-fill', color: 'text-secondary' },
            '.json': { icon: 'bi-file-code-fill', color: 'text-primary' },
            '.xml': { icon: 'bi-file-code-fill', color: 'text-primary' },
            '.html': { icon: 'bi-file-code-fill', color: 'text-danger' },
            '.css': { icon: 'bi-file-code-fill', color: 'text-info' },
            '.js': { icon: 'bi-file-code-fill', color: 'text-warning' },
            '.jpg': { icon: 'bi-file-image-fill', color: 'text-success' },
            '.jpeg': { icon: 'bi-file-image-fill', color: 'text-success' },
            '.png': { icon: 'bi-file-image-fill', color: 'text-success' },
            '.gif': { icon: 'bi-file-image-fill', color: 'text-success' },
            '.mp4': { icon: 'bi-file-play-fill', color: 'text-success' },
            '.mp3': { icon: 'bi-file-music-fill', color: 'text-success' },
            '.pdf': { icon: 'bi-file-pdf-fill', color: 'text-danger' },
            '.zip': { icon: 'bi-file-zip-fill', color: 'text-secondary' },
            '.rar': { icon: 'bi-file-zip-fill', color: 'text-secondary' }
        };

        return icons[ext] || { icon: 'bi-file-fill', color: 'text-secondary' };
    }

    function getFileType(ext) {
        const types = {
            '.txt': 'Text Document',
            '.log': 'Log File',
            '.json': 'JSON File',
            '.xml': 'XML File',
            '.html': 'HTML File',
            '.css': 'CSS File',
            '.js': 'JavaScript File',
            '.jpg': 'JPEG Image',
            '.jpeg': 'JPEG Image',
            '.png': 'PNG Image',
            '.gif': 'GIF Image',
            '.mp4': 'MP4 Video',
            '.mp3': 'MP3 Audio',
            '.pdf': 'PDF Document',
            '.zip': 'ZIP Archive',
            '.rar': 'RAR Archive'
        };

        return types[ext] || 'File';
    }

    function formatDate(date) {
        if (!date) return '—';
        const d = new Date(date);
        const now = new Date();
        const diff = now - d;

        if (diff < 24 * 60 * 60 * 1000) {
            return 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diff < 48 * 60 * 60 * 1000) {
            return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
            return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }

    // ==================== KEYBOARD SHORTCUTS ====================
    function handleKeyboardShortcuts(e) {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
        // Ctrl/Cmd + A: Select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            toggleSelectAll();
        }

        // Ctrl/Cmd + C: Copy
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            e.preventDefault();
            copySelected();
        }

        // Ctrl/Cmd + X: Cut
        if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
            e.preventDefault();
            cutSelected();
        }

        // Ctrl/Cmd + V: Paste
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            e.preventDefault();
            paste();
        }

        // Delete: Delete
        if (e.key === 'Delete') {
            e.preventDefault();
            deleteSelected();
        }

        // F2: Rename
        if (e.key === 'F2') {
            e.preventDefault();
            renameSelected();
        }

        // Ctrl/Cmd + F: Search
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            document.getElementById('searchInput')?.focus();
        }

        // ?: shortcut help
        if (e.key === '?') {
            e.preventDefault();
            const modal = new bootstrap.Modal(document.getElementById('storageShortcutsModal'));
            modal.show();
        }

        // Alt + Left: Back
        if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault();
            goBack();
        }

        // Alt + Right: Forward
        if (e.altKey && e.key === 'ArrowRight') {
            e.preventDefault();
            goForward();
        }
    }

    // ==================== CONTEXT MENU ====================
    function handleContextMenu(e) {
        e.preventDefault();

        const fileItem = e.target.closest('.file-item, tr');
        if (!fileItem) return;

        const path = fileItem.dataset.path;
        if (path && !state.selectedItems.has(path)) {
            clearSelection();
            state.selectedItems.add(path);
            updateSelectionUI();
        }

        const menu = document.getElementById('contextMenu');
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        menu.classList.add('show');

        // Update menu items based on selection
        const hasSelection = state.selectedItems.size > 0;
        const singleSelection = state.selectedItems.size === 1;

        document.querySelectorAll('.context-menu-item').forEach(item => {
            const action = item.getAttribute('onclick') || '';
            item.style.display = action.includes('paste') && !state.clipboard.items.length ? 'none' : 'block';
        });
    }

    window.contextAction = function(action) {
        switch (action) {
            case 'open':
                if (state.selectedItems.size === 1) {
                    const path = Array.from(state.selectedItems)[0];
                    const item = state.items.find(i => i.path === path);
                    if (item) openItem(path, item.isDirectory);
                }
                break;
            case 'download':
                downloadSelected();
                break;
            case 'cut':
                cutSelected();
                break;
            case 'copy':
                copySelected();
                break;
            case 'paste':
                paste();
                break;
            case 'rename':
                renameSelected();
                break;
            case 'delete':
                deleteSelected();
                break;
            case 'properties':
                showProperties();
                break;
        }
        document.getElementById('contextMenu').classList.remove('show');
    };

    // ==================== PROPERTIES ====================
    window.showProperties = function() {
        if (state.selectedItems.size !== 1) {
            showToast('Select exactly one item to view properties', 'warning');
            return;
        }

        const path = Array.from(state.selectedItems)[0];
        const item = state.items.find(i => i.path === path);
        if (!item) return;

        const content = document.getElementById('propertiesContent');
        content.innerHTML = `
            <table class="table table-sm">
                <tr>
                    <th>Name:</th>
                    <td>${escapeHtml(item.name)}</td>
                </tr>
                <tr>
                    <th>Path:</th>
                    <td>/${escapeHtml(item.path)}</td>
                </tr>
                <tr>
                    <th>Type:</th>
                    <td>${item.isDirectory ? 'Folder' : 'File'}</td>
                </tr>
                <tr>
                    <th>Size:</th>
                    <td>${item.isDirectory ? '—' : formatSize(item.size)}</td>
                </tr>
                <tr>
                    <th>Created:</th>
                    <td>${formatDate(item.created)}</td>
                </tr>
                <tr>
                    <th>Modified:</th>
                    <td>${formatDate(item.modified)}</td>
                </tr>
                <tr>
                    <th>Permissions:</th>
                    <td>${item.permissions || '—'}</td>
                </tr>
            </table>
        `;

        const modal = new bootstrap.Modal(document.getElementById('propertiesModal'));
        modal.show();
    };

    // ==================== MOVE MODAL ====================
    window.showMoveModal = function() {
        if (state.selectedItems.size === 0) return;

        document.getElementById('moveDestination').value = '/' + state.currentPath;
        document.getElementById('destinationBrowser').style.display = 'none';
        const modal = new bootstrap.Modal(document.getElementById('moveModal'));
        modal.show();
    };

    window.browseDestination = async function() {
        const browser = document.getElementById('destinationBrowser');
        const list = document.getElementById('destinationList');

        if (browser.style.display === 'none') {
            browser.style.display = 'block';

            try {
                const response = await fetch(`/api/storage/list?path=${encodeURIComponent(state.currentPath)}&storage=${state.storageType}`);
                const data = await response.json();

                if (data.success) {
                    let html = '';
                    data.data.items
                        .filter(item => item.isDirectory)
                        .forEach(item => {
                            html += `
                                <button class="list-group-item list-group-item-action" onclick="selectDestination('${item.path}')">
                                    <i class="bi bi-folder-fill text-warning me-2"></i>
                                    ${escapeHtml(item.name)}
                                </button>
                            `;
                        });

                    list.innerHTML = html || '<div class="list-group-item text-muted">No subfolders</div>';
                }
            } catch (error) {
                list.innerHTML = '<div class="list-group-item text-danger">Error loading folders</div>';
            }
        } else {
            browser.style.display = 'none';
        }
    };

    window.selectDestination = function(path) {
        document.getElementById('moveDestination').value = '/' + path;
        document.getElementById('destinationBrowser').style.display = 'none';
    };

    window.moveItems = async function() {
        const destination = document.getElementById('moveDestination').value.replace(/^\//, '');
        await moveItems(Array.from(state.selectedItems), destination);
        
        const modal = bootstrap.Modal.getInstance(document.getElementById('moveModal'));
        modal.hide();
        
        clearSelection();
        refreshFileList();
    };

    // ==================== COMPRESS ====================
    window.compressSelected = async function() {
        if (state.selectedItems.size === 0) return;

        const archiveName = prompt('Enter archive name:', 'archive.zip');
        if (!archiveName) return;

        try {
            const response = await fetch('/api/storage/compress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: Array.from(state.selectedItems),
                    archiveName,
                    destination: state.currentPath,
                    storageType: state.storageType
                })
            });

            const data = await response.json();
            if (data.success) {
                showToast('Archive created successfully', 'success');
                refreshFileList();
            } else {
                throw new Error(data.message);
            }
        } catch (error) {
            showToast('Compression failed: ' + error.message, 'danger');
        }
    };

    // ==================== SEARCH ====================
    window.showSearch = function() {
        // Implement search UI
    };

    function handleSearch(query) {
        if (!query) {
            renderFileList();
            return;
        }

        const filtered = state.items.filter(item => 
            item.name.toLowerCase().includes(query.toLowerCase())
        );

        if (state.viewMode === 'grid') {
            renderGridView(filtered);
        } else {
            renderListView(filtered);
        }
    }

    function initQuickFileFilters() {
        document.querySelectorAll('#fileTypeQuickFilters [data-file-filter]').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#fileTypeQuickFilters [data-file-filter]').forEach(el => el.classList.remove('active'));
                this.classList.add('active');
                applyQuickFileFilter(this.dataset.fileFilter);
            });
        });
    }

    function applyQuickFileFilter(filter) {
        if (filter === 'all') {
            renderFileList();
            return;
        }

        const filtered = state.items.filter(item => {
            if (filter === 'folder') return item.isDirectory;
            if (item.isDirectory) return false;
            const ext = (item.extension || '').toLowerCase();
            if (filter === 'image') return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            if (filter === 'text') return ['.txt', '.log', '.json', '.xml', '.js', '.css', '.html', '.md'].includes(ext);
            if (filter === 'archive') return ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext);
            return true;
        });

        if (state.viewMode === 'grid') {
            document.getElementById('fileGrid').style.display = 'grid';
            document.getElementById('fileList').style.display = 'none';
            renderGridView(filtered);
        } else {
            document.getElementById('fileGrid').style.display = 'none';
            document.getElementById('fileList').style.display = 'table';
            renderListView(filtered);
        }
    }

    // ==================== SETTINGS ====================
    window.showSettings = function() {
        // Implement settings modal
    };

    function loadPreferences() {
        // Load user preferences from localStorage
        const sortPref = localStorage.getItem('fileSort');
        if (sortPref) {
            state.sortBy = sortPref;
        }
    }

    // ==================== TRASH ====================
    window.openTrash = function() {
        // Implement trash view
    };

    // ==================== PATH UTILITIES ====================
    window.copyPath = function() {
        const path = '/' + state.currentPath;
        navigator.clipboard.writeText(path).then(() => {
            showToast('Path copied to clipboard', 'success');
        }).catch(() => {
            showToast('Failed to copy path', 'danger');
        });
    };

    // ==================== EXPOSE GLOBALLY ====================
    window.navigateTo = navigateTo;
    window.goBack = goBack;
    window.goForward = goForward;
    window.openItem = openItem;
    window.toggleSelect = toggleSelect;
    window.toggleSelectAll = toggleSelectAll;
    window.cutSelected = cutSelected;
    window.copySelected = copySelected;
    window.paste = paste;
    window.deleteSelected = deleteSelected;
    window.renameSelected = renameSelected;
    window.downloadSelected = downloadSelected;
    window.downloadCurrentFile = downloadCurrentFile;
    window.editCurrentFile = editCurrentFile;
    window.saveFile = saveFile;
    window.showNewFolderModal = showNewFolderModal;
    window.createFolder = createFolder;
    window.showNewFileModal = showNewFileModal;
    window.createFile = createFile;
    window.showUploadModal = showUploadModal;
    window.startUpload = startUpload;
    window.setViewMode = setViewMode;
    window.switchStorage = switchStorage;
    window.refreshFileList = refreshFileList;
    window.sortBy = sortBy;
    window.contextAction = contextAction;
    window.showProperties = showProperties;
    window.showMoveModal = showMoveModal;
    window.browseDestination = browseDestination;
    window.selectDestination = selectDestination;
    window.moveItems = moveItems;
    window.compressSelected = compressSelected;
    window.showSearch = showSearch;
    window.copyPath = copyPath;
    window.openTrash = openTrash;
})();
