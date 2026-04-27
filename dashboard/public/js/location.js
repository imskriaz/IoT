// Location Management JavaScript with Leaflet
(function () {
    'use strict';

    console.log('Location.js loaded - ' + new Date().toISOString());

    // State
    let map = null;
    let marker = null;
    let pathLine = null;
    let historyMarkers = [];
    let currentLocation = null;
    let trackingInterval = null;
    let trackingEnabled = false;
    let updateInterval = 30000; // 30 seconds
    let locations = [];
    let mapInitialized = false;
    let deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    let tileLayer = null;
    let accuracyCircle = null;
    let pageCtrl = null;

    function newSignal() {
        if (pageCtrl) pageCtrl.abort();
        pageCtrl = new AbortController();
        return pageCtrl.signal;
    }

    window.addEventListener('beforeunload', function () { if (pageCtrl) pageCtrl.abort(); });

    // DOM Elements
    const elements = {
        latitude: document.getElementById('currentLatitude'),
        longitude: document.getElementById('currentLongitude'),
        altitude: document.getElementById('currentAltitude'),
        speed: document.getElementById('currentSpeed'),
        heading: document.getElementById('currentHeading'),
        satellites: document.getElementById('currentSatellites'),
        accuracy: document.getElementById('currentAccuracy'),
        accuracyBar: document.getElementById('accuracyBar'),
        fixQuality: document.getElementById('fixQuality'),
        lastUpdate: document.getElementById('lastUpdate'),
        gpsToggle: document.getElementById('gpsToggle'),
        gpsStatus: document.getElementById('gpsStatus'),
        gpsStatusBanner: document.getElementById('gpsStatusBanner'),
        trackingToggle: document.getElementById('trackingToggle'),
        updateRate: document.getElementById('updateRate'),
        rateValue: document.getElementById('rateValue'),
        historyContainer: document.getElementById('locationHistory'),
        locationStats: document.getElementById('locationStats'),
        mapContainer: document.getElementById('locationMap')
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        console.log('Initializing Location page with Leaflet...');

        // Load initial data — map is lazily initialized once GPS data arrives
        loadCurrentLocation();
        loadLocationHistory();
        loadGPSStatus();
        loadLocationStats();

        // Attach event listeners
        attachEventListeners();
        attachSocketListeners();

        // Start periodic updates if tracking enabled
        startTrackingIfEnabled();

        // Update rate display
        if (elements.updateRate && elements.rateValue) {
            elements.updateRate.addEventListener('input', function() {
                elements.rateValue.textContent = this.value + 's';
            });
        }
    }

    // ==================== MAP INITIALIZATION WITH LEAFLET ====================

    function initMap() {
        if (!elements.mapContainer) return;

        // Neutral world view until we receive a real device fix.
        const defaultCenter = [20, 0];

        // Initialize map
        map = L.map(elements.mapContainer).setView(defaultCenter, 2);

        // Add OpenStreetMap tile layer (free, no API key required)
        tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
            minZoom: 3
        }).addTo(map);

        // Add scale control
        L.control.scale({ imperial: false, metric: true }).addTo(map);

        // Add fullscreen control (optional - need to include leaflet.fullscreen.css)
        if (L.control.fullscreen) {
            L.control.fullscreen().addTo(map);
        }

        // Create custom icon for current location
        const currentLocationIcon = L.divIcon({
            className: 'current-location-marker',
            html: '<div class="marker-pulse"></div><div class="marker-core"></div>',
            iconSize: [30, 30],
            popupAnchor: [0, -15]
        });

        // Create marker for current location
        marker = L.marker(defaultCenter, {
            icon: currentLocationIcon,
            title: 'Current Location',
            riseOnHover: true
        }).addTo(map);

        // Add accuracy circle
        accuracyCircle = L.circle(defaultCenter, {
            radius: 50,
            color: '#0d6efd',
            weight: 1,
            fillColor: '#0d6efd',
            fillOpacity: 0.1
        }).addTo(map);

        // Create popup content
        const popupContent = `
            <div class="marker-popup">
                <strong>📍 Current Location</strong><br>
                <span class="text-muted">Waiting for GPS fix...</span>
            </div>
        `;
        marker.bindPopup(popupContent);

        // Initialize path line
        pathLine = L.polyline([], {
            color: '#dc3545',
            weight: 3,
            opacity: 0.7,
            smoothFactor: 1,
            lineCap: 'round'
        }).addTo(map);

        mapInitialized = true;
        console.log('✅ Leaflet map initialized');
    }

    function updateMapLocation(location) {
        if (!map || !marker) return;

        const latlng = [location.latitude, location.longitude];

        // Update marker position
        marker.setLatLng(latlng);

        // Update accuracy circle
        if (accuracyCircle) {
            accuracyCircle.setLatLng(latlng);
            if (location.accuracy && location.accuracy > 0) {
                accuracyCircle.setRadius(location.accuracy);
                accuracyCircle.setStyle({
                    color: location.accuracy < 10 ? '#198754' : 
                           location.accuracy < 50 ? '#ffc107' : '#dc3545'
                });
            }
        }

        // Center map on new location (with smooth animation)
        map.panTo(latlng, { animate: true, duration: 1 });

        // Update popup content
        const popupContent = `
            <div class="marker-popup">
                <strong>📍 Current Location</strong>
                <hr class="my-1">
                <table class="table table-sm small mb-0">
                    <tr>
                        <td>Latitude:</td>
                        <td class="fw-bold">${location.latitude.toFixed(6)}°</td>
                    </tr>
                    <tr>
                        <td>Longitude:</td>
                        <td class="fw-bold">${location.longitude.toFixed(6)}°</td>
                    </tr>
                    ${location.altitude ? `
                    <tr>
                        <td>Altitude:</td>
                        <td class="fw-bold">${location.altitude.toFixed(1)} m</td>
                    </tr>` : ''}
                    ${location.speed ? `
                    <tr>
                        <td>Speed:</td>
                        <td class="fw-bold">${(location.speed * 3.6).toFixed(1)} km/h</td>
                    </tr>` : ''}
                    <tr>
                        <td>Satellites:</td>
                        <td class="fw-bold">${location.satellites || 0}</td>
                    </tr>
                    <tr>
                        <td>Accuracy:</td>
                        <td class="fw-bold">${(location.accuracy || 0).toFixed(1)} m</td>
                    </tr>
                </table>
                <small class="text-muted d-block mt-1">${formatDate(location.timestamp)}</small>
            </div>
        `;
        marker.setPopupContent(popupContent);

        // Add pulse animation class
        marker.getElement()?.classList.add('marker-active');
        setTimeout(() => {
            marker.getElement()?.classList.remove('marker-active');
        }, 1000);
    }

    function updatePathLine(locations) {
        if (!map || !pathLine || !locations || locations.length < 2) return;

        const path = locations.map(loc => [loc.latitude, loc.longitude]).reverse();
        pathLine.setLatLngs(path);

        // Fit bounds to show entire path
        if (locations.length > 1) {
            const bounds = L.latLngBounds(path);
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
        }
    }

    function addHistoryMarkers(locations) {
        // Clear existing markers
        historyMarkers.forEach(m => map.removeLayer(m));
        historyMarkers = [];

        if (!map || !locations || locations.length === 0) return;

        // Add marker for each location (limit to last 10)
        locations.slice(0, 10).forEach((loc, index) => {
            const latlng = [loc.latitude, loc.longitude];
            
            // Choose icon based on recency
            const icon = L.divIcon({
                className: `history-marker ${index === 0 ? 'latest' : 'old'}`,
                html: `<div class="marker-dot" style="background: ${index === 0 ? '#198754' : '#0d6efd'}"></div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });

            const historyMarker = L.marker(latlng, {
                icon: icon,
                title: `Location ${index + 1}`,
                opacity: 0.8,
                zIndexOffset: -index
            }).addTo(map);

            const popupContent = `
                <div class="marker-popup">
                    <strong>${index === 0 ? 'Latest' : 'Previous'} Location</strong><br>
                    <small>${formatDate(loc.timestamp)}</small>
                    <hr class="my-1">
                    <div>${loc.latitude.toFixed(6)}°, ${loc.longitude.toFixed(6)}°</div>
                    ${loc.altitude ? `<div>Altitude: ${loc.altitude.toFixed(1)}m</div>` : ''}
                </div>
            `;
            historyMarker.bindPopup(popupContent);

            historyMarkers.push(historyMarker);
        });
    }

    // ==================== DATA LOADING ====================

    function loadCurrentLocation() {
        fetch(`/api/location/current?deviceId=${deviceId}`, { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success && data.data) {
                    currentLocation = data.data;
                    updateLocationDisplay(data.data);

                    if (!mapInitialized) initMap();
                    updateMapLocation(data.data);
                } else {
                    showToast(data.message || 'No GPS fix available', 'warning');
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading location:', error);
                showToast('Failed to load location', 'danger');
            });
    }

    function loadLocationHistory() {
        // Show IDB cache immediately for instant first paint, then refresh from server
        const db = window.localDb;
        if (db) {
            db.gps
                .where('device_id').equals(deviceId)
                .reverse().sortBy('timestamp')
                .then(function (rows) {
                    if (rows.length > 0 && locations.length === 0) {
                        const idbData = rows.slice(0, 50).map(r => ({
                            latitude: r.latitude,
                            longitude: r.longitude,
                            altitude: r.altitude,
                            satellites: r.satellites,
                            accuracy: r.accuracy,
                            timestamp: r.timestamp
                        }));
                        locations = idbData;
                        displayLocationHistory(idbData);
                        if (!mapInitialized) initMap();
                        updatePathLine(idbData);
                        addHistoryMarkers(idbData);
                    }
                }).catch(function () {});
        }

        fetch(`/api/location/history?deviceId=${deviceId}&limit=50`, { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    locations = data.data;
                    displayLocationHistory(data.data);

                    if (data.data.length > 0) {
                        if (!mapInitialized) initMap();
                        updatePathLine(data.data);
                        addHistoryMarkers(data.data);
                    }
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading history:', error);
                if (locations.length === 0 && elements.historyContainer) {
                    elements.historyContainer.innerHTML = `
                        <div class="text-center py-4 text-danger">
                            <i class="bi bi-exclamation-triangle fs-1"></i>
                            <p>Failed to load history</p>
                        </div>
                    `;
                }
            });
    }

    function loadGPSStatus() {
        fetch(`/api/location/status?deviceId=${deviceId}`, { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    updateGPSStatus(data.data);

                    if (elements.gpsToggle) {
                        elements.gpsToggle.checked = data.data.enabled;
                    }

                    if (elements.updateRate) {
                        elements.updateRate.value = data.data.updateRate || 10;
                        if (elements.rateValue) {
                            elements.rateValue.textContent = (data.data.updateRate || 10) + 's';
                        }
                    }

                    if (data.data.enabled) {
                        startTrackingIfEnabled();
                    }
                }
            })
            .catch(error => { if (error.name !== 'AbortError') console.error(error); });
    }

    function loadLocationStats() {
        fetch(`/api/location/stats?deviceId=${deviceId}`, { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success && elements.locationStats) {
                    displayLocationStats(data.data);
                }
            })
            .catch(error => { if (error.name !== 'AbortError') console.error(error); });
    }

    function updateLocationDisplay(location) {
        if (elements.latitude) elements.latitude.textContent = location.latitude ? location.latitude.toFixed(6) + '°' : '---';
        if (elements.longitude) elements.longitude.textContent = location.longitude ? location.longitude.toFixed(6) + '°' : '---';
        if (elements.altitude) elements.altitude.textContent = location.altitude ? location.altitude.toFixed(1) + ' m' : '---';
        if (elements.speed) elements.speed.textContent = location.speed ? (location.speed * 3.6).toFixed(1) + ' km/h' : '---';
        if (elements.heading) elements.heading.textContent = location.heading ? location.heading.toFixed(0) + '°' : '---';
        if (elements.satellites) elements.satellites.textContent = location.satellites || '0';
        if (elements.accuracy) {
            elements.accuracy.textContent = location.accuracy ? location.accuracy.toFixed(1) + ' m' : '---';
            if (elements.accuracyBar) {
                const accuracyPercent = location.accuracy ? Math.min(100, 100 - (location.accuracy / 100 * 100)) : 0;
                elements.accuracyBar.style.width = Math.max(0, accuracyPercent) + '%';
                elements.accuracyBar.className = location.accuracy < 10 ? 'progress-bar bg-success' : 
                                                  location.accuracy < 50 ? 'progress-bar bg-warning' : 
                                                  'progress-bar bg-danger';
            }
        }
        if (elements.fixQuality) {
            elements.fixQuality.textContent = getFixQualityText(location.fix_quality);
            elements.fixQuality.className = getFixQualityClass(location.fix_quality);
        }
        if (elements.lastUpdate) {
            elements.lastUpdate.textContent = location.timestamp ? 
                'Updated: ' + new Date(location.timestamp).toLocaleString() : 'Never';
        }
    }

    function updateGPSStatus(status) {
        if (!elements.gpsStatus || !elements.gpsStatusBanner) return;

        if (status.enabled) {
            if (status.fix) {
                elements.gpsStatus.innerHTML = `
                    <span class="badge bg-success">
                        <i class="bi bi-check-circle"></i> 3D Fix (${status.satellites} sats)
                    </span>
                `;
                elements.gpsStatusBanner.className = 'alert alert-success d-flex align-items-center mb-4';
            } else {
                elements.gpsStatus.innerHTML = `
                    <span class="badge bg-warning">
                        <i class="bi bi-hourglass-split"></i> Searching...
                    </span>
                `;
                elements.gpsStatusBanner.className = 'alert alert-warning d-flex align-items-center mb-4';
            }
        } else {
            elements.gpsStatus.innerHTML = `
                <span class="badge bg-secondary">
                    <i class="bi bi-power"></i> Disabled
                </span>
            `;
            elements.gpsStatusBanner.className = 'alert alert-secondary d-flex align-items-center mb-4';
        }
    }

    function displayLocationHistory(locations) {
        const container = elements.historyContainer;
        if (!container) return;

        if (!locations || locations.length === 0) {
            container.innerHTML = `
                <div class="text-center py-4">
                    <i class="bi bi-geo-alt fs-1 text-muted"></i>
                    <p class="text-muted mt-2">No location history yet</p>
                </div>
            `;
            return;
        }

        let html = '';
        locations.forEach((loc, index) => {
            const date = new Date(loc.timestamp);
            const isToday = new Date().toDateString() === date.toDateString();
            
            html += `
                <div class="list-group-item list-group-item-action" data-location-id="${loc.id}">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <div class="d-flex align-items-center gap-2 mb-1">
                                <span class="badge ${index === 0 ? 'bg-success' : 'bg-secondary'}">
                                    ${index === 0 ? 'Latest' : '#' + (index + 1)}
                                </span>
                                <small class="text-muted">
                                    ${isToday ? 'Today' : date.toLocaleDateString()} ${date.toLocaleTimeString()}
                                </small>
                            </div>
                            <div class="small">
                                <i class="bi bi-geo-alt-fill text-danger me-1"></i>
                                ${loc.latitude.toFixed(6)}°, ${loc.longitude.toFixed(6)}°
                            </div>
                            <div class="d-flex gap-3 mt-1 small text-muted">
                                ${loc.altitude ? `<span><i class="bi bi-arrow-up"></i> ${loc.altitude.toFixed(1)}m</span>` : ''}
                                ${loc.speed ? `<span><i class="bi bi-speedometer2"></i> ${(loc.speed * 3.6).toFixed(1)}km/h</span>` : ''}
                                <span><i class="bi bi-satellite"></i> ${loc.satellites || 0} sats</span>
                            </div>
                        </div>
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-outline-primary" onclick="centerOnLocation(${loc.latitude}, ${loc.longitude})">
                                <i class="bi bi-crosshair"></i>
                            </button>
                            <button class="btn btn-outline-danger" onclick="deleteLocation(${loc.id})">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    function displayLocationStats(stats) {
        if (!elements.locationStats) return;

        elements.locationStats.innerHTML = `
            <div class="row g-2">
                <div class="col-6 col-md-3">
                    <div class="border rounded p-2 text-center">
                        <small class="text-muted d-block">Total Fixes</small>
                        <strong class="fs-5">${stats.total_fixes || 0}</strong>
                    </div>
                </div>
                <div class="col-6 col-md-3">
                    <div class="border rounded p-2 text-center">
                        <small class="text-muted d-block">Max Satellites</small>
                        <strong class="fs-5">${stats.max_satellites || 0}</strong>
                    </div>
                </div>
                <div class="col-6 col-md-3">
                    <div class="border rounded p-2 text-center">
                        <small class="text-muted d-block">Avg Accuracy</small>
                        <strong class="fs-5">${stats.avg_accuracy ? stats.avg_accuracy.toFixed(1) + 'm' : '0m'}</strong>
                    </div>
                </div>
                <div class="col-6 col-md-3">
                    <div class="border rounded p-2 text-center">
                        <small class="text-muted d-block">First Fix</small>
                        <strong class="small">${stats.first_fix ? new Date(stats.first_fix).toLocaleDateString() : 'Never'}</strong>
                    </div>
                </div>
            </div>
        `;
    }

    // ==================== ACTIONS ====================

    function toggleGPS() {
        if (!elements.gpsToggle) return;

        const enabled = elements.gpsToggle.checked;
        const toggleBtn = elements.gpsToggle;

        // Store original state
        const originalChecked = toggleBtn.checked;

        fetch('/api/location/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadGPSStatus();
                
                if (enabled) {
                    startTracking();
                } else {
                    stopTracking();
                }
            } else {
                toggleBtn.checked = originalChecked;
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            toggleBtn.checked = originalChecked;
            showToast('Failed to toggle GPS', 'danger');
        });
    }

    function toggleTracking() {
        if (!elements.trackingToggle) return;

        trackingEnabled = elements.trackingToggle.checked;
        
        if (trackingEnabled) {
            startTracking();
            showToast('Location tracking enabled', 'success');
        } else {
            stopTracking();
            showToast('Location tracking disabled', 'info');
        }

        // Save preference
        localStorage.setItem('gpsTrackingEnabled', trackingEnabled);
    }

    function startTracking() {
        stopTracking(); // Clear any existing interval
        
        const rate = parseInt(elements.updateRate?.value) || 30;
        trackingInterval = setInterval(() => {
            loadCurrentLocation();
            loadLocationHistory(); // Refresh history periodically
        }, rate * 1000);
        
        console.log(`📍 Tracking started (${rate}s interval)`);
    }

    function stopTracking() {
        if (trackingInterval) {
            clearInterval(trackingInterval);
            trackingInterval = null;
        }
    }

    function startTrackingIfEnabled() {
        const savedPreference = localStorage.getItem('gpsTrackingEnabled') === 'true';
        
        if (elements.trackingToggle) {
            elements.trackingToggle.checked = savedPreference;
            trackingEnabled = savedPreference;
            
            if (savedPreference) {
                startTracking();
            }
        }
    }

    function refreshLocation() {
        loadCurrentLocation();
        loadLocationHistory();
        loadGPSStatus();
        loadLocationStats();
        showToast('Location data refreshed', 'success');
    }

    function saveGPSConfig() {
        const updateRate = parseInt(document.getElementById('updateRate')?.value) || 10;
        const minFixTime = parseInt(document.getElementById('minFixTime')?.value) || 30;
        const powerSave = document.getElementById('powerSaveMode')?.checked || false;

        fetch('/api/location/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                update_rate: updateRate,
                minimum_fix_time: minFixTime,
                power_save_mode: powerSave,
                deviceId
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('GPS configuration saved', 'success');
                
                // Restart tracking with new rate
                if (trackingEnabled) {
                    startTracking();
                }
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function clearHistory() {
        if (!confirm('Clear all location history? This cannot be undone.')) return;

        fetch(`/api/location/history/device/${deviceId}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Location history cleared', 'success');
                loadLocationHistory();
                
                // Clear path and markers
                if (pathLine) pathLine.setLatLngs([]);
                historyMarkers.forEach(m => map.removeLayer(m));
                historyMarkers = [];
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function deleteLocation(id) {
        if (!confirm('Delete this location?')) return;

        fetch(`/api/location/history/${id}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Location deleted', 'success');
                loadLocationHistory();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function centerOnLocation(lat, lng) {
        if (!map) return;
        
        map.panTo([parseFloat(lat), parseFloat(lng)], { animate: true, duration: 1 });
        map.setZoom(18);
    }

    function exportLocations() {
        if (!locations || locations.length === 0) {
            showToast('No locations to export', 'warning');
            return;
        }

        const dataStr = JSON.stringify(locations, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        
        const exportFileDefaultName = `gps-locations-${new Date().toISOString().slice(0,10)}.json`;
        
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
        
        showToast('Locations exported', 'success');
    }

    // ==================== UTILITY FUNCTIONS ====================

    function getFixQualityText(quality) {
        const map = {
            0: 'No Fix',
            1: 'GPS Fix',
            2: 'DGPS Fix',
            3: 'PPS Fix',
            4: 'RTK Fix',
            5: 'RTK Float',
            6: 'Estimated'
        };
        return map[quality] || 'Unknown';
    }

    function getFixQualityClass(quality) {
        if (quality >= 4) return 'badge bg-success';
        if (quality >= 2) return 'badge bg-info';
        if (quality >= 1) return 'badge bg-warning';
        return 'badge bg-secondary';
    }

    function formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString();
    }

    function showToast(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            alert(message);
        }
    }

    // ==================== EVENT LISTENERS ====================

    function attachEventListeners() {
        // GPS toggle
        if (elements.gpsToggle) {
            elements.gpsToggle.addEventListener('change', toggleGPS);
        }

        // Tracking toggle
        if (elements.trackingToggle) {
            elements.trackingToggle.addEventListener('change', toggleTracking);
        }

        // Update rate change
        if (elements.updateRate) {
            elements.updateRate.addEventListener('change', () => {
                if (trackingEnabled) {
                    startTracking();
                }
            });
        }

        // Refresh button
        const refreshBtn = document.getElementById('refreshLocation');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', refreshLocation);
        }

        // Save config button
        const saveConfigBtn = document.getElementById('saveGPSConfig');
        if (saveConfigBtn) {
            saveConfigBtn.addEventListener('click', saveGPSConfig);
        }

        // Clear history button
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        if (clearHistoryBtn) {
            clearHistoryBtn.addEventListener('click', clearHistory);
        }

        // Export button
        const exportBtn = document.getElementById('exportLocations');
        if (exportBtn) {
            exportBtn.addEventListener('click', exportLocations);
        }

        // Time range filter
        const timeRange = document.getElementById('timeRange');
        if (timeRange) {
            timeRange.addEventListener('change', () => {
                // Implement time range filtering
                loadLocationHistory();
            });
        }
    }

    function attachSocketListeners() {
        if (typeof socket === 'undefined') return;

        socket.off('location:update');
        socket.on('location:update', (data) => {
            if (data.deviceId === deviceId) {
                console.log('📍 Real-time location update:', data);
                currentLocation = data;
                updateLocationDisplay(data);
                
                if (mapInitialized) {
                    updateMapLocation(data);
                    
                    // Add to path
                    locations.unshift(data);
                    if (locations.length > 50) locations.pop();
                    
                    updatePathLine(locations);
                    addHistoryMarkers(locations);
                    displayLocationHistory(locations);
                }
                
                showToast('Location updated', 'info');
            }
        });
    }

    // Cleanup
    window.addEventListener('beforeunload', () => {
        stopTracking();
    });

    // ==================== GEOFENCES ====================

    let geofenceLayers = {}; // fenceId -> { circle, marker }

    function loadGeofences() {
        const list = document.getElementById('geofenceList');
        if (!list) return;

        fetch(`/api/location/geofences?deviceId=${deviceId}`)
            .then(r => r.json())
            .then(data => {
                if (!data.success) throw new Error(data.message);
                renderGeofenceList(data.data);
                renderGeofencesOnMap(data.data);
            })
            .catch(err => {
                console.error('Geofence load failed:', err);
                if (list) list.innerHTML = '<div class="list-group-item text-danger">Failed to load geofences</div>';
            });
    }

    function renderGeofenceList(fences) {
        const list = document.getElementById('geofenceList');
        if (!list) return;
        if (!fences.length) {
            list.innerHTML = '<div class="list-group-item text-muted text-center py-3">No geofences yet. Click "Add Geofence" to create one.</div>';
            return;
        }
        list.innerHTML = fences.map(f => `
            <div class="list-group-item d-flex justify-content-between align-items-center">
                <div>
                    <i class="bi bi-hexagon${f.active ? '-fill text-warning' : ' text-muted'} me-2"></i>
                    <strong>${escapeHtml(String(f.name))}</strong>
                    <span class="ms-2 text-muted small">${f.radius_m}m &middot; ${f.alert_on}</span>
                    <span class="badge ${f.active ? 'bg-success' : 'bg-secondary'} ms-2">${f.active ? 'Active' : 'Inactive'}</span>
                </div>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-secondary" onclick="centerOnFence(${f.latitude},${f.longitude})" title="Pan to fence">
                        <i class="bi bi-geo-alt"></i>
                    </button>
                    <button class="btn btn-outline-primary" onclick="openEditGeofenceModal(${f.id})" title="Edit">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-outline-danger" onclick="deleteGeofence(${f.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    function renderGeofencesOnMap(fences) {
        if (!map) return;
        Object.values(geofenceLayers).forEach(({ circle, marker: m }) => {
            if (circle) circle.remove();
            if (m) m.remove();
        });
        geofenceLayers = {};
        fences.forEach(f => {
            const color = f.active ? '#ffc107' : '#6c757d';
            const circle = L.circle([f.latitude, f.longitude], {
                radius: f.radius_m,
                color,
                fillColor: color,
                fillOpacity: 0.12,
                weight: 2
            }).addTo(map);
            const m = L.marker([f.latitude, f.longitude], {
                icon: L.divIcon({
                    className: '',
                    html: `<div style="background:${color};border-radius:50%;width:12px;height:12px;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,.4);"></div>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                })
            }).bindTooltip(escapeHtml(String(f.name)), { permanent: false }).addTo(map);
            geofenceLayers[f.id] = { circle, marker: m };
        });
    }

    window.openAddGeofenceModal = function () {
        document.getElementById('geofenceEditId').value = '';
        document.getElementById('geofenceModalTitle').textContent = 'Add Geofence';
        document.getElementById('geofenceName').value = '';
        document.getElementById('geofenceLat').value = '';
        document.getElementById('geofenceLon').value = '';
        document.getElementById('geofenceRadius').value = 200;
        document.getElementById('geofenceAlertOn').value = 'both';
        document.getElementById('geofenceActive').checked = true;
        new bootstrap.Modal(document.getElementById('geofenceModal')).show();
    };

    window.openEditGeofenceModal = function (id) {
        fetch(`/api/location/geofences?deviceId=${deviceId}`)
            .then(r => r.json())
            .then(data => {
                const f = data.data.find(x => x.id === id);
                if (!f) return;
                document.getElementById('geofenceEditId').value = f.id;
                document.getElementById('geofenceModalTitle').textContent = 'Edit Geofence';
                document.getElementById('geofenceName').value = f.name;
                document.getElementById('geofenceLat').value = f.latitude;
                document.getElementById('geofenceLon').value = f.longitude;
                document.getElementById('geofenceRadius').value = f.radius_m;
                document.getElementById('geofenceAlertOn').value = f.alert_on;
                document.getElementById('geofenceActive').checked = !!f.active;
                new bootstrap.Modal(document.getElementById('geofenceModal')).show();
            });
    };

    window.saveGeofence = function () {
        const id = document.getElementById('geofenceEditId').value;
        const payload = {
            name: document.getElementById('geofenceName').value.trim(),
            latitude: parseFloat(document.getElementById('geofenceLat').value),
            longitude: parseFloat(document.getElementById('geofenceLon').value),
            radius_m: parseFloat(document.getElementById('geofenceRadius').value),
            alert_on: document.getElementById('geofenceAlertOn').value,
            active: document.getElementById('geofenceActive').checked,
            deviceId
        };
        if (!payload.name || isNaN(payload.latitude) || isNaN(payload.longitude) || isNaN(payload.radius_m)) {
            if (typeof showToast === 'function') showToast('Please fill all required fields', 'warning');
            return;
        }
        const url = id ? `/api/location/geofences/${id}` : '/api/location/geofences';
        const method = id ? 'PUT' : 'POST';
        fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    bootstrap.Modal.getInstance(document.getElementById('geofenceModal'))?.hide();
                    loadGeofences();
                    if (typeof showToast === 'function') showToast(id ? 'Geofence updated' : 'Geofence created', 'success');
                } else {
                    if (typeof showToast === 'function') showToast(data.message || 'Error', 'danger');
                }
            })
            .catch(console.error);
    };

    window.deleteGeofence = function (id) {
        if (!confirm('Delete this geofence?')) return;
        fetch(`/api/location/geofences/${id}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    loadGeofences();
                    if (typeof showToast === 'function') showToast('Geofence deleted', 'success');
                }
            })
            .catch(console.error);
    };

    window.centerOnFence = function (lat, lon) {
        if (map) map.setView([lat, lon], 15);
    };

    window.useCurrentLocationForFence = function () {
        if (currentLocation) {
            document.getElementById('geofenceLat').value = currentLocation.latitude;
            document.getElementById('geofenceLon').value = currentLocation.longitude;
        } else if (typeof showToast === 'function') {
            showToast('No GPS fix yet', 'warning');
        }
    };

    // Listen for geofence alerts via Socket.IO
    if (typeof socket !== 'undefined') {
        socket.on('geofence:alert', (data) => {
            const verb = data.event === 'entered' ? 'entered' : 'exited';
            const msg = `Geofence "${data.fenceName}": device ${verb} (${data.distanceMetres}m from center)`;
            if (typeof showToast === 'function') showToast(msg, data.event === 'entered' ? 'warning' : 'info');
        });
    }

    // Load geofences on page load
    loadGeofences();

    // Expose functions globally
    window.refreshLocation = refreshLocation;
    window.centerOnLocation = centerOnLocation;
    window.deleteLocation = deleteLocation;
    window.clearHistory = clearHistory;
    window.exportLocations = exportLocations;
    window.toggleGPS = toggleGPS;
    window.saveGPSConfig = saveGPSConfig;

    console.log('Location.js with Leaflet initialized');
})();
