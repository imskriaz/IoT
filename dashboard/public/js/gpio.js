// GPIO Management JavaScript
(function () {
    'use strict';

    console.log('GPIO.js loaded - ' + new Date().toISOString());

    // State
    let pins = [];
    let groups = new Map();
    let rules = [];
    let currentDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    let online = false;
    let updateInterval = null;
    let selectedPins = new Set();
    let pinConfigs = {};
    let calculations = {};
    let chartInstances = {};
    let pinHistory = {};
    let automationRules = [];

    const SPECIAL_PIN_NOTES = {
        0: 'Boot strapping pin - avoid driving low at boot',
        6: 'Internal flash SPI - reserved',
        7: 'Internal flash SPI - reserved',
        8: 'Internal flash SPI - reserved',
        9: 'Internal flash SPI - reserved',
        10: 'Onboard MicroSD SPI CS',
        11: 'Onboard MicroSD SPI MOSI',
        12: 'Onboard MicroSD SPI CLK',
        13: 'Onboard MicroSD SPI MISO',
        15: 'Battery / expansion I2C SDA',
        16: 'Battery / expansion I2C SCL',
        17: 'A7670E modem UART RX path on V2',
        18: 'A7670E modem UART TX path on V2',
        19: 'Native USB D-',
        20: 'Native USB D+',
        21: 'TXB0104PWR OE (modem level shifter enable)',
        38: 'WS2812B RGB LED data',
        40: 'Reserved for cross-revision safety',
        43: 'UART0 TX debug console',
        44: 'UART0 RX debug console',
        45: 'Reserved for cross-revision safety'
    };

    // DOM Elements
    const elements = {
        pinsGrid: document.getElementById('pinsGrid'),
        pinStats: document.getElementById('pinStats'),
        groupList: document.getElementById('groupList'),
        rulesList: document.getElementById('rulesList'),
        calculationResult: document.getElementById('calculationResult'),
        pinSelector: document.getElementById('pinSelector'),
        pinMode: document.getElementById('pinMode'),
        pinPull: document.getElementById('pinPull'),
        pinValue: document.getElementById('pinValue'),
        pinPwm: document.getElementById('pinPwm'),
        pinFrequency: document.getElementById('pinFrequency'),
        pinDuration: document.getElementById('pinDuration'),
        applyPinBtn: document.getElementById('applyPinBtn'),
        readPinBtn: document.getElementById('readPinBtn'),
        calculateBtn: document.getElementById('calculateBtn'),
        formulaInput: document.getElementById('formulaInput'),
        conditionInput: document.getElementById('conditionInput'),
        ruleName: document.getElementById('ruleName'),
        ruleAction: document.getElementById('ruleAction'),
        saveRuleBtn: document.getElementById('saveRuleBtn'),
        testConditionBtn: document.getElementById('testConditionBtn'),
        groupName: document.getElementById('groupName'),
        groupPins: document.getElementById('groupPins'),
        saveGroupBtn: document.getElementById('saveGroupBtn'),
        deviceStatus: document.getElementById('deviceStatus'),
        totalPins: document.getElementById('totalPins'),
        outputPins: document.getElementById('outputPins'),
        inputPins: document.getElementById('inputPins'),
        activePins: document.getElementById('activePins')
    };

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        console.log('Initializing GPIO page...');

        loadPinStatus();
        loadGroups();
        loadRules();
        attachEventListeners();
        attachSocketListeners();
        startPeriodicUpdate();

        // Populate pin selector
        populatePinSelector();
        
        // Initialize chart containers
        initCharts();
    }

    // ==================== DATA LOADING ====================

    let pinNames = {}; // { [pin]: { name, color } }

    function loadPinStatus() {
        Promise.all([
            fetch(`/api/gpio/status?deviceId=${currentDeviceId}`).then(r => r.json()),
            fetch(`/api/gpio/${currentDeviceId}/pin-names`).then(r => r.json()).catch(() => ({ success: false }))
        ]).then(([data, namesData]) => {
            if (namesData.success) pinNames = namesData.data || {};
            if (data.success) {
                pins = data.data.pins || [];
                online = data.data.online;

                updatePinGrid();
                updateStats();
                updateDeviceStatus();

                // Load detailed info for each pin
                pins.forEach(pin => loadPinDetails(pin.pin));
            }
        }).catch(error => {
            console.error('Error loading GPIO status:', error);
            showToast('Failed to load GPIO status', 'danger');
        });
    }

    function loadPinDetails(pin) {
        fetch(`/api/gpio/pin/${pin}?deviceId=${currentDeviceId}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    pinConfigs[pin] = data.data;
                    
                    // Update pin in grid
                    updatePinInGrid(pin, data.data);
                    
                    // Update chart if exists
                    updatePinChart(pin, data.data.history);
                }
            })
            .catch(console.error);
    }

    function loadGroups() {
        // Groups are loaded with pin status
    }

    function loadRules() {
        fetch(`/api/gpio/status?deviceId=${currentDeviceId}`)
            .then(r => r.json())
            .then(data => {
                const rulesList = elements.rulesList;
                if (!rulesList) return;
                const rulesArr = data?.data?.rules || [];
                if (!rulesArr.length) {
                    rulesList.innerHTML = '<div class="text-muted small text-center py-2">No rules created</div>';
                    return;
                }
                rulesList.innerHTML = rulesArr.map(r => {
                    const trigger = r.cron_expr
                        ? `<i class="bi bi-clock text-warning me-1"></i><code>${escapeHtml(r.cron_expr)}</code>`
                        : `<code>${escapeHtml(r.condition || '')}</code>`;
                    return `<div class="d-flex justify-content-between align-items-center border-bottom py-1 px-1">
                        <div class="small">
                            <strong>${escapeHtml(r.name)}</strong>
                            <div class="text-muted">${trigger}</div>
                        </div>
                        <div class="d-flex gap-1 align-items-center">
                            <span class="badge ${r.enabled ? 'bg-success' : 'bg-secondary'}">${r.enabled ? 'ON' : 'OFF'}</span>
                            <button class="btn btn-xs btn-outline-danger p-0 px-1" onclick="deleteRule('${escapeHtml(r.id)}')">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>`;
                }).join('');
            })
            .catch(() => {});
    }

    // ==================== UI RENDERING ====================

    function updatePinGrid() {
        if (!elements.pinsGrid) return;

        let html = '';
        
        // Sort pins by number
        const sortedPins = [...pins].sort((a, b) => a.pin - b.pin);

        sortedPins.forEach(pin => {
            const config = pinConfigs[pin.pin]?.config || { mode: 'input' };
            const capabilities = pinConfigs[pin.pin]?.capabilities || {};
            const isSelected = selectedPins.has(pin.pin);
            const value = pin.value || 0;
            const isDigital = typeof value === 'number' && (value === 0 || value === 1);
            const isAnalog = typeof value === 'number' && value > 1;
            
            // Determine pin color based on state
            let pinColor = 'secondary';
            let pinIcon = 'bi-pin';
            
            if (config.mode.includes('output')) {
                pinIcon = value ? 'bi-led-on' : 'bi-led-off';
                pinColor = value ? 'success' : 'secondary';
            } else if (config.mode.includes('input')) {
                pinIcon = 'bi-arrow-right-circle';
                pinColor = value ? 'warning' : 'secondary';
            }

            // Check if pin has special function
            const specialNote = getSpecialPinNote(pin.pin);

            html += `
                <div class="col-6 col-sm-4 col-md-3 col-lg-2">
                    <div class="pin-card ${isSelected ? 'selected' : ''}" data-pin="${pin.pin}" 
                         onclick="togglePinSelect(${pin.pin})" ondblclick="openPinModal(${pin.pin})">
                        <div class="pin-header d-flex justify-content-between align-items-center">
                            <span class="pin-number" title="GPIO${pin.pin}">${escapeHtml(pinNames[pin.pin]?.name || 'GPIO' + pin.pin)}</span>
                            ${specialNote ? `
                                <span class="badge bg-warning text-dark" title="${specialNote}">
                                    <i class="bi bi-exclamation-triangle"></i>
                                </span>
                            ` : ''}
                        </div>
                        <div class="pin-body text-center">
                            <div class="pin-led ${value ? 'active' : ''} ${config.mode}" 
                                 style="background: ${getPinColor(pin)}">
                                <i class="bi ${pinIcon} fs-2"></i>
                            </div>
                            <div class="pin-value mt-1">
                                ${isDigital ? `<span class="badge bg-${value ? 'success' : 'secondary'}">${value ? 'HIGH' : 'LOW'}</span>` : ''}
                                ${isAnalog ? `<span class="badge bg-info">${value}</span>` : ''}
                                ${!isDigital && !isAnalog ? `<span class="badge bg-secondary">---</span>` : ''}
                            </div>
                        </div>
                        <div class="pin-footer">
                            <div class="small text-muted text-truncate">${escapeHtml(config.mode)}</div>
                            <div class="d-flex justify-content-between gap-1 mt-1">
                                ${capabilities.analog ? '<span class="badge bg-info" title="ADC">A</span>' : ''}
                                ${capabilities.pwm ? '<span class="badge bg-warning" title="PWM">P</span>' : ''}
                                ${capabilities.dac ? '<span class="badge bg-success" title="DAC">D</span>' : ''}
                                ${capabilities.touch ? '<span class="badge bg-primary" title="Touch">T</span>' : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        elements.pinsGrid.innerHTML = html;
    }

    function updatePinInGrid(pin, data) {
        const pinElement = document.querySelector(`.pin-card[data-pin="${pin}"]`);
        if (!pinElement) return;

        const value = data.currentValue;
        const config = data.config;
        
        const valueEl = pinElement.querySelector('.pin-value');
        const ledEl = pinElement.querySelector('.pin-led');
        const modeEl = pinElement.querySelector('.pin-footer .small');
        
        if (valueEl) {
            const isDigital = typeof value === 'number' && (value === 0 || value === 1);
            const isAnalog = typeof value === 'number' && value > 1;
            
            valueEl.innerHTML = isDigital ? 
                `<span class="badge bg-${value ? 'success' : 'secondary'}">${value ? 'HIGH' : 'LOW'}</span>` :
                isAnalog ? `<span class="badge bg-info">${value}</span>` :
                '<span class="badge bg-secondary">---</span>';
        }
        
        if (ledEl) {
            ledEl.className = `pin-led ${value ? 'active' : ''} ${config.mode}`;
            ledEl.style.background = getPinColor({ value, config });
        }
        
        if (modeEl) {
            modeEl.textContent = config.mode;
        }
    }

    function updateStats() {
        if (!elements.totalPins) return;

        const total = pins.length;
        const outputs = pins.filter(p => p.config?.mode?.includes('output')).length;
        const inputs = pins.filter(p => p.config?.mode?.includes('input')).length;
        const active = pins.filter(p => p.value).length;

        elements.totalPins.textContent = total;
        elements.outputPins.textContent = outputs;
        elements.inputPins.textContent = inputs;
        elements.activePins.textContent = active;

        // Update device status
        if (elements.deviceStatus) {
            elements.deviceStatus.innerHTML = online ?
                '<span class="badge bg-success"><i class="bi bi-check-circle"></i> Online</span>' :
                '<span class="badge bg-secondary"><i class="bi bi-power"></i> Offline</span>';
        }
    }

    function updateDeviceStatus() {
        if (elements.deviceStatus) {
            elements.deviceStatus.innerHTML = online ?
                '<span class="badge bg-success"><i class="bi bi-check-circle"></i> Online</span>' :
                '<span class="badge bg-secondary"><i class="bi bi-power"></i> Offline</span>';
        }
    }

    // ==================== PIN MODAL ====================

    function openPinModal(pin) {
        const data = pinConfigs[pin];
        if (!data) return;

        // Populate modal
        document.getElementById('modalPinNumber').textContent = pin;
        document.getElementById('modalPinName').value = pinNames[pin]?.name || data.config.name || `GPIO${pin}`;
        document.getElementById('modalPinMode').value = data.config.mode || 'input';
        document.getElementById('modalPinPull').value = data.config.pull || 'none';
        
        // Show/hide appropriate controls
        toggleModalControls(data.config.mode);
        
        // Set values
        if (data.config.mode.includes('output')) {
            document.getElementById('modalPinValue').checked = data.currentValue === 1;
            document.getElementById('modalPwmValue').value = data.currentValue || 0;
            document.getElementById('modalPinFrequency').value = data.config.frequency || 1000;
        }
        
        if (data.config.mode.includes('input')) {
            document.getElementById('modalCurrentValue').textContent = data.currentValue;
            if (data.capabilities.analog) {
                const conversions = calculateConversions(pin, data.currentValue);
                displayConversions(conversions);
            }
        }

        // Show capabilities
        const capsHtml = Object.entries(data.capabilities)
            .filter(([_, v]) => v)
            .map(([k]) => `<span class="badge bg-info me-1">${k.toUpperCase()}</span>`)
            .join('');
        document.getElementById('modalCapabilities').innerHTML = capsHtml;

        // Show history chart
        showPinHistory(pin, data.history);

        const modal = new bootstrap.Modal(document.getElementById('pinModal'));
        modal.show();
    }

    function toggleModalControls(mode) {
        document.getElementById('digitalControl').style.display = mode.includes('output') ? 'block' : 'none';
        document.getElementById('pwmControl').style.display = mode.includes('output') && mode !== 'digital' ? 'block' : 'none';
        document.getElementById('inputDisplay').style.display = mode.includes('input') ? 'block' : 'none';
        document.getElementById('conversionPanel').style.display = mode.includes('input') && pinConfigs[parseInt(document.getElementById('modalPinNumber').textContent)]?.capabilities?.analog ? 'block' : 'none';
    }

    function applyPinSettings(triggerEl) {
        const pin = parseInt(document.getElementById('modalPinNumber').textContent);
        const mode = document.getElementById('modalPinMode').value;
        const pull = document.getElementById('modalPinPull').value;
        const name = document.getElementById('modalPinName').value;

        // Show spinner on save button
        const origBtnText = triggerEl ? triggerEl.innerHTML : null;
        if (triggerEl) { triggerEl.disabled = true; triggerEl.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Applying…'; }

        // First set mode
        fetch('/api/gpio/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, mode, pull, deviceId: currentDeviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // If output, set value
                if (mode.includes('output')) {
                    const value = document.getElementById('modalPinValue')?.checked ? 1 : 0;
                    const pwm = parseInt(document.getElementById('modalPwmValue')?.value) || 0;
                    const freq = parseInt(document.getElementById('modalPinFrequency')?.value) || 1000;
                    const type = mode === 'pwm' ? 'pwm' : 'digital';

                    return writePin(pin, type === 'pwm' ? pwm : value, type, freq);
                }
            }
            return Promise.resolve(data);
        })
        .then(() => {
            // Persist friendly pin name if set
            const defaultName = `GPIO${pin}`;
            if (name && name !== defaultName) {
                fetch(`/api/gpio/${currentDeviceId}/pin-names/${pin}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json',
                               'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
                    body: JSON.stringify({ name })
                }).catch(() => {});
            }
            showToast(`Pin ${pin} configured`, 'success');
            loadPinStatus();

            const modal = bootstrap.Modal.getInstance(document.getElementById('pinModal'));
            modal.hide();
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to configure pin', 'danger');
        })
        .finally(() => {
            if (triggerEl) { triggerEl.disabled = false; triggerEl.innerHTML = origBtnText; }
        });
    }

    function writePin(pin, value, type = 'digital', frequency = 1000, triggerEl) {
        const duration = parseInt(document.getElementById('modalPinDuration')?.value) || 0;

        // Show pending state on the triggering element (if provided)
        const origText = triggerEl ? triggerEl.innerHTML : null;
        if (triggerEl) {
            triggerEl.disabled = true;
            triggerEl.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span>';
        }
        showToast(`Sending command to pin ${pin}…`, 'info');

        return fetch('/api/gpio/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pin,
                value,
                type,
                frequency,
                duration: duration * 1000,
                deviceId: currentDeviceId
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(`Pin ${pin} set to ${value}`, 'success');
                loadPinStatus();
            } else {
                showToast(data.message || `Failed to set pin ${pin}`, 'danger');
            }
            return data;
        })
        .catch(() => showToast(`Failed to set pin ${pin}`, 'danger'))
        .finally(() => {
            if (triggerEl) {
                triggerEl.disabled = false;
                triggerEl.innerHTML = origText;
            }
        });
    }

    function readPin(pin, preferredType = null) {
        const modalMode = document.getElementById('modalPinMode')?.value || 'digital';
        const type = preferredType || (modalMode.includes('analog') ? 'analog' : 'digital');
        
        fetch(`/api/gpio/read/${pin}?deviceId=${currentDeviceId}&type=${type}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    document.getElementById('modalCurrentValue').textContent = data.data.value;
                    
                    if (type === 'analog') {
                        const conversions = calculateConversions(pin, data.data.value);
                        displayConversions(conversions);
                    }
                    
                    showToast(`Pin ${pin} read: ${data.data.value}`, 'info');
                }
            })
            .catch(error => {
                console.error('Error:', error);
                showToast('Failed to read pin', 'danger');
            });
    }

    // ==================== CALCULATIONS ====================

    function calculateConversions(pin, value) {
        const conversions = {
            voltage: (value / 4095) * 3.3,
            percentage: (value / 4095) * 100,
            resistance: (value / 4095) * 10000, // Example for potentiometer
            temperature: ((value / 4095) * 3.3 - 0.5) * 100, // LM35
            light: 100 - (value / 4095 * 100), // LDR (inverse)
            distance: 12343.85 * Math.pow(value, -1.15) // Sharp IR (cm)
        };

        // Apply custom formula if provided
        const formula = document.getElementById('formulaInput')?.value;
        if (formula) {
            try {
                const context = { val: value, pin, ...conversions };
                const func = new Function(...Object.keys(context), `return ${formula}`);
                conversions.custom = func(...Object.values(context));
            } catch (e) {
                conversions.custom = 'Invalid formula';
            }
        }

        return conversions;
    }

    function displayConversions(conversions) {
        const container = document.getElementById('conversionResults');
        if (!container) return;

        let html = '<div class="table-responsive"><table class="table table-sm">';
        for (const [key, value] of Object.entries(conversions)) {
            if (key === 'custom' && value === 'Invalid formula') {
                html += `<tr class="text-danger"><td>${key}</td><td>${value}</td></tr>`;
            } else {
                html += `<tr><td>${key}</td><td>${typeof value === 'number' ? value.toFixed(3) : value}</td></tr>`;
            }
        }
        html += '</table></div>';
        
        container.innerHTML = html;
    }

    function calculateCurrentPin() {
        const pin = parseInt(document.getElementById('modalPinNumber').textContent);
        const value = parseFloat(document.getElementById('modalCurrentValue').textContent) || 0;
        const formula = document.getElementById('formulaInput').value;
        
        fetch('/api/gpio/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin, value, formula })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                displayConversions(data.data);
            }
        })
        .catch(console.error);
    }

    // ==================== AUTOMATION RULES ====================

    function saveRule() {
        const name = elements.ruleName?.value;
        const action = elements.ruleAction?.value;
        const triggerType = document.querySelector('input[name="triggerType"]:checked')?.value || 'pin';

        let condition = '';
        let cron_expr = null;

        if (triggerType === 'cron') {
            const timeVal = document.getElementById('cronTime')?.value;
            if (!timeVal) { showToast('Select a time for cron trigger', 'warning'); return; }
            const days = Array.from(document.querySelectorAll('.cronDay:checked')).map(el => el.value);
            cron_expr = days.length ? `${timeVal}:${days.join(',')}` : timeVal;
        } else {
            condition = elements.conditionInput?.value;
            if (!condition) { showToast('Enter a condition', 'warning'); return; }
        }

        if (!name || !action) {
            showToast('Please fill all fields', 'warning');
            return;
        }

        fetch('/api/gpio/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                condition,
                cron_expr,
                action,
                deviceId: currentDeviceId
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Rule created', 'success');
                loadRules();
                
                const modal = bootstrap.Modal.getInstance(document.getElementById('ruleModal'));
                modal.hide();
            }
        })
        .catch(console.error);
    }

    function deleteRule(ruleId) {
        if (!confirm('Delete this rule?')) return;
        fetch(`/api/gpio/rules/${ruleId}?deviceId=${currentDeviceId}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(data => { if (data.success) { showToast('Rule deleted', 'success'); loadRules(); } })
            .catch(console.error);
    }
    window.deleteRule = deleteRule;

    function testCondition() {
        const condition = elements.conditionInput?.value;
        
        // Get current pin values
        const values = {};
        pins.forEach(p => { values[`pin${p.pin}`] = p.value; });

        fetch('/api/gpio/rules/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ condition, values })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(`Condition result: ${data.data.result}`, data.data.result ? 'success' : 'info');
            }
        })
        .catch(console.error);
    }

    // ==================== GROUPS ====================

    function saveGroup() {
        const name = elements.groupName?.value;
        const pins = elements.groupPins?.value.split(',').map(p => parseInt(p.trim()));

        if (!name || !pins || pins.length === 0) {
            showToast('Please enter group name and pins', 'warning');
            return;
        }

        fetch('/api/gpio/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, pins, deviceId: currentDeviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Group created', 'success');
                loadGroups();
                
                const modal = bootstrap.Modal.getInstance(document.getElementById('groupModal'));
                modal.hide();
            }
        })
        .catch(console.error);
    }

    // ==================== SELECTION ====================

    function togglePinSelect(pin) {
        if (selectedPins.has(pin)) {
            selectedPins.delete(pin);
        } else {
            selectedPins.add(pin);
        }
        
        document.querySelector(`.pin-card[data-pin="${pin}"]`)?.classList.toggle('selected');
        updateSelectionToolbar();
    }

    function selectAllPins() {
        pins.forEach(p => selectedPins.add(p.pin));
        updatePinGrid();
        updateSelectionToolbar();
    }

    function clearSelection() {
        selectedPins.clear();
        updatePinGrid();
        updateSelectionToolbar();
    }

    function updateSelectionToolbar() {
        const count = selectedPins.size;
        const toolbar = document.getElementById('selectionToolbar');
        
        if (toolbar) {
            toolbar.style.display = count > 0 ? 'flex' : 'none';
            document.getElementById('selectedCount').textContent = count;
        }
    }

    function setSelectedHigh() {
        selectedPins.forEach(pin => {
            writePin(pin, 1, 'digital');
        });
    }

    function setSelectedLow() {
        selectedPins.forEach(pin => {
            writePin(pin, 0, 'digital');
        });
    }

    function setSelectedPwm() {
        const value = prompt('Enter PWM value (0-255):', '128');
        if (value) {
            selectedPins.forEach(pin => {
                writePin(pin, parseInt(value), 'pwm');
            });
        }
    }

    function toggleSelectedMode() {
        const mode = prompt('Enter mode (input/output/input_pullup/input_pulldown):', 'output');
        if (mode) {
            selectedPins.forEach(pin => {
                fetch('/api/gpio/mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin, mode, deviceId: currentDeviceId })
                }).catch(console.error);
            });
        }
    }

    // ==================== CHARTS ====================

    function initCharts() {
        // Initialize chart containers
    }

    function updatePinChart(pin, history) {
        const canvas = document.getElementById(`pinChart-${pin}`);
        if (!canvas || !history || history.length < 2) return;

        if (chartInstances[pin]) {
            chartInstances[pin].destroy();
        }

        const ctx = canvas.getContext('2d');
        chartInstances[pin] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: history.map(h => new Date(h.timestamp).toLocaleTimeString()),
                datasets: [{
                    label: `GPIO${pin} Value`,
                    data: history.map(h => h.value),
                    borderColor: '#0d6efd',
                    backgroundColor: 'rgba(13, 110, 253, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 255
                    }
                }
            }
        });
    }

    function showPinHistory(pin, history) {
        const container = document.getElementById('pinHistory');
        if (!container) return;

        if (!history || history.length === 0) {
            container.innerHTML = '<p class="text-muted text-center">No history yet</p>';
            return;
        }

        let html = '<div class="table-responsive"><table class="table table-sm">';
        html += '<thead><tr><th>Time</th><th>Value</th><th>Type</th></tr></thead><tbody>';
        
        history.slice(-10).reverse().forEach(h => {
            const time = new Date(h.timestamp).toLocaleTimeString();
            html += `<tr>
                <td>${time}</td>
                <td><span class="badge bg-${h.value ? 'success' : 'secondary'}">${h.value}</span></td>
                <td>${h.type || 'digital'}</td>
            </tr>`;
        });
        
        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // ==================== UTILITY ====================

    function getPinColor(pin) {
        if (!pin.value) return '#6c757d'; // gray
        if (pin.config?.mode?.includes('output')) return '#198754'; // green
        if (pin.config?.mode?.includes('input')) return '#ffc107'; // yellow
        return '#0d6efd'; // blue
    }

    function getSpecialPinNote(pin) {
        return SPECIAL_PIN_NOTES[pin] || null;
    }

    function populatePinSelector() {
        if (!elements.pinSelector) return;

        let options = '';
        for (let i = 0; i <= 39; i++) {
            options += `<option value="${i}">GPIO${i}</option>`;
        }
        elements.pinSelector.innerHTML = options;
    }

    function startPeriodicUpdate() {
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(() => {
            if (online) {
                loadPinStatus();
            }
        }, 5000);
    }

    function stopPeriodicUpdate() {
        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }
    }

    function refreshGPIO() {
        loadPinStatus();
        showToast('GPIO data refreshed', 'success');
    }

    function exportConfig() {
        const config = {
            pins: pinConfigs,
            groups: Array.from(groups.entries()),
            rules,
            timestamp: new Date().toISOString()
        };

        const dataStr = JSON.stringify(config, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        
        const exportFileDefaultName = `gpio-config-${new Date().toISOString().slice(0,10)}.json`;
        
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
        
        showToast('Configuration exported', 'success');
    }

    function importConfig() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = e => {
            const file = e.target.files[0];
            const reader = new FileReader();
            
            reader.onload = event => {
                try {
                    const config = JSON.parse(event.target.result);
                    // Apply config
                    showToast('Configuration imported', 'success');
                    loadPinStatus();
                } catch (err) {
                    showToast('Invalid config file', 'danger');
                }
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    }

    // ==================== EVENT LISTENERS ====================

    function attachEventListeners() {
        // Pin modal
        document.getElementById('savePinBtn')?.addEventListener('click', function() { applyPinSettings(this); });
        document.getElementById('readPinNow')?.addEventListener('click', () => {
            const pin = parseInt(document.getElementById('modalPinNumber').textContent);
            readPin(pin);
        });

        // Pin mode change
        document.getElementById('modalPinMode')?.addEventListener('change', (e) => {
            toggleModalControls(e.target.value);
        });

        // Calculations
        document.getElementById('calculateBtn')?.addEventListener('click', calculateCurrentPin);

        // Rules
        document.getElementById('saveRuleBtn')?.addEventListener('click', saveRule);
        document.getElementById('testConditionBtn')?.addEventListener('click', testCondition);

        // Groups
        document.getElementById('saveGroupBtn')?.addEventListener('click', saveGroup);

        // Selection toolbar
        document.getElementById('selectAllBtn')?.addEventListener('click', selectAllPins);
        document.getElementById('clearSelectionBtn')?.addEventListener('click', clearSelection);
        document.getElementById('setHighBtn')?.addEventListener('click', setSelectedHigh);
        document.getElementById('setLowBtn')?.addEventListener('click', setSelectedLow);
        document.getElementById('setPwmBtn')?.addEventListener('click', setSelectedPwm);
        document.getElementById('setModeBtn')?.addEventListener('click', toggleSelectedMode);

        // Export/Import
        document.getElementById('exportConfigBtn')?.addEventListener('click', exportConfig);
        document.getElementById('importConfigBtn')?.addEventListener('click', importConfig);

        // Refresh button
        document.getElementById('refreshGPIO')?.addEventListener('click', refreshGPIO);

        // Device selector
        document.getElementById('deviceSelector')?.addEventListener('change', (e) => {
            currentDeviceId = e.target.value;
            loadPinStatus();
        });

        window.addEventListener('device:changed', (event) => {
            currentDeviceId = event.detail?.deviceId || (window.getActiveDeviceId ? window.getActiveDeviceId() : '') || currentDeviceId;
            loadPinStatus();
        });
    }

    function attachSocketListeners() {
        if (typeof socket === 'undefined') return;

        socket.off('gpio:update');
        socket.on('gpio:update', (data) => {
            if (data.deviceId === currentDeviceId) {
                console.log('GPIO update:', data);
                
                // Update pin value
                const pin = pins.find(p => p.pin === data.pin);
                if (pin) {
                    pin.value = data.value;
                    updatePinInGrid(data.pin, { currentValue: data.value, config: pin.config });
                }
                
                showToast(`Pin ${data.pin} changed to ${data.value}`, 'info');
            }
        });
    }

    // Cleanup
    window.addEventListener('beforeunload', () => {
        stopPeriodicUpdate();
    });

    // Expose functions globally
    window.togglePinSelect = togglePinSelect;
    window.openPinModal = openPinModal;
    window.refreshGPIO = refreshGPIO;
    window.exportConfig = exportConfig;
    window.importConfig = importConfig;
    window.writePin = writePin;
    window.readPin = readPin;

    console.log('GPIO.js initialized');
})();
