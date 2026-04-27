// Contacts management page
(function () {
    'use strict';

    console.log('Contacts.js loaded - ' + new Date().toISOString());

    // State
    let currentPage = 1;
    let totalPages = 1;
    let allContacts = [];
    let currentFilter = 'all'; // 'all' or 'favorites'
    let pageCtrl = null;

    function newSignal() {
        if (pageCtrl) pageCtrl.abort();
        pageCtrl = new AbortController();
        return pageCtrl.signal;
    }

    function setPhoneFieldValue(id, value) {
        if (window.PhoneInputs?.setValue) {
            window.PhoneInputs.setValue(id, value || '');
            return;
        }
        const el = document.getElementById(id);
        if (el) el.value = value || '';
    }

    function validatePhoneField(id, options = {}) {
        if (window.PhoneInputs?.validate) {
            return window.PhoneInputs.validate(id, options);
        }

        const el = document.getElementById(id);
        const value = String(el?.value || '').trim();
        if (!value) return { ok: options.required === false, value, message: 'Phone number is required' };
        return { ok: true, value, message: '' };
    }

    window.addEventListener('beforeunload', function () { if (pageCtrl) pageCtrl.abort(); });

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        console.log('Initializing Contacts page...');

        // Load contacts
        loadContacts();

        // Attach event listeners
        attachSearchListener();
        attachModalListeners();

        // Double-check save button
        const saveBtn = document.getElementById('saveContactBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveContact);
            console.log('Save button listener attached');
        }
    }

    // Load contacts from API
    function loadContacts(page = 1) {
        currentPage = page;

        let url = `/api/contacts?page=${page}&limit=12`;

        if (document.getElementById('searchContacts')) {
            const search = document.getElementById('searchContacts').value;
            if (search) {
                url += `&search=${encodeURIComponent(search)}`;
            }
        }

        fetch(url, { signal: newSignal() })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                console.log('Contacts loaded:', data);
                if (data.success) {
                    allContacts = data.data;

                    // Apply favorite filter if needed
                    let filteredContacts = allContacts;
                    if (currentFilter === 'favorites') {
                        filteredContacts = allContacts.filter(c => c.favorite === 1);
                    }

                    displayContacts(filteredContacts);
                    updateStats(data.data, data.pagination);
                    updatePagination(data.pagination);
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading contacts:', error);
                showError('Failed to load contacts');
            });
    }

    // Display contacts in grid
    function displayContacts(contacts) {
        const container = document.getElementById('contactsContainer');
        if (!container) return;

        if (!contacts || contacts.length === 0) {
            container.innerHTML = `
                <div class="col-12 text-center py-5">
                    <i class="bi bi-person-lines-fill fs-1 text-muted"></i>
                    <p class="text-muted mt-3 mb-0">No contacts found</p>
                    <button class="btn btn-primary mt-3" onclick="showAddContactModal()">
                        <i class="bi bi-person-plus me-2"></i>Add Your First Contact
                    </button>
                </div>
            `;
            return;
        }

        let html = '';
        contacts.forEach(contact => {
            const avatarColor = getAvatarColor(contact.name);
            const initials = getInitials(contact.name);
            const favorite = contact.favorite ?
                '<i class="bi bi-star-fill text-warning" title="Favorite"></i>' :
                '<i class="bi bi-star text-muted" title="Not favorite"></i>';

            html += `
                <div class="col-12 col-md-6 col-lg-4 mb-3">
                    <div class="contact-card p-3" data-contact-id="${contact.id}">
                        <div class="d-flex align-items-start mb-3">
                            <div class="contact-avatar me-3" style="background-color: ${avatarColor}">
                                ${initials}
                            </div>
                            <div class="flex-grow-1">
                                <div class="d-flex justify-content-between align-items-start">
                                    <h5 class="mb-1">${escapeHtml(contact.name)}</h5>
                                    <span class="favorite-star">${favorite}</span>
                                </div>
                                <p class="mb-1 small">
                                    <i class="bi bi-telephone me-1"></i>${escapeHtml(contact.phone_number)}
                                </p>
                                ${contact.email ? `
                                    <p class="mb-1 small">
                                        <i class="bi bi-envelope me-1"></i>${escapeHtml(contact.email)}
                                    </p>
                                ` : ''}
                                ${contact.company ? `
                                    <p class="mb-0 small">
                                        <i class="bi bi-building me-1"></i>${escapeHtml(contact.company)}
                                    </p>
                                ` : ''}
                            </div>
                        </div>
                        <div class="d-flex justify-content-end gap-2">
                            <button class="btn btn-sm btn-outline-success" onclick="quickCall('${escapeHtml(contact.phone_number)}')" title="Call">
                                <i class="bi bi-telephone"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-info" onclick="quickSms('${escapeHtml(contact.phone_number)}')" title="SMS">
                                <i class="bi bi-chat-dots"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-primary" onclick="viewContact(${contact.id})" title="View">
                                <i class="bi bi-eye"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-warning" onclick="toggleFavorite(${contact.id}, ${!contact.favorite})" title="Toggle Favorite">
                                <i class="bi bi-star${contact.favorite ? '-fill' : ''}"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteContact(${contact.id})" title="Delete">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    // Update statistics
    function updateStats(contacts, pagination) {
        document.getElementById('totalContacts').textContent = pagination.total;

        const favorites = contacts.filter(c => c.favorite === 1).length;
        const companies = contacts.filter(c => c.company && c.company.trim() !== '').length;

        document.getElementById('favoriteCount').textContent = favorites;
        document.getElementById('companyCount').textContent = companies;
    }

    // Update pagination
    function updatePagination(pagination) {
        currentPage = pagination.page;
        totalPages = pagination.pages;

        const container = document.getElementById('contactsPagination');
        if (!container) return;

        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = '';

        // Previous
        html += `
            <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="loadContacts(${currentPage - 1}); return false;">
                    <span aria-hidden="true">&laquo;</span>
                </a>
            </li>
        `;

        // Pages
        for (let i = 1; i <= pagination.pages; i++) {
            if (i === 1 || i === pagination.pages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                html += `
                    <li class="page-item ${i === currentPage ? 'active' : ''}">
                        <a class="page-link" href="#" onclick="loadContacts(${i}); return false;">${i}</a>
                    </li>
                `;
            } else if (i === currentPage - 3 || i === currentPage + 3) {
                html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
            }
        }

        // Next
        html += `
            <li class="page-item ${currentPage === pagination.pages ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="loadContacts(${currentPage + 1}); return false;">
                    <span aria-hidden="true">&raquo;</span>
                </a>
            </li>
        `;

        container.innerHTML = html;
    }

    // Attach search listener
    function attachSearchListener() {
        const searchInput = document.getElementById('searchContacts');
        if (searchInput) {
            let timeout;
            searchInput.addEventListener('input', function () {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    loadContacts(1);
                }, 300);
            });
        }
    }

    // Filter favorites
    function filterFavorites(showFavorites) {
        currentFilter = showFavorites ? 'favorites' : 'all';

        let filteredContacts = allContacts;
        if (showFavorites) {
            filteredContacts = allContacts.filter(c => c.favorite === 1);
        }

        displayContacts(filteredContacts);
    }

    function attachModalListeners() {
        const saveBtn = document.getElementById('saveContactBtn');
        if (saveBtn) {
            // Remove existing listeners
            const newSaveBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
            newSaveBtn.addEventListener('click', saveContact);
        }

        const deleteBtn = document.getElementById('deleteContactBtn');
        if (deleteBtn) {
            const newDeleteBtn = deleteBtn.cloneNode(true);
            deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
            newDeleteBtn.addEventListener('click', function () {
                const id = document.getElementById('contactId').value;
                if (id) deleteContact(id);
            });
        }
    }

    // Show add contact modal
    function showAddContactModal() {
        document.getElementById('contactModalTitle').textContent = 'Add New Contact';
        document.getElementById('contactForm').reset();
        document.getElementById('contactId').value = '';
        document.getElementById('deleteContactBtn').classList.add('d-none');

        const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
        modal.show();
    }

    // Save contact
    function saveContact() {
        console.log('Saving contact...');

        // Get form values
        const id = document.getElementById('contactId').value;
        const name = document.getElementById('contactName').value.trim();
        const phoneValidation = validatePhoneField('contactPhone', { allowShortCode: true });
        const phone = phoneValidation.value;
        const email = document.getElementById('contactEmail').value.trim();
        const company = document.getElementById('contactCompany').value.trim();
        const favorite = document.getElementById('contactFavorite').checked;
        const notes = document.getElementById('contactNotes').value.trim();

        console.log('Form data:', { id, name, phone, email, company, favorite, notes });

        // Validate required fields
        if (!name) {
            alert('Name is required');
            document.getElementById('contactName').classList.add('is-invalid');
            return;
        }

        if (!phone) {
            alert(phoneValidation.message || 'Phone number is required');
            document.getElementById('contactPhone').classList.add('is-invalid');
            return;
        }

        // Remove invalid class
        document.getElementById('contactName').classList.remove('is-invalid');
        document.getElementById('contactPhone').classList.remove('is-invalid');

        // Prepare data
        const data = {
            name: name,
            phone_number: phone,
            email: email || null,
            company: company || null,
            favorite: favorite,
            notes: notes || null
        };

        console.log('Sending data:', data);

        const url = id ? `/api/contacts/${id}` : '/api/contacts';
        const method = id ? 'PUT' : 'POST';

        // Show loading
        const saveBtn = document.getElementById('saveContactBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Saving...';
        saveBtn.disabled = true;

        fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
            .then(async response => {
                const text = await response.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    throw new Error('Invalid JSON response from server');
                }
                if (!response.ok) {
                    throw new Error(data.message || 'Server error');
                }
                return data;
            })
            .then(data => {
                console.log('Save response:', data);

                if (data.success) {
                    // Close modal
                    const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                    if (modal) modal.hide();

                    alert(id ? 'Contact updated successfully!' : 'Contact created successfully!');

                    // Reload contacts
                    loadContacts(1);
                } else {
                    alert(data.message || 'Failed to save contact');
                }
            })
            .catch(error => {
                console.error('Error saving contact:', error);
                alert('Error saving contact: ' + error.message);
            })
            .finally(() => {
                saveBtn.innerHTML = originalText;
                saveBtn.disabled = false;
            });
    }

    // View contact details
    function viewContact(id) {
        fetch(`/api/contacts/${id}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showContactDetail(data.data);
                }
            })
            .catch(console.error);
    }

    // Show contact detail modal
    function showContactDetail(contact) {
        const container = document.getElementById('contactDetailContent');
        const avatarColor = getAvatarColor(contact.name);
        const initials = getInitials(contact.name);

        container.innerHTML = `
            <div class="text-center mb-4">
                <div class="contact-avatar mx-auto mb-3" style="background-color: ${avatarColor}; width: 80px; height: 80px; font-size: 2rem;">
                    ${initials}
                </div>
                <h4>${escapeHtml(contact.name)}</h4>
                ${contact.favorite ? '<span class="badge bg-warning"><i class="bi bi-star-fill"></i> Favorite</span>' : ''}
            </div>

            <div class="list-group">
                <div class="list-group-item">
                    <i class="bi bi-telephone me-2"></i>
                    <strong>Phone:</strong> ${escapeHtml(contact.phone_number)}
                </div>
                ${contact.email ? `
                <div class="list-group-item">
                    <i class="bi bi-envelope me-2"></i>
                    <strong>Email:</strong> ${escapeHtml(contact.email)}
                </div>
                ` : ''}
                ${contact.company ? `
                <div class="list-group-item">
                    <i class="bi bi-building me-2"></i>
                    <strong>Company:</strong> ${escapeHtml(contact.company)}
                </div>
                ` : ''}
                ${contact.notes ? `
                <div class="list-group-item">
                    <i class="bi bi-journal-text me-2"></i>
                    <strong>Notes:</strong><br>${escapeHtml(contact.notes)}
                </div>
                ` : ''}
            </div>
        `;

        window.currentContact = contact;

        const modal = new bootstrap.Modal(document.getElementById('contactDetailModal'));
        modal.show();
    }

    // Edit contact
    function editContact(id) {
        fetch(`/api/contacts/${id}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    const contact = data.data;

                    document.getElementById('contactId').value = contact.id;
                    document.getElementById('contactName').value = contact.name || '';
                    setPhoneFieldValue('contactPhone', contact.phone_number || '');
                    document.getElementById('contactEmail').value = contact.email || '';
                    document.getElementById('contactCompany').value = contact.company || '';
                    document.getElementById('contactFavorite').checked = contact.favorite === 1;
                    document.getElementById('contactNotes').value = contact.notes || '';

                    document.getElementById('contactModalTitle').textContent = 'Edit Contact';
                    document.getElementById('deleteContactBtn').classList.remove('d-none');

                    const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
                    modal.show();
                }
            })
            .catch(console.error);
    }

    // Edit from detail
    function editContactFromDetail() {
        if (window.currentContact) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('contactDetailModal'));
            if (modal) modal.hide();

            setTimeout(() => {
                editContact(window.currentContact.id);
            }, 300);
        }
    }

    // Delete contact
    function deleteContact(id) {
        if (!id) {
            id = document.getElementById('contactId').value;
        }

        if (!id) return;

        if (!confirm('Are you sure you want to delete this contact?')) return;

        fetch(`/api/contacts/${id}`, {
            method: 'DELETE'
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Close modal if open
                    const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                    if (modal) modal.hide();

                    alert('Contact deleted successfully');
                    loadContacts(1);
                } else {
                    alert(data.message || 'Failed to delete contact');
                }
            })
            .catch(error => {
                console.error('Error deleting contact:', error);
                alert('Error deleting contact');
            });
    }

    // Toggle favorite
    function toggleFavorite(id, favorite) {
        fetch(`/api/contacts/${id}/favorite`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ favorite })
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    loadContacts(currentPage);
                }
            })
            .catch(console.error);
    }

    // Quick call
    function quickCall(number) {
        if (confirm(`Call ${number}?`)) {
            window.location.href = '/calls';
        }
    }

    // Quick SMS
    function quickSms(number) {
        window.location.href = `/sms?to=${encodeURIComponent(number)}`;
    }

    // Quick call from detail
    function quickCallFromDetail() {
        if (window.currentContact) {
            quickCall(window.currentContact.phone_number);
        }
    }

    // Quick SMS from detail
    function quickSmsFromDetail() {
        if (window.currentContact) {
            quickSms(window.currentContact.phone_number);
        }
    }

    // Helper: Get avatar color
    function getAvatarColor(name) {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
        ];
        const index = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
        return colors[index];
    }

    // Helper: Get initials
    function getInitials(name) {
        return name
            .split(' ')
            .map(word => word[0])
            .join('')
            .toUpperCase()
            .substring(0, 2);
    }

    // Show error
    function showError(message) {
        alert(message);
    }

    // Expose functions globally
    window.loadContacts = loadContacts;
    window.showAddContactModal = showAddContactModal;
    window.saveContact = saveContact;
    window.editContact = editContact;
    window.deleteContact = deleteContact;
    window.viewContact = viewContact;
    window.toggleFavorite = toggleFavorite;
    window.quickCall = quickCall;
    window.quickSms = quickSms;
    window.quickCallFromDetail = quickCallFromDetail;
    window.quickSmsFromDetail = quickSmsFromDetail;
    window.editContactFromDetail = editContactFromDetail;
    window.filterFavorites = filterFavorites;

    // ---- IndexedDB: cache contacts after server fetch ----
    // After each successful server load, persist the full page to IDB.
    // On page 1 with no search filter, attempt to render from IDB first
    // so the list appears instantly before the server responds.
    const _origLoadContacts = window.loadContacts;
    window.loadContacts = function (page) {
        const db = window.localDb;
        const searchVal = (document.getElementById('searchContacts') || {}).value || '';
        // Render from cache only on page 1 with no search
        if (db && (page === 1 || page === undefined) && !searchVal) {
            db.contacts.toArray().then(function (cached) {
                if (cached.length > 0) {
                    // Map IDB records back to the shape displayContacts expects
                    const mapped = cached.map(function (r) { return r.data; }).filter(Boolean);
                    if (mapped.length > 0) displayContacts(mapped);
                }
            }).catch(function () {});
        }
        return _origLoadContacts(page);
    };

    // Patch the inner fetch to also write results to IDB
    const _origFetch = window.fetch;
    // We patch loadContacts' internal fetch by wrapping displayContacts
    const _origDisplayContacts = window.displayContacts;
    if (typeof displayContacts === 'function') {
        // Capture local reference and wrap
        const __display = displayContacts;
        function displayContactsWithCache(contacts) {
            __display(contacts);
            const db = window.localDb;
            if (!db || !contacts || !contacts.length) return;
            const records = contacts.map(function (c) {
                return { server_id: c.id, phone_number: c.phone_number, data: c };
            });
            db.contacts.clear().then(function () {
                return db.contacts.bulkAdd(records);
            }).catch(function () {});
        }
        // Override in module scope is not possible after IIFE — patch via global alias
        window._idbDisplayContacts = displayContactsWithCache;
    }
})();
