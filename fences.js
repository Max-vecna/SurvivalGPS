const FENCE_SAVE_KEY = 'gps-survival-perimeters-v1';
let fenceSaveReady = false;
Object.assign(ITEMS_DB, {
    fence: { name: 'Cerca', icon: 'fa-grip-lines-vertical', color: 'text-amber-600', type: 'placeable', desc: 'Marca 12 m de perímetro caminhando. Feche o contorno para proteger a área.', actionText: 'Delimitar caminhando', use: startFenceBuild }
});
CRAFTING_RECIPES.push({ result: 'fence', name: 'Cerca', desc: 'Um trecho de 12 m. O contorno incompleto pode ser retomado depois.', icon: 'fa-grip-lines-vertical', cost: { wood: 2, scrap: 1 } });

function pointOnFenceSegment(p, a, b) { return getDistance(p, roadProjection(p, a, b)) < 0.15; }
function polygonContains(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j], b = points[i];
        if (pointOnFenceSegment(point, a, b)) return true;
        if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
    }
    return inside;
}
function fenceSegmentsIntersect(a, b, c, d) {
    const cross = (p, q, r) => (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
    if (pointOnFenceSegment(a, c, d) || pointOnFenceSegment(b, c, d) || pointOnFenceSegment(c, a, b) || pointOnFenceSegment(d, a, b)) return true;
    return (cross(a, b, c) > 0) !== (cross(a, b, d) > 0) && (cross(c, d, a) > 0) !== (cross(c, d, b) > 0);
}
function zoneContainsPoint(zone, point) {
    return zone.points ? polygonContains(point, zone.points) : getDistance(point, zone.loc) <= zone.radius;
}
function segmentHitsSafeZone(a, b) {
    return ENTITIES.safeZones.some(zone => {
        if (!zone.points) return getDistance(zone.loc, roadProjection(zone.loc, a, b)) <= zone.radius;
        if (polygonContains(a, zone.points) || polygonContains(b, zone.points)) return true;
        return zone.points.some((point, i) => fenceSegmentsIntersect(a, b, point, zone.points[(i + 1) % zone.points.length]));
    });
}
function fenceArea(points) {
    if (points.length < 3) return 0;
    const origin = points[0], scale = Math.cos(origin.lat * Math.PI / 180);
    const xy = p => ({ x: (p.lng - origin.lng) * 111320 * scale, y: (p.lat - origin.lat) * 111320 });
    return Math.abs(points.reduce((sum, p, i) => { const a = xy(p), b = xy(points[(i + 1) % points.length]); return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
}
function fenceClosureAvailable() {
    const points = STATE.fenceBuildPoints;
    return points.length >= CONFIG.fenceMinPerimeterPoints && fenceArea(points) >= 100 && getDistance(points[0], points.at(-1)) <= CONFIG.fenceCloseDistance;
}
function renderFenceBuild() {
    const points = STATE.fenceBuildPoints;
    if (STATE.fenceBuildPolyline) map.removeLayer(STATE.fenceBuildPolyline);
    for (const marker of STATE.fenceBuildMarkers) map.removeLayer(marker);
    STATE.fenceBuildMarkers = [];
    if (points.length) {
        STATE.fenceBuildPolyline = L.polyline(points, { color: 'var(--blue-pen)', weight: 4, dashArray: '6 5', interactive: false }).addTo(map);
        for (const [loc, label] of [[points[0], 'Início'], [points.at(-1), 'Continuar daqui']]) {
            STATE.fenceBuildMarkers.push(L.circleMarker(loc, { radius: 6, color: 'var(--blue-pen)' }).bindTooltip(label).addTo(map));
        }
    } else STATE.fenceBuildPolyline = null;
    const status = document.getElementById('fence-status');
    document.getElementById('fence-build-controls').hidden = !points.length;
    status.textContent = `${STATE.fenceBuildActive ? 'Marcando' : 'Pausado'} · ${STATE.inventory.fence || 0} cercas · ${Math.max(0, points.length - 1) * CONFIG.fenceSegmentLength} m marcados`;
    document.getElementById('fence-resume').textContent = STATE.fenceBuildActive ? 'Pausar' : 'Continuar';
    document.getElementById('fence-finish').disabled = !fenceClosureAvailable();
    saveFenceProgress();
}
function startFenceBuild() {
    if (!STATE.playerLocation || !Number.isFinite(STATE.gpsAccuracy) || STATE.gpsAccuracy > 20) { showToast('Aguarde um GPS com precisão de até 20 m.'); return; }
    if (!(STATE.inventory.fence > 0)) { showToast('Fabrique mais cercas no Craft. Seu trecho continua salvo.'); return; }
    const points = STATE.fenceBuildPoints;
    if (points.length && getDistance(STATE.playerLocation, points.at(-1)) > 8) {
        map.panTo(points.at(-1)); showToast('Volte à ponta marcada para continuar (até 8 m).'); return;
    }
    if (!points.length) points.push(L.latLng(STATE.playerLocation.lat, STATE.playerLocation.lng));
    STATE.fenceBuildActive = true;
    clearPendingSafeZone();
    togglePanel('radar');
    renderFenceBuild(); showToast('Caminhe pelo contorno. Cada cerca cobre 12 m.');
}
function toggleFenceBuild() {
    if (STATE.fenceBuildActive) { STATE.fenceBuildActive = false; renderFenceBuild(); }
    else startFenceBuild();
}
function trackFenceWalk(loc) {
    if (!STATE.fenceBuildActive) return;
    if (!Number.isFinite(STATE.gpsAccuracy) || STATE.gpsAccuracy > 20) {
        STATE.fenceBuildActive = false; renderFenceBuild(); showToast('GPS impreciso. Marcação pausada e salva.'); return;
    }
    const points = STATE.fenceBuildPoints;
    let distance = getDistance(points.at(-1), loc);
    if (distance > 40) { STATE.fenceBuildActive = false; renderFenceBuild(); showToast('GPS mudou muito. Volte à ponta para continuar.'); return; }
    while (distance >= CONFIG.fenceSegmentLength && STATE.inventory.fence > 0) {
        const next = roadInterpolate(points.at(-1), loc, CONFIG.fenceSegmentLength / distance);
        // Fechamento é explícito; o traçado não pode cruzar a própria cerca.
        if (points.slice(0, -2).some((a, i) => fenceSegmentsIntersect(a, points[i + 1], points.at(-1), next))) {
            STATE.fenceBuildActive = false; renderFenceBuild(); showToast('Não cruze a cerca. Perto do início, use Fechar área.'); return;
        }
        points.push(next); STATE.inventory.fence--;
        distance = getDistance(next, loc);
    }
    if (STATE.inventory.fence <= 0) { STATE.fenceBuildActive = false; showToast('Cercas acabaram. Fabrique mais e volte à ponta marcada.'); }
    renderFenceBuild();
    if (document.getElementById('panel-inventory').classList.contains('active')) renderInventory();
}
function finishFenceBuild() {
    const points = STATE.fenceBuildPoints;
    if (!fenceClosureAvailable()) { showToast('Contorne a área e volte a até 18 m do início.'); return; }
    if (!STATE.playerLocation || getDistance(STATE.playerLocation, points.at(-1)) > 8 || !Number.isFinite(STATE.gpsAccuracy) || STATE.gpsAccuracy > 20) { showToast('Volte à ponta marcada com GPS preciso para fechar.'); return; }
    const first = points[0], last = points.at(-1);
    if (points.slice(1, -2).some((a, i) => fenceSegmentsIntersect(last, first, a, points[i + 2]))) { showToast('O fechamento cruza a cerca. Continue o contorno.'); return; }
    // Tolerância de 10 cm evita cobrar um trecho extra por arredondamento geográfico.
    const cost = Math.max(0, Math.ceil((getDistance(first, last) - 0.1) / CONFIG.fenceSegmentLength));
    if ((STATE.inventory.fence || 0) < cost) { STATE.fenceBuildActive = false; renderFenceBuild(); showToast(`Faltam cercas: o fechamento usa ${cost}. Fabrique mais.`); return; }
    STATE.inventory.fence -= cost;
    addFencedZone(points);
    STATE.fenceBuildActive = false; STATE.fenceBuildPoints = [];
    renderFenceBuild(); renderInventory(); renderSurvivalStatus(); showToast('Contorno fechado! Esta área agora é segura.');
}
function addFencedZone(points) {
    const polygon = L.polygon(points, { color: '#15803d', weight: 3, fillColor: '#86efac', fillOpacity: 0.20, interactive: false }).addTo(map);
    ENTITIES.safeZones.push({ points: points.map(p => L.latLng(p.lat, p.lng)), polygon });
}
function saveFenceProgress() {
    if (fenceSaveReady) queueGameSave();
}
function restoreFenceProgress(saved = null) {
    try {
        const valid = p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
        if (saved) {
            for (const [key, count] of Object.entries(saved.inventory || {})) if (ITEMS_DB[key] && Number.isInteger(count) && count >= 0) STATE.inventory[key] = count;
            if (Array.isArray(saved.draft) && saved.draft.every(valid)) STATE.fenceBuildPoints = saved.draft.map(p => L.latLng(p.lat, p.lng));
            for (const zone of saved.zones || []) {
                if (Array.isArray(zone.points) && zone.points.length >= 3 && zone.points.every(valid)) addFencedZone(zone.points);
                else if (valid(zone.loc) && Number.isFinite(zone.radius) && zone.radius > 0) {
                    const loc = L.latLng(zone.loc.lat, zone.loc.lng), radius = zone.radius;
                    const circle = L.circle(loc, { radius, color: '#15803d', weight: 3, fillColor: '#86efac', fillOpacity: 0.20, interactive: false }).addTo(map);
                    ENTITIES.safeZones.push({ loc, radius, circle });
                }
            }
        }
    } catch (error) { console.warn('Não foi possível restaurar o perímetro', error); }
    fenceSaveReady = true; renderFenceBuild();
}

