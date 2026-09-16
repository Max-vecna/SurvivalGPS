const GAME_DB_NAME = 'gps-survival';
const GAME_STORE = { db: null, ready: false, resetting: false, timer: null, lastSaved: null };
const BOOT = { dataReady: false, locationReady: false, finished: false, error: '', gpsWatch: null };
const SAVED_STATE_KEYS = ['health', 'hunger', 'thirst', 'fatigue', 'isDead', 'resourceRadarBattery', 'zombieRadarBattery', 'resourceRadarEnabled', 'zombieRadarEnabled', 'resourceRadarLevel', 'zombieRadarLevel', 'repellentUntil', 'lastHordeCheck', 'playerLevel', 'playerXp', 'backpackLevel', 'safeStorage'];
function openGameDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(GAME_DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('game');
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Feche outras abas do jogo para abrir os dados.'));
    });
}
function gameDBTransaction(mode, action) {
    return new Promise((resolve, reject) => {
        const tx = GAME_STORE.db.transaction('game', mode);
        const request = action(tx.objectStore('game'));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Salvamento interrompido'));
    });
}
function snapshotGame() {
    return {
        version: 3, savedAt: Date.now(),
        state: Object.fromEntries(SAVED_STATE_KEYS.map(key => [key, STATE[key]])),
        inventory: { ...STATE.inventory }, playerLocation: STATE.playerLocation,
        view: { center: map.getCenter(), zoom: map.getZoom() },
        draft: STATE.fenceBuildPoints,
        zones: ENTITIES.safeZones.map(z => z.points ? { points: z.points } : { loc: z.loc, radius: z.radius }),
        traps: ENTITIES.traps.map(t => ({ id: t.id, loc: t.loc, radius: t.radius, active: t.active !== false, kills: t.kills || 0 })),
        resources: ENTITIES.resources.map(r => ({ id: r.id, type: r.type, loc: r.loc })),
        zombies: ENTITIES.zombies.map(z => ({ id: z.id, loc: z.loc, road: z.road, hordeId: z.hordeId, lastAttack: z.lastAttack, chasingUntil: z.chasingUntil, nextChaseCheck: z.nextChaseCheck, returnToRoad: z.returnToRoad }))
    };
}
function queueGameSave() {
    if (!GAME_STORE.ready || GAME_STORE.resetting) return;
    clearTimeout(GAME_STORE.timer);
    GAME_STORE.timer = setTimeout(() => saveGameNow().catch(reportSaveError), 150);
}
function reportSaveError(error) {
    document.getElementById('save-status').textContent = 'Falha ao salvar. Libere espaço e tente novamente.';
    console.warn('Salvamento indisponível', error);
}
async function saveGameNow() {
    if (!GAME_STORE.ready || GAME_STORE.resetting) return;
    clearTimeout(GAME_STORE.timer);
    const snapshot = snapshotGame();
    await gameDBTransaction('readwrite', store => {
        store.put({ elements: ROAD_WORLD.rawElements, center: ROAD_WORLD.center }, 'world');
        return store.put(snapshot, 'save');
    });
    GAME_STORE.lastSaved = snapshot.savedAt;
    document.getElementById('save-status').textContent = `Salvo neste navegador às ${new Date(snapshot.savedAt).toLocaleTimeString('pt-BR')}`;
}
async function saveWorldCache() {
    if (!GAME_STORE.ready || GAME_STORE.resetting) return;
    try { await saveGameNow(); }
    catch (error) { reportSaveError(error); }
}
function validGameLocation(p) { return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180; }
function restoreGameSnapshot(saved, world) {
    if (!saved) { restoreFenceProgress(null); return; }
    restoreFenceProgress(saved);
    for (const key of SAVED_STATE_KEYS) {
        const value = saved.state?.[key];
        if (typeof value === typeof STATE[key] && (typeof value !== 'number' || Number.isFinite(value))) STATE[key] = value;
    }
    for (const key of ['health', 'hunger', 'thirst', 'fatigue', 'resourceRadarBattery', 'zombieRadarBattery']) STATE[key] = Math.max(0, Math.min(100, STATE[key]));
    STATE.resting = false; STATE.fenceBuildActive = false; STATE.gameStarted = false;
    for (const type of ['resource', 'zombie']) {
        const level = RADAR_LEVELS[type][STATE[`${type}RadarLevel`]] || RADAR_LEVELS[type][1];
        STATE[`${type}RadarLevel`] = level.level; CONFIG[`${type}RadarRadius`] = level.radius;
    }
    if (validGameLocation(saved.playerLocation)) STATE.playerLocation = L.latLng(saved.playerLocation.lat, saved.playerLocation.lng);
    if (world?.elements?.length && validGameLocation(world.center)) {
        Object.assign(ROAD_WORLD, buildRoadWorld(world.elements), { rawElements: world.elements, center: L.latLng(world.center.lat, world.center.lng) });
    }
    for (const resource of saved.resources || []) if (ITEMS_DB[resource.type] && validGameLocation(resource.loc)) spawnResource({ ...resource, loc: L.latLng(resource.loc.lat, resource.loc.lng) });
    for (const zombie of saved.zombies || []) {
        if (!validGameLocation(zombie.loc) || !ROAD_WORLD.nodes.has(zombie.road?.from) || !ROAD_WORLD.nodes.has(zombie.road?.to)) continue;
        const count = ENTITIES.zombies.length;
        spawnZombie({ loc: L.latLng(zombie.loc.lat, zombie.loc.lng), ...zombie.road }, zombie.hordeId);
        if (ENTITIES.zombies.length > count) Object.assign(ENTITIES.zombies.at(-1), { id: zombie.id, lastAttack: zombie.lastAttack || 0, chasingUntil: 0, nextChaseCheck: 0, returnToRoad: validGameLocation(zombie.returnToRoad) ? L.latLng(zombie.returnToRoad.lat, zombie.returnToRoad.lng) : null });
    }
    ejectZombiesFromSafeZones();
    STATE.playerLevel = Math.max(1, Math.floor(Number(STATE.playerLevel) || 1));
    STATE.playerXp = Math.max(0, Math.floor(Number(STATE.playerXp) || 0));
    STATE.backpackLevel = Math.max(1, Math.min(BACKPACK_LEVELS.length - 1, Math.floor(Number(STATE.backpackLevel) || 1)));
    if (!STATE.safeStorage || typeof STATE.safeStorage !== 'object' || Array.isArray(STATE.safeStorage)) STATE.safeStorage = {};

    for (const trap of saved.traps || []) if (validGameLocation(trap.loc)) {
        createTrapEntity(L.latLng(trap.loc.lat, trap.loc.lng), trap);
    }
    if (validGameLocation(saved.view?.center)) map.setView(saved.view.center, Math.max(3, Math.min(19, saved.view.zoom || 17)));
    GAME_STORE.lastSaved = saved.savedAt;
}
function showTipTopic(topic, button) {
    document.querySelectorAll('#panel-tips [data-tip-topic]').forEach(section => { section.hidden = section.dataset.tipTopic !== topic; });
    document.querySelectorAll('#tips-menu button').forEach(btn => btn.setAttribute('aria-pressed', String(btn === button)));
    if (topic === 'resources') renderResourceLegend();
}
function hasLoadedMapTiles() {
    const tiles = Object.values(mapTiles._tiles || {}).filter(tile => tile.current);
    return tiles.length > 0 && !mapTiles.isLoading() && tiles.every(tile => tile.el.complete && tile.el.naturalWidth > 0);
}
function updateSplash() {
    if (BOOT.finished) return;

    const status = document.getElementById('splash-status');
    const retry = document.getElementById('splash-retry');
    const savedLocation = document.getElementById('splash-saved-location');

    // O botão de tentar novamente só aparece quando existe um erro real.
    if (retry) retry.hidden = true;

    if (BOOT.error) {
        status.textContent = BOOT.error;
        if (retry) retry.hidden = false;
        if (savedLocation) savedLocation.hidden = !STATE.playerLocation;
        return;
    }

    if (!BOOT.dataReady) {
        status.textContent = 'Carregando seu progresso…';
        return;
    }

    if (!BOOT.locationReady) {
        status.textContent = 'Aguardando GPS. Permita o acesso à localização para carregar sua região.';
        if (savedLocation) savedLocation.hidden = !STATE.playerLocation;
        return;
    }

    const roadsReady =
        ROAD_WORLD.center &&
        getDistance(ROAD_WORLD.center, STATE.playerLocation) < CONFIG.worldRefreshDistance &&
        ROAD_WORLD.segments.length;

    if (!roadsReady) {
        if (ROAD_WORLD.loading) {
            status.textContent = 'Carregando ruas e locais próximos…';
        } else {
            status.textContent = 'Não foi possível carregar as ruas.';
            if (retry) retry.hidden = false;
        }
        return;
    }

    if (!hasLoadedMapTiles()) {
        status.textContent = 'Carregando imagens do mapa…';
        return;
    }

    BOOT.finished = true;
    document.getElementById('splash-screen').hidden = true;
    document.body.classList.remove('booting');
    document.getElementById('app-container').inert = false;

    updateStatsUI();
    renderSurvivalStatus();
    updateRadarVisibility();
    renderGpsStatus();
    syncInteractionState();

    if (STATE.isDead) document.getElementById('game-over').classList.replace('hidden', 'flex');
    else startGame();

    queueGameSave();
}
function useSavedLocation() {
    if (!STATE.playerLocation || !BOOT.dataReady) return;
    applyLocation(STATE.playerLocation);
}
function retryGameLoading() {
    const retry = document.getElementById('splash-retry');
    if (retry) retry.hidden = true;

    if (!BOOT.dataReady) {
        location.reload();
        return;
    }

    BOOT.error = '';
    ROAD_WORLD.attempted = 0;
    mapTiles.redraw();

    if (BOOT.locationReady) ensureRoadWorld();
    else initGPS();

    updateSplash();
}
async function initializeGame() {
    document.getElementById('app-container').inert = true;
    try {
        GAME_STORE.db = await openGameDatabase();
        let saved = await gameDBTransaction('readonly', store => store.get('save'));
        const world = await gameDBTransaction('readonly', store => store.get('world'));
        let migrated = false;
        if (!saved) {
            const legacy = localStorage.getItem(FENCE_SAVE_KEY);
            if (legacy) { saved = JSON.parse(legacy); migrated = true; }
        }
        restoreGameSnapshot(saved, world);
        GAME_STORE.ready = true; BOOT.dataReady = true;
        await saveGameNow();
        if (migrated) localStorage.removeItem(FENCE_SAVE_KEY);
        updateStatsUI(); renderSurvivalStatus(); renderPlayerProgression(); renderGpsStatus(); updateSafeZoneContextMenu(); syncInteractionState();
        initGPS(); updateSplash();
    } catch (error) {
        BOOT.error = 'Não foi possível abrir os dados salvos. Verifique o armazenamento do navegador e tente novamente.';
        console.warn(error); updateSplash();
    }
}
function requestGameReset() { document.getElementById('reset-confirmation').hidden = false; document.getElementById('confirm-reset-button').focus(); }
function cancelGameReset() { document.getElementById('reset-confirmation').hidden = true; }
async function resetSavedGame(reload = true) {
    if (GAME_STORE.resetting || !GAME_STORE.db) return;
    GAME_STORE.resetting = true; clearTimeout(GAME_STORE.timer); clearInterval(STATE.gameLoopTimer);
    if (BOOT.gpsWatch !== null) navigator.geolocation.clearWatch(BOOT.gpsWatch);
    try {
        await gameDBTransaction('readwrite', store => store.clear());
        localStorage.removeItem(FENCE_SAVE_KEY);
        if (reload) location.reload();
    } catch (error) {
        GAME_STORE.resetting = false; reportSaveError(error);
        if (STATE.gameStarted && !STATE.isDead) STATE.gameLoopTimer = setInterval(gameLoop, CONFIG.updateInterval);
    }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveGameNow().catch(reportSaveError); });
window.addEventListener('pagehide', () => { saveGameNow().catch(reportSaveError); });
setInterval(() => { if (BOOT.dataReady && !BOOT.finished) updateSplash(); }, 500);
setInterval(() => { if (BOOT.finished) saveGameNow().catch(reportSaveError); }, 3000);
